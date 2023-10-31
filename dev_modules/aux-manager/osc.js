const OSC = require('osc-js')
const chalk = require('chalk')

const osc = new OSC({
	plugin: new OSC.BridgePlugin({
		udpClient: {port: 5201},
		udpServer: {port: 5200},
	}),
})

osc.on('load', () => {})

osc.on('*', e => {
	const {address, args} = e
	printKeyValue(address, printVector(args))
})

osc.open()

const sentAddresses = []

function sendOsc(address, ...args) {
	osc.send(new OSC.Message(address, ...args))
	printKeyValue(address, printVector(args))
}

function printKeyValue(key, value) {
	let index = sentAddresses.indexOf(key)
	if (index === -1) {
		index = sentAddresses.push(key) - 1
	}
	const y = index + 4
	process.stdout.cursorTo(0, y)
	process.stdout.clearLine(1)
	process.stdout.write(
		'  ' + chalk.redBright(key.padEnd(18, ' ')) + ' = ' + value + '\n'
	)
}

function printVector(vec) {
	return vec
		.map(v =>
			chalk.red(typeof v === 'number' ? v.toFixed(3).padStart(6, ' ') : v)
		)
		.join(', ')
}

module.exports = {sendOsc}
