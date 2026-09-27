#!/bin/sh
# Bundle everything the exhibit machine needs into one folder (no git, yarn or
# build tools there — only Node.js): the built koma pages, koma-relay with its
# single dependency, and the start / launchd files from
# dev_modules/koma-relay/exhibit-machine. ADDSUB.md §15.
#
#   yarn pack:exhibit            → build/koma-exhibit/  (+ build/koma-exhibit.zip)
set -eu
cd "$(dirname "$0")/.."

OUT=build/koma-exhibit
rm -rf "$OUT"
mkdir -p "$OUT/relay/node_modules"

echo "› building koma (vite build)…"
yarn -s build >/dev/null

cp -R dist "$OUT/dist"
cp dev_modules/koma-relay/index.js dev_modules/koma-relay/package.json "$OUT/relay/"
cp -R node_modules/ws "$OUT/relay/node_modules/ws"
cp dev_modules/koma-relay/exhibit-machine/* "$OUT/"
chmod +x "$OUT"/*.sh

(cd build && rm -f koma-exhibit.zip && zip -qr koma-exhibit.zip koma-exhibit)
echo "› $OUT  ($(du -sh "$OUT" | cut -f1)),  build/koma-exhibit.zip"
