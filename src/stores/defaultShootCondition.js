;({camera}) => {
	const alerts = []

	if (!camera.tethr) {
		alerts.push('Camera must be connected')
		return alerts
	}

	// Lock the exposure so frames don't drift: manual mode, and no *settable*
	// exposure / white-balance control left on "auto" (a control the camera won't
	// let you set — e.g. on a webcam — is left alone).
	if (camera.exposureMode.writable && camera.exposureMode.value !== 'M') {
		alerts.push('Exposure mode must be set to M')
	}

	for (const name of ['aperture', 'shutterSpeed', 'iso', 'whiteBalance']) {
		const config = camera[name]
		if (config.writable && config.value === 'auto') {
			alerts.push(`${name} must not be set to auto`)
		}
	}

	return alerts
}
