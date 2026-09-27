# koma exhibit machine

This folder is produced by `yarn pack:exhibit` on the development machine and
copied to the exhibit machine (the always-on Mac driving the screens). It needs
nothing but Node.js there.

```
dist/                 built koma + exhibit pages
relay/                koma-relay server (index.js + node_modules/ws)
start.sh              starts the relay (port, project copy folder, token)
install-launchd.sh    registers start.sh (and optionally Chrome kiosk) at login
```

See "セットアップ" in ADDSUB.md (実装メモ → koma-relay) for the step by step.
