#!/bin/sh
# Start koma-relay on the exhibit machine. Works from either place:
#   - inside a clone of the koma repo (dev_modules/koma-relay/exhibit-machine/),
#     serving the repo's dist/ — update with `git pull && yarn build`;
#   - inside a bundle made by `yarn pack:exhibit` (relay/ + dist/ next to it).
# Runs in the foreground (launchd keeps it alive; see install-launchd.sh).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

PORT="${KOMA_RELAY_PORT:-7777}"
# Where the display copy pushed by the shooting machine is kept.
DIR="${KOMA_RELAY_DIR:-$HOME/koma-exhibit-project}"
# Optional shared secret; the same string goes into koma's relay popup.
TOKEN="${KOMA_RELAY_TOKEN:-}"

if [ -f "$HERE/../index.js" ]; then
	RELAY="$HERE/../index.js"           # repo layout
	DIST="$HERE/../../../dist"
else
	RELAY="$HERE/relay/index.js"        # bundle layout
	DIST="$HERE/dist"
fi

# Node from the nodejs.org .pkg / Homebrew / nvm; launchd has a bare PATH.
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.nvm/versions/node/current/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ] && ! command -v node >/dev/null 2>&1; then
	# shellcheck disable=SC1091
	. "$HOME/.nvm/nvm.sh"
fi

exec node "$RELAY" --dir "$DIR" --port "$PORT" --static "$DIST" ${TOKEN:+--token "$TOKEN"}
