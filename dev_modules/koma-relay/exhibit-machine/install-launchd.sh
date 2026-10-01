#!/bin/sh
# Register koma-relay (and, with --kiosk, the exhibit screens in Chrome) as
# launchd user agents: they start at login and are restarted if they die.
#
#   sh install-launchd.sh            relay only
#   sh install-launchd.sh --kiosk    relay + Chrome fullscreen on every display
#                                    (kiosk.sh: screen A on the first display,
#                                    screen B on the second)
#   sh install-launchd.sh --remove   unload both (Chrome quits)
#   sh install-launchd.sh --print    show the plists, install nothing
#
# KOMA_* variables set when this runs are written into the agents, e.g.
#   KOMA_EXHIBIT_SCREENS=b,a sh install-launchd.sh --kiosk     (swap the displays)
#   KOMA_RELAY_TOKEN=… KOMA_RELAY_DIR=… sh install-launchd.sh  (start.sh)
# Run it again to change them.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs"
RELAY_LABEL=com.baku89.koma-relay
KIOSK_LABEL=com.baku89.koma-exhibit-kiosk

KIOSK=0; REMOVE=0; PRINT=0
for arg in "$@"; do
	case "$arg" in
		--kiosk) KIOSK=1 ;;
		--remove) REMOVE=1 ;;
		--print) PRINT=1 ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }

# plist <label> <script> <log file>
plist() {
	cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>Label</key><string>$1</string>
	<key>ProgramArguments</key><array>
		<string>/bin/sh</string>
		<string>$(xml "$HERE/$2")</string>
	</array>
	<key>EnvironmentVariables</key><dict>
$(env | grep '^KOMA_' | while IFS='=' read -r key value; do
	printf '\t\t<key>%s</key><string>%s</string>\n' "$key" "$(xml "$value")"
done)
	</dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$(xml "$LOGS/$3")</string>
	<key>StandardErrorPath</key><string>$(xml "$LOGS/$3")</string>
</dict></plist>
PLIST
}

if [ "$PRINT" = 1 ]; then
	plist "$RELAY_LABEL" start.sh koma-relay.log
	[ "$KIOSK" = 1 ] && plist "$KIOSK_LABEL" kiosk.sh koma-exhibit-kiosk.log
	exit 0
fi

# Unload and wait until it is gone: loading again while the old one is still
# shutting down (Chrome takes a moment to quit) fails.
unload() {
	launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || return 0
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1 || return 0
		sleep 1
	done
}

# load <label> <script> <log file>
load() {
	unload "$1"
	# Removed first: a plist left by an earlier sudo run can't be written over.
	rm -f "$AGENTS/$1.plist"
	plist "$@" > "$AGENTS/$1.plist"
	if ! launchctl bootstrap "gui/$(id -u)" "$AGENTS/$1.plist"; then
		echo "launchd did not take $1. This has to run as the user who is logged in" >&2
		echo "at this Mac's screen (over SSH it only works while that user is logged in)." >&2
		exit 1
	fi
}

# The agents belong to the logged-in user: as root there is no gui/0 domain to
# load them into ("Domain does not support specified action"), and the plists
# end up owned by root.
if [ "$(id -u)" = 0 ]; then
	echo "Run this without sudo." >&2
	exit 1
fi

mkdir -p "$AGENTS" "$LOGS"
if [ ! -w "$AGENTS" ]; then
	echo "$AGENTS is not writable by $(id -un) (owned by root?). Fix it with:" >&2
	echo "  sudo chown -R $(id -un) \"$AGENTS\"" >&2
	exit 1
fi

if [ "$REMOVE" = 1 ]; then
	unload "$KIOSK_LABEL"; unload "$RELAY_LABEL"
	rm -f "$AGENTS/$KIOSK_LABEL.plist" "$AGENTS/$RELAY_LABEL.plist"
	echo "removed"
	exit 0
fi

load "$RELAY_LABEL" start.sh koma-relay.log
echo "koma-relay: loaded (log: ~/Library/Logs/koma-relay.log)"

if [ "$KIOSK" = 1 ]; then
	load "$KIOSK_LABEL" kiosk.sh koma-exhibit-kiosk.log
	echo "exhibit screens: loaded (log: ~/Library/Logs/koma-exhibit-kiosk.log)"
fi
