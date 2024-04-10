const {DMX, ArtnetDriver} = require('dmx-ts')

let universe = null

async function startDmx() {
	const dmx = new DMX()

	universe = await dmx.addUniverse('artnet', new ArtnetDriver('10.0.1.30'))

	universe.update({0: 255, 1: 255, 2: 255, 3: 255})
}

startDmx()

function sendDmx(address, value) {
	value = Math.round(value * 255)

	if (!universe) {
		return
	}

	// Offset by 16
	universe.update({[address - 1 + 16]: value})
}

module.exports = {sendDmx}
