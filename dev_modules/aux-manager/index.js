const {killPTPProcess} = require('./kill-ptpcamera')
// Opens the OSC bridge (WebSocket <-> UDP) and prints every message that
// passes through it from row 4 on.
require('./osc')

console.clear()
process.stdout.cursorTo(0, 0)
process.stdout.write('┌──────────────────┐\n')
process.stdout.write('│ Koma Aux Manager │\n')
process.stdout.write('└──────────────────┘\n')
process.stdout.write('* Killing ptpcamera, bridging OSC (UDP in 5200 / out 5201)\n')

killPTPProcess()
