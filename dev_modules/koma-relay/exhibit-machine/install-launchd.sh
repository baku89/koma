#!/bin/sh
# Register koma-relay (and, optionally, Chrome in kiosk mode) as launchd user
# agents so they start at login and are restarted if they die.
#
#   ./install-launchd.sh            relay only
#   ./install-launchd.sh --kiosk    relay + Chrome kiosk on screen B (single monitor)
#   ./install-launchd.sh --remove   unload both
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
RELAY_PLIST="$AGENTS/com.baku89.koma-relay.plist"
KIOSK_PLIST="$AGENTS/com.baku89.koma-exhibit-kiosk.plist"
mkdir -p "$AGENTS" "$HOME/Library/Logs"

unload() { launchctl bootout "gui/$(id -u)" "$1" 2>/dev/null || true; }

if [ "${1:-}" = "--remove" ]; then
	unload "$RELAY_PLIST"; unload "$KIOSK_PLIST"
	rm -f "$RELAY_PLIST" "$KIOSK_PLIST"
	echo "removed"
	exit 0
fi

unload "$RELAY_PLIST"
cat > "$RELAY_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>Label</key><string>com.baku89.koma-relay</string>
	<key>ProgramArguments</key><array><string>$HERE/start.sh</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>$HOME/Library/Logs/koma-relay.log</string>
	<key>StandardErrorPath</key><string>$HOME/Library/Logs/koma-relay.log</string>
</dict></plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$RELAY_PLIST"
echo "koma-relay: loaded (log: ~/Library/Logs/koma-relay.log)"

if [ "${1:-}" = "--kiosk" ]; then
	unload "$KIOSK_PLIST"
	cat > "$KIOSK_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>Label</key><string>com.baku89.koma-exhibit-kiosk</string>
	<key>ProgramArguments</key><array>
		<string>/Applications/Google Chrome.app/Contents/MacOS/Google Chrome</string>
		<string>--kiosk</string>
		<string>--noerrdialogs</string>
		<string>--disable-session-crashed-bubble</string>
		<string>--autoplay-policy=no-user-gesture-required</string>
		<string>--user-data-dir=$HOME/Library/Application Support/koma-exhibit-chrome</string>
		<string>http://localhost:${KOMA_RELAY_PORT:-7777}/exhibit.html?screen=b</string>
	</array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
</dict></plist>
PLIST
	launchctl bootstrap "gui/$(id -u)" "$KIOSK_PLIST"
	echo "kiosk: loaded (Chrome, screen B). For two monitors use the setup overlay instead."
fi
