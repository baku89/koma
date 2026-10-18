/**
 * Lens calibration: what the camera's normalised focus position means in
 * millimetres, and what the lens's field of view is at each focus setting.
 *
 * A macro lens focused close is nothing like its nameplate: the pinhole
 * focal length grows with the magnification (f′·(1 + m)) while the real
 * focal length f′ shrinks (internal focusing), and the entrance pupil moves
 * along the axis. All of that depends on the focus setting, so koma keeps a
 * table measured on the set, one row per focus setting:
 *
 *   focus     the normalised focus position tethr reports (0 = nearest)
 *   distance  where the lens is focused: mm from the head's rotation centre
 *             to the in-focus plane, along the optical axis
 *   focal     the pinhole focal length (mm) — Houdini's `focal` with an
 *             `aperture` of the sensor width
 *   pupil     the entrance pupil, mm in front of the rotation centre
 *
 * Each row comes from the frame width measured at that focus setting. The
 * half width h of the frame at a target D mm from the measurement origin is
 * h = (sensorWidth / 2) · (D − Δ) / focal with Δ the pupil's distance from
 * that origin, so two targets at the same focus setting (focused on the
 * first; the second just farther, blurred but measurable) give both focal
 * and Δ as the slope and intercept of h against D. A single target can only
 * give focal for an assumed Δ.
 *
 * The measurement origin is wherever the user measures distances from (the
 * tilt axis, the lens front, …); `originOffset` is how far in front of the
 * rotation centre that is, so stored rows are all about the rotation centre.
 */

/** How the camera's focus is driven (projectData.ts `focus.mode`). */
export const FOCUS_MODES = ['normalized', 'distance', 'target'] as const
export type FocusMode = (typeof FOCUS_MODES)[number]
export const FOCUS_MODE_LABELS: Record<FocusMode, string> = {
	normalized: 'Normalized',
	distance: 'Distance (mm)',
	target: 'Target',
}

/** Slider range of the focus-distance inputs (mm from the rotation centre). */
export const FOCUS_MM_RANGE: [number, number] = [0, 900]

export interface LensSample {
	/** Normalised focus position (tethr's `focusDistance`, 0 = nearest). */
	focus: number
	/** Target distance from the measurement origin along the optical axis (mm). */
	distance: number
	/** Half the frame width at the target: centre to the left edge (mm). */
	halfWidth: number
	/**
	 * The lens was focused on this target (so the row also says where the
	 * focus setting focuses). A farther, unfocused reading at the same
	 * setting is `false`.
	 */
	inFocus: boolean
}

export interface LensCalibration {
	/** Sensor width (mm). Sigma fp: 35.9. */
	sensorWidth: number
	/**
	 * Distances were measured from the entrance pupil itself (the usual
	 * way: the pupil is where the frame's edges converge). Then a single
	 * target per setting gives the focal directly (Δ = 0), and the pupil's
	 * place is the calibration's pupil offset, not something fitted here.
	 */
	originIsPupil: boolean
	/**
	 * Otherwise: where measured distances start, mm in front of the head's
	 * rotation centre along the optical axis (0 = the centre itself).
	 */
	originOffset: number
	/**
	 * How much farther the second (unfocused) target of a 4-column sheet row
	 * is than the first (mm) — the Y move made between the two readings.
	 */
	farStep: number
	samples: LensSample[]
}

export const DEFAULT_LENS_CALIBRATION: LensCalibration = {
	sensorWidth: 35.9,
	originIsPupil: true,
	originOffset: 0,
	farStep: 100,
	samples: [],
}

export interface LensRow {
	focus: number
	/** In-focus plane, mm from the rotation centre. */
	distance: number
	/** Pinhole focal length (mm). */
	focal: number
	/** Entrance pupil, mm in front of the rotation centre. */
	pupil: number
	/**
	 * Where the pupil came from: measured from it (`pupil`), fitted from two
	 * targets, or assumed (borrowed / the calibration's).
	 */
	pupilSource: 'pupil' | 'fitted' | 'assumed'
}

