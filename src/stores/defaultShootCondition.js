;({camera, aux}) => {
	const alerts = []

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

		if (camera.destinationToSave.value !== 'camera,pc') {
			alerts.push('Destination to save must be set to Camera, PC')
		}
	} else {
		alerts.push('Camera must be connected')
	}

	if (aux.tracker.enabled) {
		if (vec3.len(aux.tracker.velocity) >= 0.05) {
			alerts.push('Tracker must be stable')
		}
	} else {
		alerts.push('Tracker must be connected')
	}

	return alerts
}
