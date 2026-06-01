;(async ({cnc, viewport, readProjectFile, queueMicrotask}) => {
	// Runs right before the shutter opens. The Promise this returns is awaited;
	// if it rejects, the shot fails. If it resolves, capture starts immediately
	// and any CNC motion kept running keeps drawing into the exposure (the LED
	// rod painting a light streak).

	// Fail the shot if the rod controller isn't connected.
	if (!cnc.connected) {
		throw new Error('CNC is not connected')
	}

	// Load this frame's G-code from the current project folder, e.g.
	// `lightrod.0007.gcode` for frame 7. Rejects (→ shot fails) if missing.
	const frame = viewport.currentFrame
	const filename = `lightrod.${String(frame).padStart(4, '0')}.gcode`
	const gcode = await readProjectFile(filename)

	// Resolve right before sending: returning opens the shutter, then the
	// G-code goes out so the rod travels while the exposure is already running.
	// `cnc.send` takes one line at a time (it waits for Grbl's `ok` per line),
	// so feed the program line by line — gcnc queues them and runs them in order.
	queueMicrotask(() => {
		for (const line of gcode.split(/\r?\n/)) {
			const l = line.trim()
			if (l && !l.startsWith(';')) cnc.send(l)
		}
	})
})