/** Rows sorted by focus, focus strictly increasing. */
export type LensTable = LensRow[]

/**
 * Fit the table from the samples. `pupilOffset` is the entrance pupil, mm
 * in front of the rotation centre (the calibration's). With
 * `originIsPupil` every distance is from the pupil, so Δ = 0 and a single
 * target per setting is enough. Otherwise a setting with two or more targets
 * fits its own pupil, and one with a single target borrows the pupil
 * interpolated (by focus) from the fitted settings, or `pupilOffset` when
 * none was fitted. Settings without an in-focus reading are skipped.
 */
export function fitLensTable(cal: LensCalibration, pupilOffset = 0): LensTable {
	const half = cal.sensorWidth / 2
	// Where the sheet's distances start, mm in front of the rotation centre.
	const origin = cal.originIsPupil ? pupilOffset : cal.originOffset
	const groups = new Map<number, LensSample[]>()
	for (const s of cal.samples) {
		if (![s.focus, s.distance, s.halfWidth].every(Number.isFinite)) continue
		if (s.halfWidth <= 0) continue
		const g = groups.get(s.focus) ?? []
		g.push(s)
		groups.set(s.focus, g)
	}
	// Pass 1: settings with two targets — focal and pupil from the line fit.
	const fitted: LensRow[] = []
	const single: {focus: number; inFocus: LensSample}[] = []
	for (const [focus, samples] of groups) {
		const inFocus = samples.find(s => s.inFocus)
		if (!inFocus) continue
		const distinct = new Map<number, number>()
		for (const s of samples) distinct.set(s.distance, s.halfWidth)
		if (distinct.size < 2 || cal.originIsPupil) {
			single.push({focus, inFocus})
			continue
		}
		{
			// Least squares h = a·D + b over the targets at this setting.
			const pts = [...distinct].map(([d, h]) => ({d, h}))
			const n = pts.length
			const md = pts.reduce((s, p) => s + p.d, 0) / n
			const mh = pts.reduce((s, p) => s + p.h, 0) / n
			const sxx = pts.reduce((s, p) => s + (p.d - md) ** 2, 0)
			const sxy = pts.reduce((s, p) => s + (p.d - md) * (p.h - mh), 0)
			const a = sxy / sxx
			const b = mh - a * md
			if (!(a > 0)) continue
			const focal = half / a
			const pupil = -b / a + origin
			if (!(focal > 0) || !Number.isFinite(pupil)) continue
			fitted.push({
				focus,
				distance: inFocus.distance + origin,
				focal,
				pupil,
				pupilSource: 'fitted',
			})
		}
	}
	fitted.sort((a, b) => a.focus - b.focus)
	// Pass 2: single-target settings — focal for a borrowed pupil.
	const rows = [...fitted]
	for (const {focus, inFocus} of single) {
		const pupil = cal.originIsPupil
			? pupilOffset
			: fitted.length
				? interp(fitted, 'focus', focus, 'pupil')
				: pupilOffset
		const focal = (half * (inFocus.distance + origin - pupil)) / inFocus.halfWidth
		if (!(focal > 0)) continue
		rows.push({
			focus,
			distance: inFocus.distance + origin,
			focal,
			pupil,
			pupilSource: cal.originIsPupil ? 'pupil' : 'assumed',
		})
	}
	return rows.sort((a, b) => a.focus - b.focus)
}

/** Piecewise-linear value of `key` at `x` along `by`; clamped at the ends. */
function interp(table: LensTable, by: 'focus' | 'distance', x: number, key: keyof LensRow) {
	const v = (r: LensRow) => r[key] as number
	if (table.length === 0) return NaN
	if (x <= table[0][by]) return v(table[0])
	const last = table[table.length - 1]
	if (x >= last[by]) return v(last)
	for (let i = 1; i < table.length; i++) {
		const a = table[i - 1]
		const b = table[i]
		if (x <= b[by]) {
			const t = b[by] === a[by] ? 0 : (x - a[by]) / (b[by] - a[by])
			return v(a) + (v(b) - v(a)) * t
		}
	}
	return v(last)
}

