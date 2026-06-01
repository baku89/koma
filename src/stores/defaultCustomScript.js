;(async ({cnc, viewport, readProjectFile}) => {
	// Runnable any time from the Command Palette ("Run Custom Script").
	// Receives the same context as the pre-shoot script:
	//   {cnc, project, viewport, camera, tracker, sleep, readProjectFile, queueMicrotask}
	//
	// This default sends the current frame's light-rod G-code to the CNC — handy
	// for previewing / jogging the rod for a frame without taking a photo.

	if (!cnc.connected) {
		throw new Error('CNC is not connected')
	}

	const frame = viewport.currentFrame
	const filename = `lightrod.${String(frame).padStart(4, '0')}.gcode`
	const gcode = await readProjectFile(filename)

	// Send line by line and wait for each `ok` (no shutter timing to race here).
	for (const line of gcode.split(/\r?\n/)) {
		const l = line.trim()
		if (l && !l.startsWith(';')) await cnc.send(l)
	}
})
