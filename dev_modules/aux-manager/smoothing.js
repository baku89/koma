// One Euro Filter — adaptive low-pass for noisy interactive signals.
// https://gery.casiez.net/1euro/
//
// It smooths heavily when the signal is (nearly) still and backs off as the
// signal moves, so the tracker stops trembling at rest without smearing real
// camera moves. Tuning:
//   - minCutoff  : lower  = more smoothing at rest (more "プルプル" removed)
//   - beta       : higher = less lag while moving (more responsive)

class LowPass {
	constructor() {
		this.hasLast = false
		this.last = 0
	}

	filter(value, alpha) {
		if (!this.hasLast) {
			this.hasLast = true
			this.last = value
			return value
		}
		this.last = alpha * value + (1 - alpha) * this.last
		return this.last
	}
}

class OneEuro {
	constructor(minCutoff, beta, dCutoff = 1.0) {
		this.minCutoff = minCutoff
		this.beta = beta
		this.dCutoff = dCutoff
		this.xPrev = null
		this.tPrev = null
		this.xLp = new LowPass()
		this.dxLp = new LowPass()
	}

	static alpha(cutoff, dt) {
		const tau = 1 / (2 * Math.PI * cutoff)
		return 1 / (1 + tau / dt)
	}

	filter(x, t) {
		if (this.tPrev === null) {
			this.tPrev = t
			this.xPrev = x
			return this.xLp.filter(x, 1)
		}

		let dt = t - this.tPrev
		if (!(dt > 0)) dt = 1e-3
		this.tPrev = t

		const dx = (x - this.xPrev) / dt
		this.xPrev = x

		const edx = this.dxLp.filter(dx, OneEuro.alpha(this.dCutoff, dt))
		const cutoff = this.minCutoff + this.beta * Math.abs(edx)
		return this.xLp.filter(x, OneEuro.alpha(cutoff, dt))
	}
}

// Component-wise One Euro for a fixed-length vector.
class VectorOneEuro {
	constructor(size, minCutoff, beta, dCutoff) {
		this.filters = Array.from(
			{length: size},
			() => new OneEuro(minCutoff, beta, dCutoff)
		)
	}

	filter(vec, t) {
		return this.filters.map((f, i) => f.filter(vec[i], t))
	}
}

// One Euro for a quaternion [x, y, z, w]. Aligns hemispheres (q and -q are the
// same rotation) before filtering and renormalizes the result.
class QuaternionOneEuro {
	constructor(minCutoff, beta, dCutoff) {
		this.vec = new VectorOneEuro(4, minCutoff, beta, dCutoff)
		this.prev = null
	}

	filter(q, t) {
		// Flip sign so consecutive quaternions stay on the same hemisphere,
		// otherwise the component-wise filter would interpolate the long way.
		if (this.prev) {
			const dot =
				q[0] * this.prev[0] +
				q[1] * this.prev[1] +
				q[2] * this.prev[2] +
				q[3] * this.prev[3]
			if (dot < 0) q = [-q[0], -q[1], -q[2], -q[3]]
		}

		const f = this.vec.filter(q, t)

		const len = Math.hypot(f[0], f[1], f[2], f[3]) || 1
		const out = [f[0] / len, f[1] / len, f[2] / len, f[3] / len]

		this.prev = out
		return out
	}
}

// Outlier / spike gate for tracker poses.
//
// One Euro alone CANNOT reject spikes: a big jump raises its derivative term,
// which RAISES the cutoff and makes it follow the jump almost unfiltered. So a
// single bad solve from libsurvive (occlusion, IR reflection, single-base-
// station ambiguity) shows up as a visible "ガクッ". This gate runs *before* the
// filter and drops any sample whose implied linear/angular speed from the last
// accepted pose is physically impossible.
//
// To avoid getting stuck if the tracker legitimately teleports (recalibration,
// a genuinely fast move), it only rejects up to `maxReject` samples in a row,
// then force-resyncs to the new pose. Because the last-accepted timestamp is
// not advanced while rejecting, dt keeps growing and the speed estimate decays,
// so a real new position is re-accepted on its own well before the hard cap.
class PoseGate {
	constructor({maxLinearSpeed, maxAngularSpeed, maxReject}) {
		this.maxLinearSpeed = maxLinearSpeed // m/s
		this.maxAngularSpeed = maxAngularSpeed // rad/s
		this.maxReject = maxReject
		this.lastPos = null
		this.lastRot = null // [x, y, z, w]
		this.lastT = null
		this.rejectCount = 0
		this.rejectedTotal = 0
	}

	// position: [x,y,z] (m), rotation: [x,y,z,w], t: seconds.
	// Returns true to accept the sample, false to drop it.
	accept(position, rotation, t) {
		if (this.lastPos === null) {
			this.#commit(position, rotation, t)
			return true
		}

		let dt = t - this.lastT
		if (!(dt > 0)) dt = 1e-3

		const dp = Math.hypot(
			position[0] - this.lastPos[0],
			position[1] - this.lastPos[1],
			position[2] - this.lastPos[2]
		)
		const linSpeed = dp / dt

		// Angle between quaternions (hemisphere-agnostic).
		let dot =
			rotation[0] * this.lastRot[0] +
			rotation[1] * this.lastRot[1] +
			rotation[2] * this.lastRot[2] +
			rotation[3] * this.lastRot[3]
		dot = Math.min(1, Math.abs(dot))
		const angle = 2 * Math.acos(dot) // rad
		const angSpeed = angle / dt

		const outlier =
			linSpeed > this.maxLinearSpeed || angSpeed > this.maxAngularSpeed

		if (outlier && this.rejectCount < this.maxReject) {
			this.rejectCount++
			this.rejectedTotal++
			return false
		}

		this.rejectCount = 0
		this.#commit(position, rotation, t)
		return true
	}

	#commit(position, rotation, t) {
		this.lastPos = position
		this.lastRot = rotation
		this.lastT = t
	}
}

module.exports = {OneEuro, VectorOneEuro, QuaternionOneEuro, PoseGate}
