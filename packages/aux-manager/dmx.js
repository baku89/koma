const {DMX, ArtnetDriver} = require('dmx-ts')

let universe = null

async function startDmx() {
	const dmx = new DMX()

	universe = await dmx.addUniverse('artnet', new ArtnetDriver('10.0.1.30'))
}

startDmx()

function sendDmx(address, value) {
	value = Math.round(value * 255)

	if (!universe) {
		return
	}

	// Offset by 32
	universe.update({[address - 1 + 32]: value})
}

module.exports = {sendDmx}
