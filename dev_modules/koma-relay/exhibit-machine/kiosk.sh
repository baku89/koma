#!/bin/sh
# Open the exhibit screens in Chrome on this machine's displays, fullscreen
# (kiosk.mjs has the details and the settings). Runs in the foreground until
# Chrome quits (launchd keeps it alive; see install-launchd.sh --kiosk).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

# Node from the nodejs.org .pkg / Homebrew / nvm; launchd has a bare PATH.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/current/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ] && ! command -v node >/dev/null 2>&1; then
	# shellcheck disable=SC1091
	. "$HOME/.nvm/nvm.sh"
fi

exec node "$HERE/kiosk.mjs"
