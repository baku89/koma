# koma exhibit machine

This folder is produced by `yarn pack:exhibit` on the development machine and
copied to the exhibit machine (the always-on Mac driving the screens). It needs
nothing but Node.js there.

```
dist/                 built koma + exhibit pages
relay/                koma-relay server (index.js + node_modules/ws)
start.sh              starts the relay (port, project copy folder, token)
kiosk.sh / kiosk.mjs  opens the exhibit screens in Chrome, fullscreen, one per display
install-launchd.sh    registers start.sh (and with --kiosk, kiosk.sh) at login
```

```
sh install-launchd.sh --kiosk                          relay + screens at every login
KOMA_EXHIBIT_SCREENS=b,a sh install-launchd.sh --kiosk   the two displays swapped
sh install-launchd.sh --remove                         stop both (Chrome quits)
```

Logs: `~/Library/Logs/koma-relay.log`, `~/Library/Logs/koma-exhibit-kiosk.log`.

See "セットアップ" in ADDSUB.md (実装メモ → koma-relay) for the step by step.