/** The lens at a normalised focus position (clamped to the table's range). */
export function lensAtFocus(table: LensTable, focus: number) {
	return {
		distance: interp(table, 'focus', focus, 'distance'),
		focal: interp(table, 'focus', focus, 'focal'),
		pupil: interp(table, 'focus', focus, 'pupil'),
	}
}

/**
 * The normalised focus position that focuses `distance` mm from the
 * rotation centre, clamped to the table's range. Needs `distance` to
 * increase with focus (it does on a real lens; the table is checked).
 */
export function focusForDistance(table: LensTable, distance: number): number {
	const t = table.filter((r, i) => i === 0 || r.distance > table[i - 1].distance)
	return interp(t, 'distance', distance, 'focus')
}

/** Distance range (mm from the rotation centre) the table covers. */
export function lensDistanceRange(table: LensTable): [number, number] | null {
	if (table.length === 0) return null
	return [table[0].distance, table[table.length - 1].distance]
}

/**
 * Parse a sheet pasted as TSV / CSV. Per row:
 *   distance  focus  halfWidth                 — one target, in focus
 *   distance  focus  halfWidth  farHalfWidth   — plus a second target `farStep` farther
 *   distance  focus  halfWidth  farDistance  farHalfWidth
 * Header lines and anything without 3 numbers are skipped.
 */
export function parseLensSheet(text: string, farStep: number): LensSample[] {
	const out: LensSample[] = []
	for (const line of text.split(/\r?\n/)) {
		const cells = line.split(/[\t,;]|\s{2,}/).map(c => c.trim())
		const nums = cells.map(Number)
		if (cells.length < 3 || nums.slice(0, 3).some(n => !Number.isFinite(n) || cells[0] === '')) {
			continue
		}
		const [distance, focus, halfWidth] = nums
		out.push({focus, distance, halfWidth, inFocus: true})
		if (cells.length >= 5 && Number.isFinite(nums[3]) && Number.isFinite(nums[4])) {
			out.push({focus, distance: nums[3], halfWidth: nums[4], inFocus: false})
		} else if (cells.length >= 4 && Number.isFinite(nums[3])) {
			out.push({focus, distance: distance + farStep, halfWidth: nums[3], inFocus: false})
		}
	}
	return out
}

/**
 * What koma writes for Houdini (`calibration.json` in the project folder,
 * ADDSUB.md §13.1): the table in mm about the head's rotation centre.
 */
export function lensCalibrationJson(cal: LensCalibration, table: LensTable) {
	return {
		version: 1,
		sensor: {width: cal.sensorWidth, height: (cal.sensorWidth * 2) / 3},
		lens: {
			distancesFromPupil: cal.originIsPupil,
			/** Rows: focus (0–1), distance / focal / pupil (mm, about the rotation centre). */
			table: table.map(({focus, distance, focal, pupil}) => ({
				focus: round(focus, 4),
				distance: round(distance, 2),
				focal: round(focal, 3),
				pupil: round(pupil, 2),
			})),
		},
	}
}

function round(x: number, digits: number) {
	const k = 10 ** digits
	return Math.round(x * k) / k
}

/**
 * Distance along the camera's optical axis from the head's rotation centre
 * to a point: what the lens should be focused at to have that point sharp.
 * `forward` is the axis direction (unit), `centre` the rotation centre.
 */
export function distanceAlongAxis(
	centre: readonly [number, number, number],
	forward: readonly [number, number, number],
	point: readonly [number, number, number]
): number {
	return (
		(point[0] - centre[0]) * forward[0] +
		(point[1] - centre[1]) * forward[1] +
		(point[2] - centre[2]) * forward[2]
	)
}
