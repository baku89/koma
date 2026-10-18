# TODO

やることの一覧（優先順）。終わったら消す。背景や判断の経緯は CLAUDE.md / ADDSUB.md に書く。

## 保存の安全（2026-10-16 の事故を二度と起こさない）

1. **付け替えの進捗を見せる** — タイトルバーのスピナーだけでは「固まった」と区別がつかない。`reconcileAssets` の移動件数（済 / 全体）と残り時間の見積りを `project` ストアに出し、タイトルバーに「Renaming files 312 / 1,482 · 5 min left」。
2. **保存をトランザクションにする（journal）** — 付け替えの前に `_reconcile.json`（from → to の一覧）と `project.json.next` を書き、全部動かし終わってから `project.json` を差し替えて journal を消す。開くときに journal が残っていれば、移動の残りを済ませてから（済んだ分は飛ばす）json を差し替える。途中でリロード・クラッシュしても次に開けば完了状態から始まる。`saveProject` は desired の名前で json を組めるようにする（今は移動後の `getAssetFilename` を読んでいる）。
3. **保存中の Cmd+R をアプリ内で止める** — `keydown` を preventDefault して、残りファイル数と時間つきの確認を出す。リロードボタンには効かないので 1・2 の補助。`beforeunload` の警告は既にあり動作確認済み（`App.vue`）。**Electron 版では済み**（`beforeunload` が `will-prevent-unload` に届き、Stay / Leave anyway のダイアログになる）。ブラウザ版のみ残。
4. **（設計判断）ファイル名をコマ番号に追従させるのをやめるか** — 今は途中の Insert / Delete で後ろの全ファイルが付け替わる（実フォルダは jpg + lv + DNG のコピー）。撮影時の名前で固定し、json がコマとファイルを対応づける案。付け替えが無くなれば 1〜3 の重みも下がる。書き出し時の連番は MP4 / 画像書き出しで振り直せばよい。

## Insert / Delete / 選択

- 範囲選択の Copy（今は現在コマ 1 つだけ）。
- 全レイヤー一斉の Insert を別コマンドにするか（今はレイヤー単位のみ）。

## 撮影

- **Main 以外のレイヤーで撮影すると撮影コマが行方不明になる** — 症状の具体を確認（サムネイルが出ない / カメラアイコンが飛ぶ / 行ごと見えない）。候補: 撮影先レイヤーがアクティブなプリセットで Hide だと行ごと描かれない → 撮影先レイヤーは常に描く。

## Box Rig（2026-10-18）

- **A/B/C のホーミングが毎回少しずれる件の切り分け** — カメラに乗せたレーザーの点を 2 m 先に出し（0.1° = 3.5 mm）、(a) ホーミング ×5 の点のばらつき、(b) ホーミング無しで +10° → −10° と往復したときの戻り、を比べる。(b) でずれるならギアのバックラッシ（ホーミングの設定では直らない）。その場合は `rig.moveTo` で回転軸の最終アプローチを常に同じ向きにする（− 方向の移動は 2° 行き過ぎてから + で戻る）。boxrig.yaml 側は approach 30 °/min・settle 1 s にした（2026-10-18、`~/Downloads/boxrig.yaml`、未アップロード）。

## trash

- trash パネル（一覧・Restore・Empty / purge）。データ層は済み（`project.trash`、`_trash/`）。
- `_unreferenced-20261016/`（復旧時に退避した複製 70 ファイル）は消してよい。

## inbox

- 保存時に「`project.json` が外で書き換えられていたら上書きしない」ガード。

## レンズ / フォーカス（2026-10-17、ADDSUB.md「レンズ表とフォーカスモード」）

- シートを koma に貼る（Camera Control › Lens › Paste）。瞳からの距離で測ってあるので 4 列目は不要。Calibration › Pupil offset の z（回転中心 → 瞳、`[0, 0, −d]`）を入れると表の distance が回転中心基準になる。
- 実カメラで `distance` モードの mm 入力と `target` モードのオートフォーカスを確認（Sigma fp は AF モードでないとフォーカス位置を受け付けない）。
- Houdini の `/obj/cam` に張った Koma Lens（焦点目標 `/obj/focus_target`）を hip に保存する。`pupilOffset` を入れたら表の distance が回転中心基準になるので Houdini 側は何もしなくてよい（`pupil` を引く）。
- `focusDistance` の Plan 補間は正規化値の線形（mm で線形にするなら表を通す）。

## Electron 版（2026-10-17 に追加、CLAUDE.md「Electron 版」）

- 実機で未確認: Sigma fp の接続（ptpcamera キラーが 250 ms 間隔で間に合うか。間に合わなければ main の `PTP_KILL_INTERVAL_MS` を詰める）、FluidNC 2 台と LED の自動識別（USB のポートは全部 `getPorts()` に出る）、`showSaveFilePicker`（MP4 書き出し）。
- Edit メニューの Copy / Paste ロールは「ページが preventDefault しなかったキーだけ」に効く。テキストを選択したまま Cmd+C でショットをコピーすると、メニュー側の copy がクリップボードを上書きし得る（未確認）。気になれば `electron/menu.ts` の `editMenu` を Undo / Redo 無しの自前にする。
- aux の状態（OSC ブリッジが 8080 を取れたか）は `window.koma.auxStatus()` で読めるだけで UI に出していない。`yarn aux` を別に動かしていると衝突する。
- Chromium の CSP 警告（dev 起動時のみ）。アイコンは `public/icon.png` を流用、署名・notarize 無し（配布するなら要対応）。
- 展示画面（exhibit.html / jog.html）はアプリに入れていない（relay が配る dist を使う）。
