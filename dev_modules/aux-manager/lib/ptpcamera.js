/**
 * macOS spawns `ptpcamera` (`ptpcamerad` since macOS 26) whenever a PTP
 * device appears and it claims the camera's interface, so WebUSB's
 * claimInterface fails ("Unable to claim interface"). There is no API to
 * detach it; it gets killed on a short interval instead (pkill exits 1 when
 * there was nothing to kill).
 */
import {exec} from 'node:child_process'

export function startPtpKiller({intervalMs = 250, onKill, platform = process.platform} = {}) {
	const status = {active: false, kills: 0, lastKillAt: null}
	if (platform !== 'darwin') return {status, stop() {}}
	status.active = true
	let stopped = false
	let timer = null
	const tick = () => {
		if (stopped) return
		exec("pkill -9 -x 'ptpcamera|ptpcamerad'", err => {
			if (stopped) return
			if (!err) {
				status.kills += 1
				status.lastKillAt = Date.now()
				onKill?.(status)
			}
			timer = setTimeout(tick, intervalMs)
		})
	}
	tick()
	return {
		status,
		stop() {
			stopped = true
			status.active = false
			clearTimeout(timer)
		},
	}
}
