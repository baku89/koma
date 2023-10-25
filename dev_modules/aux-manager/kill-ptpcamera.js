const {exec} = require('node:child_process')

// Run the command `(ps aux | grep "[p]tpcamera" | awk '{print $2}'`
// to get the PID of the ptpcamera process.
// Then run `kill -9 <PID>` to kill the process.
// This is a workaround for the bug of the ptpcamera process
// that prevents Tethr from working.

function killPTPProcess() {
	exec("kill -9 $(ps aux | grep '[p]tpcamera' | awk '{print $2}')", () =>
		setTimeout(killPTPProcess, 500)
	)
}

module.exports = {killPTPProcess}
