;({camera, tracker, viewport, project}) => {
	const alerts = []

	const prevShot = project.shot(viewport.currentFrame - 1, 0)

	if (camera.tethr) {
		if (camera.exposureMode.value !== 'M') {
			alerts.push('Exposure mode must be set to M')
		}

		if (typeof camera.iso.value !== 'number') {
			alerts.push('ISO must be set to a number')
		}

		if (camera.whiteBalance.value !== 'fluorescent') {
			alerts.push('White balance must be set to Fluorescent')
		}

		if (camera.colorMode.value !== 'off') {
			alerts.push('Color mode must be set to Off')
		}

		if (camera.destinationToSave.value !== 'camera,pc') {
			alerts.push('Destination to save must be set to Camera, PC')
		}

		if (!['1/25', '1/50'].includes(camera.shutterSpeed.value)) {
			alerts.push(
				'Shutter speed must be set to times of 1/50 to avoid flickering'
			)
		}

		if (viewport.currentLayer > 0) {
			const baseShot = project.shot(viewport.currentFrame, 0)

			const cameraConfig = baseShot.cameraConfigs ?? {}

			for (const prop of ['iso', 'shutterSpeed', 'aperture']) {
				if (cameraConfig[prop] !== camera[prop].value) {
					alerts.push(`Camera ${prop} must be set to ${cameraConfig[prop]}`)
				}
			}
		}
	} else {
		alerts.push('Camera must be connected')
	}

	if (tracker.enabled) {
		if (vec3.len(tracker.velocity) >= 0.05) {
			alerts.push('Tracker must be stable')
		}

		const prevPos = prevShot?.tracker.position
		if (prevPos && vec3.dist(tracker.position, prevPos) >= 0.1) {
			alerts.push(
				'The camera movement must be less than 10cm, got ' +
					(vec3.dist(tracker.position, prevPos) * 100).toFixed(1) +
					'cm'
			)
		}
	} else {
		alerts.push('Tracker must be connected')
	}

	return alerts
}
