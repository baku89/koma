@ADDSUB.md

# CLAUDE.md

koma（ストップモーション撮影アプリ）のプロジェクト知識。`~/.claude` のファイルメモリを集約したもの。マシンをまたいで引き継げるよう、リポジトリにコミットして共有する。

## コミュニケーション / 作業スタイル
- **やることの一覧は `TODO.md`**（リポジトリ直下、優先順）。未実装の提案や「あとで」はそこに足し、終わったら消す。経緯はこのファイルに書く。
- **返信は常に日本語**（ユーザーは英語で書くことが多いが日本語の回答を望む。2026-06-02 に明示要望）。散文・説明は日本語で書き、コード/コマンド/パス/識別子/技術固有名詞（API名など）はそのまま。
- **tweeq / tethr は vendored submodule**（`dev_modules/` 配下）。vite alias + tsconfig `paths` で **src に解決**されるため編集は即反映（ビルド不要、`lib/` は存在しない）。ユーザーは submodule を直接編集する形を希望。

---

## Electron 版（2026-10-17）
ブラウザ版（PWA）と同じ koma を Electron 44（Chromium 152 / Node 24。34 から上げた）で包んだもの。狙いは 3 つ: **aux の内蔵**（別ターミナルの `yarn aux` が要らない）、**Reveal in Finder**、**実フォルダでの byte-free rename**（Chrome の `move()` は実フォルダで throw して copy+delete になる。GOTCHA #2）。

- **コマンド**: `yarn app`（dev: vite 5556 + Electron、`yarn dev` と同時に動かせる）/ `yarn app:build`（`build/renderer` + `build/electron`）/ `yarn app:pack`（electron-builder → `build/release/Koma.app` と .dmg、未署名）。ブラウザ版の `yarn dev` / `yarn build` は従来どおり。
- **ファイル**: `electron/main.ts`（窓・`koma://` スキーム・IPC）、`preload.ts`（`window.koma`、sandbox なので **CJS = `preload.cjs`**。package.json が `type: module` なので main は ESM）、`devices.ts`（USB / Serial / FSA の許可）、`aux.ts`、`menu.ts`。`vite.electron.config.ts` は `vite.config.ts` の `createConfig({electron: true})`（PWA 無し・`index.html` だけ・outDir `build/renderer`）+ `vite-plugin-electron/simple`。`electron-builder.yml`。`osc-js` は main が実行時に require するので `dependencies`（main のバンドルでは external）。renderer 側の入口は `src/electron.ts`（`native` / `isElectron`、ブラウザでは undefined）。
- **オリジン**: パッケージ版は `koma://app/index.html`（`registerSchemesAsPrivileged` で standard+secure。`file://` だと IndexedDB / FSA ハンドルの永続化が効かない）。dev は vite の URL なので、**最近のプロジェクト・保存したハンドルは dev とパッケージ版で別**。`KOMA_USER_DATA=<dir>` で userData（窓の位置、USB の記憶、IndexedDB）を分けられる（テスト用）。
- **機器**: Electron には Chrome のピッカーが無いので `select-usb-device` / `select-serial-port` を main で受ける。**Serial は USB 由来のポート（vendorId あり）を全部自動許可** → `getPorts()` に全部出て、koma の discovery が `$I` / PING で識別する（Bluetooth / debug ポートは外す。入れると 1 つ 12 秒の probe で待たされる）。`requestPort()` は候補が 2 つ以上なら `dialog.showMessageBox` のボタンで選ぶ。**USB は Chrome と同じ「選んだものを記憶」**（`userData/usb-grants.json`、`setDevicePermissionHandler`）。候補 1 つなら無言で選ぶ。
- **フォルダの実パス**: FSA の `setPermissionRequestHandler` / `setPermissionCheckHandler` の `details` に **`filePath` と `isDirectory`** が来る（Electron 44 でピッカー直後と `requestPermission` の両方で確認）。main が記録し、renderer は `window.koma.grantedDirectoryPath(handle.name)` で引く（`src/utils/nativePath.ts`。`project.open` / `saveAs` の `adoptNativeDirPath`、`_trash` は `registerNativeChildDir`）。`assets.ts moveEntry` と `project.moveProjectFile` はパスが分かるとき `koma.rename`（`fs.rename`、EXDEV は copy+unlink）→ 実測 7 ms。IPC の rename / reveal は許可済みフォルダの中だけ（`isGrantedPath`）。OPFS のプロジェクトはパス無し → 従来の `move()`。
- **Reveal**: アクション `open_project_folder`（File グループ、アプリの File メニューからも `koma:command` IPC で）と `reveal_shot_in_finder`（ショットの右クリック。jpg が無ければ lv）。`isElectron` のときだけ登録するので、ブラウザではメニューに出ない。
- **aux**: `electron/aux.ts` は `dev_modules/aux-manager/lib/aux.js`（ptpcamera キラー 250 ms / OSC ブリッジ ws 8080 ↔ udp 5200 / 5201 / MCP tools bridge 8090）をそのまま main で動かす薄い包み（2026-10-23、「aux と `yarn dev`」参照）。ポートが取られていれば（`yarn dev` 併用）その行だけエラーをログに出して諦め、renderer は相手のブリッジに繋ぐ。main のバンドルでは `osc-js` / `ws` / `zod` / `@modelcontextprotocol/sdk` が external（root の `dependencies`）。
- **リロード / 終了の守り**: renderer の `beforeunload`（保存中・未保存）は Electron では無言でキャンセルされるので、`will-prevent-unload` で「Stay / Leave anyway」のダイアログにした（TODO の 3 を Electron 版で解消）。`backgroundThrottling: false`（裏に回ってもタイマーが 1 Hz に落ちない。ADDSUB の「koma タブは前面に」が不要になる）。
- **アイコン（2026-11-03）**: macOS 26（Tahoe）は角丸に収まっていない旧来の icns を灰色の角丸に縮めて入れるので、Icon Composer 形式の `electron/Koma.icon`（`icon.json` + `Assets/logo.svg`。背景 #262626、線は `PALETTE.red` = rec の #e5484d。glass / 影は無し）にした。`yarn app:pack` は **Xcode 26 の `actool` が必須**。`public/icon.png`（PWA・README）はこれを macOS で描画した 512 px の書き出しで、自動では更新されない。
- **WCO**: `titleBarStyle: 'hidden'` + `titleBarOverlay: {height: 38}` で `env(titlebar-area-*)` が PWA と同じに効く（信号機ぶん x = 84）。
- **キー**: Edit メニューの role（Undo / Copy / Paste…）を残しているが、macOS でも**実キーはまずページの keydown に届く**（System Events の keystroke で Cmd+Z / Cmd+C を送って確認）。ページが preventDefault しなければそのあとメニューの role が走る。
- **落とし穴**: (1) **pinia の二重化** — `yarn add -W` で `dev_modules/tweeq/node_modules/pinia`（3.x）が入り、本番バンドルで tweeq のストアが koma の pinia を見失って `Cannot read properties of undefined (reading '_s')` で起動しなかった（dev は無事）。`vite.config.ts` の `resolve.dedupe: ['vue', 'pinia', '@vueuse/core']` で解決。(2) Playwright の `_electron.launch`（scratchpad に `playwright-core`）で窓は操作できるが、フォルダピッカーは System Events の keystroke（Cmd+Shift+G → パス → Return ×2）で押す。`select-serial-port` のシグネチャは `(event, portList, webContents, callback)`。
- **確認済（2026-10-17、Playwright `_electron`）**: パッケージ版 `Koma.app`（352 MB、dmg 145 MB）の起動、`koma://` での IndexedDB / FSA、ピッカー → パス取得 → `koma.rename`（7 ms）、許可外パスの拒否、WCO、aux。**未確認**: 実カメラ（ptpcamera との競合）、実機の FluidNC / LED、`showSaveFilePicker`（MP4 書き出し）。

---

## aux と `yarn dev`（2026-10-23）
`dev_modules/aux-manager` を **ライブラリ（`lib/`）+ Ink の画面（`ui.js`）+ CLI（`index.js`）** に分けた。ライブラリは出力を持たず `on('log')` / `on('status')` で報告し、Electron の main も同じものを import する（以前は `electron/aux.ts` に別実装があった）。

- **macOS 26 では `ptpcamera` が `ptpcamerad` に改名**（2026-10-27 に発覚: `yarn dev` が動いていてもカメラを掴めない）。`lib/ptpcamera.js` は `pkill -9 -x 'ptpcamera|ptpcamerad'` で両方を殺す。launchd がすぐ立て直すので 250 ms の周期で殺し続けるのは従来どおり。aux のコードなので直した後は `yarn dev` を立て直す。
- **`yarn dev` = aux + vite を 1 プロセスで**（`node dev_modules/aux-manager/index.js --vite`）。vite は JS API（`createServer`）でプロセス内に立て、`customLogger` でログを画面に流し、URL を状態欄に出す。Ctrl+C 1 回で両方止まる。`yarn aux` は vite 無し。`--port`（vite）/ `--tools-port`（MCP）/ `--plain`（1 行ずつ。TTY でなければ自動）/ `--help`。別ポートで素の vite が欲しいときは従来どおり `npx vite --port 5557`。
- **画面（Ink = Claude Code と同じ）**: 上段に ● / ○ / ✖ の状態行（ptpcamera の kill 回数、OSC のポートとメッセージ数、MCP の URL・繋がっている koma のプロジェクト名・ツール数・呼び出し回数、Vite の URL）、下段にタグ付きのログ（`osc` / `mcp` / `tools` / `vite` / `ptp`）。キーは `q` 終了・`c` ログ消去・`o` でブラウザを開く。OSC の連打は 40 ms でまとめて描く。JSX は使わず `htm`（`html\`<${Box}>…\``）。
- **ESM 化**（Ink が ESM のみ）。`lib/aux.d.ts` が Electron 側の型。依存は root と aux-manager の両方の `package.json` に書く（electron-builder は root の `dependencies` しか同梱しない）。
- 確認: Python の pty で `--vite` 起動 → 状態行 4 本と URL、`q` で終了。`script` コマンドは EOF を送ってしまい使えない。
- `yarn app`（Electron）はこれを使わない（main 内蔵）。`yarn dev` と同時に動かすと 8080 / 8090 が取られて Electron 側はその行だけエラー、renderer は dev のブリッジに繋がる（実害なし）。

---

## Tethr（カメラ制御）

### カメラ識別子と自動再接続（2026-06-26）
目的: koma プロジェクトを開いたら、最後に撮影に使ったカメラ（USB/webcam）が今つながっていれば自動再接続する。

**Tethr 側 API:**
- `Tethr.identifier: TethrIdentifier`（抽象。TethrPTPUSB は `device.usb` から、TethrWebcam は `{type:'webcam'}`）。`TethrIdentifier = {type:'ptpusb', usb?:{vendorId,productId,serialNumber?}, model?} | {type:'webcam', model?}`。
- `TethrManager.requestCamera(query: TethrDeviceType | TethrIdentifier, {prompt=true})`: identifier 指定時はまずペア済みデバイスを照合（serial → vendor:product → model）して無言で返す。無く `prompt!==false` の時だけ picker 表示（USB picker は vendor:product で絞る）。未 open のインスタンスを返す（hook が open）。
- `useTethr()` は `isConnecting`（readonly ref）と `requestCamera(query, opts)` を公開。

**koma 側:** `project.camera?: CameraIdentity`（= `TethrIdentifier`）。`camera.ts setupCamera` で `{...cam.identifier, model}` を保存。自動再接続 watcher が `requestCamera(project.camera, {prompt:false})`、手動ボタンは `requestCamera(type)`。

**load-bearing な落とし穴:**
- `navigator.usb.requestDevice()` / webcam `getUserMedia` は **transient user activation** が必要。プロジェクト開時の自動再接続はジェスチャでないので `prompt:false`（無言 `getDevices()` 経路）必須、でないと throw。これが `prompt` オプションの存在理由。
- Tethr の webcam は **単一/デフォルト**（per-device deviceId 無し）。個別 webcam は区別不可、identity は `type:'webcam'` のみ。
- `isConnecting` 導入の理由: `requestCamera` は open 前に `pairedCameras`（自動再接続が listen）を変えるので、ガードが無いと手動接続時に「前に記憶したカメラ」が勝つレース（"USB接続後も webcam が残る" バグ）。
- `device.usb.serialNumber` は通信不要で読める（ペア済みなら）が `getModel()`/PTP serial はデバイス通信が要る → USB serial を identity に採用。`Tethr.getSerialNumber()` は ptpusb 未実装（null）。

**接続キャンセル:** prompt 却下はエラー扱いしない。`OperationResultStatus` に `'cancelled'` 追加。`TethrManager.isUserCancelledError(err)`（NotFoundError/NotAllowedError/AbortError = picker dismiss / webcam 拒否）。USB picker cancel → `{status:'cancelled'}`、webcam cancel は無言、vue3 hook の catch も `isUserCancelledError` 時 alert スキップ。

### Sigma fp / fp L SDK の設定エンコード（reference）
`dev_modules/tethr` の `TethrSigma.ts` 向け。

**SDK ドキュメント（プロトコル正典）:** `/Users/baku/Dropbox/Works/2023/14_tempalay/capture/sigma fp SDK/` — `Document/SIGMA_Camera_Control_SDK_Help_for_mac_{EN,JP}.pdf`、`SDK/`（コンパイル済 .framework）、`SampleProgram/`。PDF は CID フォントで素のストリーム抽出は文字化け、`poppler`/`pdftotext` も未インストール。**macOS PDFKit を JXA 経由で**抽出: `osascript -l JavaScript` → `ObjC.import('Quartz')` → `$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(path))` → `doc.pageAtIndex(i).string`。主要ページ(EN): p15 ExposureMode, p19 ColorMode/Destination, p21 CamDataGroup4, p53-54 CanSetInfo5 値リスト, p60 LV magnification/Focus Peaking, p62 DataGroupFocus, p65 error codes。

**SetCamData ワイヤ形式:** `[size byte][FieldPresent1][FieldPresent2][packed present fields][checksum]`。tethr の `setCamData(opcode, idx, value)` は `1<<idx` を LE uint16 で書くので idx 0-7 → FieldPresent1 ビット、idx 8-15 → FieldPresent2 ビット。フィールドのビット位置は SDK の group struct で確認（低位ビットが Reserved の場合あり。例: Group4 FP1: b4=DcCrop, b5=LVMagnify, b6=ISOext, b7=ContShoot）。

**二重エンコード（最大の罠）:** 一部設定は CanSetInfo5 の *リスト* と status/set *バイト* で別コード。
- **ExposureMode**: CanSetInfo5 は連番 1-4=P/A/S/M, 5-10=C1-C6（fp L は custom 6個）。旧 fp の status バイトは custom ビット（0x10/0x20/0x40=C1/C2/C3）を base に OR、+0x80=★read-only。TethrSigma は options/get/set を1枚の連番テーブルで処理し `decodeExposureMode` でビット式フォールバック。
- **LV magnify**: status バイト 0x01/0x02/0x03 = x1/x4/x8、CanSetInfo5 は比率 1/4/8 を直接返す。`liveviewMagnifyRatioTable` が id→比率。
- **WhiteBalance**: CanSetInfo5（IFD tag 301, EN p56）は 1=Auto, 2=Auto(Light Source Priority), 3=Daylight, 4=Shade, 5=Incandescent, 6=Fluorescent, 7=Flash, 8=COLOR TEMP, 9-11=Custom1-3 — GetCamDataGroup2 status バイト（`whiteBalanceTable` BiMap）とは別エンコード。option リストテーブル（`whiteBalanceTableIFD`）は status BiMap と **同じ WhiteBalance 文字列**を出さないと get/set で round-trip しない（getKey が undefined → 'invalid parameter'、現在値もハイライトされない）。標準 enum 名（'auto ambience', 'incandescent'）を使い 'vendor:' 接頭や別名（'tungsten'）は避ける（koma の icon map + 既定 labelizer が標準名キー）。Custom1-3 は IFD テーブルから意図的に除外、未マップは `isntNil` フィルタで落とす（null だけでなく undefined も除外する実装であること）。

**Focus peaking に status フィールド無し:** CanSetInfo5 (tag 702, colors 0=off/1=white/2=black/3=red/4=yellow) にのみ存在、GetCamDataGroup には無い。`SetCamDataGroupFocus` IFD tag 702 で set、read は focus group に tag 702 が返れば decode、無ければ最後に set した値をキャッシュ。best-effort（実機確認要）。

**DeviceBusy は現実:** PTP バス（単一スロット）混雑時にカメラは書き込みを落とす。`setCamData` は 10×25ms リトライ。importConfigs は per-write sweep を抑制 + 各 config を verify/retry（以前は busy を 'ok' として握りつぶしていた）。

### Lumix S9（2026-11-04、`TethrPanasonic`）
DC-S9（`04da:2382`、S5 と同じ PID、ファーム 1.9）を実機で確認。確認済み: 全設定の往復（シャッター 59 値、ISO、絞り、露出補正、WB 15 値、アスペクト、画質、フォトスタイル）、ライブビュー（約 30 fps、640 / 960 / 1280）、AF、MF の相対送り、JPEG + RAW のダウンロード（32 MB で 8 秒）。**koma の画面からの接続は未確認。**

- **`usb.reset()` で USB から切断→約 2 秒後に再接続**するので、Panasonic だけ `open()` の reset を飛ばす（`connect` イベント経由で繰り返す恐れがあった）。`0x66` と clearHalt はそのまま。
- **イベントは v0.6.4（`881329b`）から全機種で届いていなかった**: `open()` が `#opened = true` の前に `#listenInterruptIn()` を呼び、先頭のガードで即終了していた。今は Panasonic だけ有効。fp で有効にすると `DevicePropChanged` ごとの読み直しでバスが混むので、実機で試してから広げる（EOS は GetEvent のポーリングが主なので影響は小さいはず、未確認）。
- **S9 はまれに（30 トランザクションに 1 回程度）応答を保留し、次のコマンドが来るまで返さない**。割り込みを読むかどうか、`C107` に応えるかどうかとは無関係（実測）。Tethr のキューは完了まで次を送らないのでデッドロックになり、10 秒ごとの timeout が続く。`nudgeAfterMs`（1.5 秒）で無害な OpenSession を送って解消する。**長い転送には付けない**（オブジェクトのダウンロード）。
- **AF-S でピントが合わないと、撮影コマンドは OK を返すのにシャッターが切れない**（`C108` が来ない、ファイルも増えない）。`takePhoto` は 10 秒 + 露光時間で `general error` を返す。コマ撮りでは MF にする。
- **ドライブモードが連写（`0x2000081` = 1）だと 1 回の指示で 2 枚撮れる**。`0` なら 1 枚。Tethr には設定を置いていない。
- 画質コードは S9 では 0 / 1 / 3 / 4 / 5 = fine / standard / raw / raw,fine / raw,standard（撮影して確認）。既存の表（2 / 3 / 4）とずれているので `model === 'DC-S9'` のときだけ差し替え。S5 / G9M2 の表は未確認。
- `focusMode` を追加（`0x2000071`: 3 = MF、4 = AF-S、5 = AF-C）。MF 駆動は MF モードでだけ受け付ける。**フォーカスは相対送りのみ**（`0x12010040` は常に 65535）で `focusDistance` は無い = レンズ表の Distance / Target モードは使えない。
- 他の修正: `close()` が `super.open()` を呼んでいた、分数のシャッター（1/1.3 など）が `parseInt` で丸められていた、`0xfffffffe` = bulb、WB の 0x800b–e（プリセット 1–4）、`setLiveviewSize` の `map(parseInt)`、拒否された設定は例外でなく `invalid parameter`（`0x201d` は一度だけ再試行）、ライブビュー中に空データが返る desc は読み直す。
- **資料**: 公式の [LUMIX SDK](https://av.jpn.support.panasonic.com/support/global/cs/soft/tool/sdk.html) は Windows 専用のベータ（DLL + ヘッダ、S9 は Beta 1.00 の対象、ダウンロードに機体のコードと利用許諾の同意が要る）で未入手。PTP の仕様は libgphoto2 の `camlibs/ptp2`（`ptp.h` / `config.c` / `library.c`）から。撮影先は `0x940A` / `0x940B`（0 = SD、1 = RAM、2 = 両方、`0x08000090` で読む）で Tethr には未実装。

### Tethr の自動テスト（2026-11-04）
`cd dev_modules/tethr && npm test`（vitest、ハード不要、2 秒）。koma の `yarn test` には含まれない。`src/test/fixtures/panasonicS9.json` は実機の S9 から読んだ生データ（シリアルは 0 に置換）で、`fakeS9.ts` が「リストに無い値は拒否」も含めて再生する。`PTPDevice.test.ts` は偽の `USBDevice`（応答の保留を再現）。テストは Panasonic と `PTPDevice`、機種判定だけで、Sigma / Canon / Theta のプロトコルと、ライブビューの画像取得（canvas が要る）は無い。`IFD.ts` が import 時に `window` に書くので、Node では `src/test/setup.ts` で stub している。

### Tethr の docs: Studio と Camera Check（2026-11-04）
`dev_modules/tethr/doc`（VuePress）。`npm run dev --w doc -- --port 5570` などで起動（8080 は aux と競合）。

- **Studio（`/studio`、`components/Studio.vue`）**: koma からタイムラインを抜いたサンプルアプリ。Tweeq の `App` / `TitleBar` / `PaneSplit` / `PaneZUI`、ライブビュー、撮影、オニオンスキン、コンタクトシート、フォルダ保存、ショートカット（Enter / L / F / O / Esc）。`PaneZUI` の中身はサイズを持たないので `@update:size` で与える。
- **Camera Check（`/report`、`components/CameraReport.vue`）**: 接続しただけでは何も動かさない（以前は自動で撮影していた）。項目を選んで実行。本体は UI と分けた `report/runChecks.ts`（設定は最大 12 値を書いて読み戻し、元に戻す。`focusDistance` / `focalLength` / `destinationToSave` は書かない。レンズの段に丸められた値は成功扱い）と `report/reportFile.ts`（ホワイトリストで組み立てるのでシリアルやファイル名は載らない）。
- **PR リンク**: `github.com/baku89/tethr/new/main?filename=&value=&message=&description=`（新規ファイル画面に流し込む。push 権限が無ければ fork 経由の PR になる）。**GitHub の URL は 4,000 文字は通るが 7,000 で 500**、なので `MaxUrlLength` は 4000、超えたら値を入れずクリップボードへ。S9 の全項目で約 2,400 文字。集まったレポートは `doc/reports/*.yaml` で、ページ下部の一覧になる。
- テストは `cd dev_modules/tethr && npm test`（core + doc）。doc のテストは本物の `TethrPanasonic` + S9 の偽カメラで `runChecks` を回す。
- **`linearly` を 0.21 → 0.33 に更新**（Tweeq に揃えた。古いままだと `PaneZUI` の `mat2d.inv` が無い）。Sigma が使う関数は新旧で結果が同じことを確認済み。**`TethrSigma` の `import {TethrPTPUSB} from '.'` は循環参照だったので `'./TethrPTPUSB'` に直した。** `TethrManager` はペア済みの機器をピッカーで選び直しても開き直さない（2 つの `PTPDevice` が同じエンドポイントを読み合っていた）。
- **未解決**: S9 の `getStorages` は `0x2008`（ID が `0x10000`）。MF でライブビュー中の撮影が 1 度だけ `No image arrived` で失敗した（原因不明、以後再現せず）。Create Pull Request のリンクは未ログインの GitHub で 302 まで（ログイン後の画面は未確認）。

### WebUSB PTP リロード復帰（2026-06-27, tethr `dd2081b` / koma `d90fe21`）
Sigma fp 接続中に koma ページをリロードすると再接続不能（connect が `transferOut ... A transfer error has occurred` で throw）だった問題。

**根本原因（PTP は WebUSB 上で stateful）:** リロード時ブラウザは `USBDevice` を OS レベルで強制 close するが (1) PTP `CloseSession`(0x1003) を送らないのでカメラ firmware はセッション継続、(2) 転送途中の bulk endpoint が **halted** のまま。次の `open()` で `claimInterface` は成功するが最初の `transferOut`（OpenSession コマンド）が halted OUT endpoint に対し **DOMException で reject**。

**既存復帰が効かない理由:** stall 処理は `transferOut` が `{status:'stall'}` で *resolve* した時だけ。ここでは promise が先に *reject* する。`usb.reset()` は USB 層をリセットするがカメラの PTP トランザクション状態はリセットしない（macOS では reject も不安定）。`beforeunload` の close は `async` でブラウザが await しない（unload 中に async USB 転送は完了不可）ので CloseSession-on-unload は設計上不安定。

**修正 = open() を self-healing に**（クリーン終了に依存しない）。`PTPDevice.open()` の `claimInterface` + endpoint discovery 後、最初の PTP コマンド前に:
1. USB Still-Image class **Device Reset Request**: `controlTransferOut({requestType:'class', recipient:'interface', request:0x66, value:0, index:interfaceNum})` — 進行中トランザクションを中断しカメラの PTP 状態機械をリセット（Dragonframe の Cmd+R reset / gphoto2 の `ptp_usb_control_device_reset_request` と同じ）。
2. `clearHalt('out', bulkOut)` → `clearHalt('in', bulkIn)`。
3つとも best-effort（各 try/catch）。Sigma fp で検証済（接続中リロードでクリーン再接続）。

NB: macOS `ptpcamera` デーモンの claim 競合（症状は `claimInterface` が "Unable to claim interface"、ptpcamera kill で解決）とは別物。ここは claimInterface 成功・転送のみ失敗。

---

## アセット保存（lazy-resolve モデル, 2026-06-26）
OPFS ハードコピー方式を lazy-resolve に置換（Phase 1+2 実装、実機 smoke test 済 2026-06-26、delete→undo 画像復元も確認）。

**撮影前の保存確認（2026-11-05）:** 撮ったコマはメモリの blob から表示するので、プレビューが動いていてもディスクにあるとは限らない。nn_mp で 212 コマが `Main/` に届かないまま再読み込みで失われた。Dropbox の版履歴では前日 11:03 から当日 19:22 のリロードまで project.json の版が一つも無い（Dropbox 自体は他のファイルを同期していた）ので、**その日は一度も保存が走っていない**: 実データのシミュレーションでは保存できたので、最も合うのは `autosaveSuspendDepth` の戻し忘れ（ウインドウ外で離した pointerup、confirm の来ない入力など。候補: TimelineDrawing の paper.js onMouseUp、timeline の zoom `confirmZoom`、markers の `endToolOptionEdit`）。これが起きると autosave・dirty・beforeunload の警告が同時に黙って止まり、ブラウザのメモリ（レンダラの一時ファイル、ブラウザプロセスのコア）からも画像は回収できなかった。対策: **30 秒を越える一時停止は番犬が強制解除**して開始時のスタックを `console.warn` し、`end*` は 0 未満にしない。撮影直後は `project.saveNow()`（debounce も一時停止も越えて保存、dirty を立てる）。そこで `shoot()` はシャッターの前に `project.ensureShotsOnDisk()` を通す: debounce と autosave の一時停止を越えて保存し、撮影済みの全コマを `assetReachedDisk`（ファイルを読み、blob とサイズ比較）で確かめ、短いか無いファイルは `rewriteAssetFromMemory` で書き直し、それでも駄目ならシャッターを切らない。保存の失敗は `project.saveError` に入り、alert と読み上げ、タイトルバーの "Not saved" で知らせ、5 秒ごとに再試行する。あわせて、撮りたてのコマが自分のファイル名を「使用中」と数えて `_tmp_N` 経由で 2 回書かれていたのを直した（`reconcileAssets` の `occupied` はフォルダに実在するファイルだけ）。

**Insert / Delete はレイヤー単位、Shift+クリックで範囲選択（2026-10-16 夕方）:** セルの「Insert」ボタンはそのセルの**レイヤーだけ**にコマを開ける（そのレイヤーのそれ以降のショットが 1 つ後ろへ。後ろへ動くショットがあるときだけ `confirm`。末尾への挿入は確認なし）。Delete キー / 右クリックの削除は選択範囲のショットを外して**そのレイヤーだけ**詰める。以前の「全レイヤーが空になったコマは消す」（他レイヤーに波及する）は廃止、代わりに末尾の完全に空のコマだけ切り詰める（`trimTrailingEmptyKomas`）。他レイヤー・`addsub.plan` / `cuts` / `_trash` の記録（コマ番号キー）は動かさない（ユーザー指定: plan / G-code はコマ番号に紐づけたまま）。撮影カーソルは同じレイヤーで後ろにあるときだけ追従。純関数は `src/utils/frames.ts`（vitest）、ストアは `project.insertFrames` / `project.deleteFrames`。**範囲選択**は `viewport.selectionAnchor` + `currentFrame`（`selectedRange` / `isFrameSelected` / `extendSelection`）。同じレイヤー上の Shift+クリックで伸ばす、別レイヤーならそのセルだけ。Delete / 右クリックの Clear は範囲に効く、Copy は現在コマ 1 つだけ（未対応）。**落とし穴**: Timeline の `pointerdown` は `appSelection.reserveUnselect` で選択解除を予約し（`setTimeout(0)`）、同じ tick の `select()` だけが取り消す → 選択を伸ばす経路でも `appSelection.select` を呼び直す（`registerShotSelection`）。呼ばないと Delete キーで選択だけ消えてショットが消えない。**さらに、本物のマウスでは pointerdown と click が別タスクなので、click の時点で予約した解除が既に走っていて `viewport.isShotSelected` は false になっている** → Shift+クリックの判定を `isShotSelected` に掛けると実機では一度も効かない（Playwright の `click()` は 1 タスク内で発火するので再現しなかった。2026-10-16 夜に発覚）。判定はカーソル（`currentLayer` が同じか）だけで行い、`extendSelection` は無条件に anchor（無ければ `currentFrame`）から伸ばして再登録する。Playwright で確かめるときは `mouse.down()` → 90 ms 待ち → `mouse.up()` のように分けて押す。**Delete の確認ダイアログ**: 範囲より後ろにそのレイヤーのショットがあれば（= 詰めると動く = 次の保存でファイルが付け替わる）`confirm`（「N shots after it move earlier… Use Cut (⌘X) to blank the cells without moving anything」）。レイヤー末尾の削除は確認なし。**性能**: `insertFrames` / `deleteFrames` は `beginInteraction` / `endInteraction` で括る（コマごとの反応的な書き込みで autosave と history の deep watcher がタイムライン全体を毎回走査し、197 コマ × 20 レイヤーで Delete 1 回に数秒かかっていた。`frames.ts` の `setShotAt` も変化の無い書き込みと null のための配列拡張をしない）。括った後は 200 × 20 で store 4 ms・描画まで 35 ms。確認は Playwright（偽ショット、Shift+クリック → Delete で 3 コマがそのレイヤーだけ詰まる、B の Insert で Main 不変、撮影スロット上の Delete は前のコマ、Undo で戻る）。

**読み込みの守り（2026-10-16 夜）:** `loadProject` の `loadShot` / `loadTrashedShot` は、json のショットに画像の参照が無ければアセットを登録しない（以前は `refFilename(...)!` で `filename: undefined` の entry を作っていた）。`reconcileAssets` も `filename` の無い entry を飛ばす。無いと保存のたびに `trashPath` → `dirnameOf(undefined)` で例外になり、**以後の保存が全部失敗する**（dirty のまま、スピナーが回り続ける）。参照が無いショットは、保存時に id を解決できなかった（RAM 上だけのアセットをリロードで失った等）ときにできる。

**ファイル名はプロジェクト名とレイヤー名を含む（2026-10-16 夕方、`project.assetLayout` 3）:** `<レイヤー>/<プロジェクト名>_<レイヤー名>_0001.jpg` / `.lv.jpg` / `.dng`、`_trash` は `<id>__` を頭に付けた同じ名前（例 `VICE_001 1/assembling-anew_VICE_001 1_0014.jpg`）。ユーザー指定: 番号だけの名前は Dropbox のイベント一覧や Finder で何のファイルか分からない。規則は `projectLayout.ts` の `namedAssetPath` / `assetFileStem`（プロジェクト名は `safeFileName` で掃除、レイヤー部分は `Layer.dir` をそのまま）。新規プロジェクトは 3。layout 2（フォルダ + 番号だけ、2026-10-16 の日中だけ存在）と 1（平ら）はそのまま開ける。移行は `scripts/migrate-layer-folders.mjs <dir> [--write]`（1 / 2 のどちらからでも rename だけ。**koma を閉じてから**）か Layers ダイアログのボタン（layout 2 では「Rename to project_layer_0001…」。実フォルダではコピーになる）。`hasLayerFolders(layout)` が「2 か 3」の判定。assembling-anew は 2026-10-16 16:33 に 3 へ移行済み。

**事故の記録（2026-10-16 14:09〜14:33、assembling-anew）— 保存中のリロードで連番の付け替えが繰り返され、各レイヤー末尾のコマが消えた:** セルの「Insert」ボタンの誤クリックで全レイヤーにコマが 2 つ入り（挿入は保存の最中で、project.json は「コマはずれて名前は古いまま」で書かれた）、次の保存が全レイヤーのコマ 6 以降を +2 に付け替え始めた（実フォルダは copy+delete、DNG 込みで約 13 GB、1 周 8 分）。1 周が終わる前にページが読み直されると古い project.json（古い名前）を読んでまた +2 するので、中身は 2 コマずつ上へ押し出され、末尾 2 コマ分が毎回消えた（VICE_001 1 は 4 周で 8 コマ消失）。EXIF の撮影時刻と `shot.captureDate` の突き合わせで中身のずれを確認。復旧は Dropbox API（`files/list_revisions` → 14:12 以前の最新版を `files/restore`、スクリプトは scratchpad の一時物）→ project.json から挿入コマを除去 → layout 3 へ rename。教訓: (1) 名前の付け替えが長時間になる実フォルダでは、json と ディスクが途中状態で乖離し、リロードで再適用されると壊れる。付け替えのジャーナル、または実フォルダでは保存時に付け替えない設計が要る（未実装）。(2) Insert は全レイヤーに効く 1 クリックのボタンだった（レイヤー単位 + 確認に変える予定）。

**レイヤーごとのフォルダ（2026-10-16、`project.assetLayout` 2）:** 画像はプロジェクト直下に `<name>_layer=N_0001.jpg` と平らに並べるのをやめ、**レイヤー名のフォルダ**に入れる: `Main/0001.jpg` / `Main/0001.lv.jpg` / `Main/0001.dng`、削除は `_trash/Main/<id>__0001.jpg`、addsub の G-code は `Main/gcode/0041_x.nc`。規則は `src/utils/projectLayout.ts`（`layerDirName` = 空白の正規化・禁止文字 → `_`・先頭の `.`/`_` 除去・大文字小文字を区別しない重複回避・koma の予約名 `_inbox` `_trash` `gcode` `led-wall` `previz` は避ける、`frameAssetPath`）。フォルダ名は `Layer.dir` に保存し、ファイル名からは何も読み戻さない（project.json の `filename` が全パス）。**レイヤー改名で `dir` も変わる**（Layers ダイアログの名前欄は確定時 = Enter / blur に `project.renameLayer`、1 文字ごとに同期すると実フォルダでは全コピーになるため）。改名の実体: `dir` を変えるだけで次の保存の reconcile が画像を動かす（`desired` のパスが変わる）、`_trash/<old>/` は `relocateTrashedAssets`、G-code は `project.onLayerFolderChanged` フック（addsub の sequence store が cuts の `file` を書き換えつつ `moveProjectFile`）、残りの未知ファイルは `renameLayer` が丸ごと移す、空になったフォルダは消す（`.DS_Store` が残っていると消えない）。大文字小文字だけの改名はフォルダを動かさない（`sameDirName`）。
- アセットストアの `filename` は **root（プロジェクト or `_trash`）からの `/` 区切りパス**になった（`walkPath`）。`reconcileAssets` はパスで比較し、移動で空になったフォルダを `removeVacated` で片付ける。`src/utils/assets.test.ts` がメモリ上の偽 FSA でこれを検証（trash → undo、改名、move() 無しの copy+delete、平らな旧レイアウト）。
- **旧プロジェクト（フィールド無し = layout 1）は開いても勝手に移さない**（`loadProject` が `assetLayout: 1` を明示。emptyProject との merge で 2 になるのを防ぐ）。新規ショットも平らな名前のまま。移行は (a) `scripts/migrate-layer-folders.mjs <dir> [--write]`（Node の rename だけ、バイトコピー無し。**koma を閉じてから**）か (b) コマンド `Move Images into Layer Folders…` / Layers ダイアログのボタン（`project.migrateToLayerFolders` + 保存。OPFS は `move()` で速いが、実フォルダは全ファイルの copy+delete になるので confirm で警告）。
- 取り込みスクリプト（`import-dragonframe.mjs` / `import-sequence.mjs`）は layout 2 で書く（`scripts/lib/layerDir.mjs` に `layerDirName` の移植。TS 側と揃えること）。`addsub-zstep.mjs` は `assetLayout` を見て G-code の置き場を切り替える。
- relay / exhibit は `filename` をそのまま相対パスとして扱うので無変更で動く（PUT はサブフォルダを作る）。古いビルドの koma 本体は `/` 入りのパスを開けないので、移行後のプロジェクトは新しいビルドで開く。

**as-built:**
- `src/utils/assets.ts` がランタイム AssetStore: `Map<id, {filename, parentDir, handle, blob?, url?, trashed}>`。`resolveBlob`/`resolveAssetUrl`（lazy getFile→キャッシュ object URL）、`registerDiskAsset`/`registerCapturedAsset`、`frameAssetFilename`、`reconcileAssets`、`clearAssets`。撮影 blob はセッション中 RAM 保持（再撮影でディスクスロット上書きしても undo 可達 id を壊さないため）。
- `Shot.lv/jpg/raw` は `string` id。`audio.src` は実 Blob（1ファイル、lazy read、WeakMap で毎autosave 再書込み防止）。
- project.ts `loadProject`/`saveProject` が `openBlobJson`/`saveBlobJson` を置換。**json 形式不変**（`{$type:'blob',filename}`）で後方互換。open = json parse + id 登録（バイトコピー無し）で高速。
- **Phase 2 = reconcile-in-save**: `saveProject` が json 書込み前に `reconcileProjectAssets`（autosave 毎 ~500ms debounce）。(1) 参照されなくなったファイルを `_trash/` へ `<id>__<filename>` 名で移動、(2) ライブフレーム資産を連番名へ **二相 temp**（`_tmp_<i>`→最終名）で rename（カスケード衝突防止）。undo で id が戻れば次 reconcile が `_trash` から復元。バックアップショットは保護（trash しない/rename しない）。`(handle as any).move()`（TS lib 外）+ copy+delete フォールバック。
- `opfs.ts` は新規プロジェクトの OPFS autosave 用 `localDirectoryHandle` のため残置（open/save コピー経路はデッドコード）。

**永続 trash 台帳（2026-06-26, データ層のみ・UI 未）:** `_trash` が削除写真の *メタデータ* をセッション跨ぎ保持（Dragonframe 風 restore が目標）。設計判断（ユーザー主導）: trash は「ever-captured − currently-live」の **派生集合**で、undoable スナップショットではない。結果（ユーザー明示の希望）: undo/redo はショットを live↔trash で *swap* する（撮影ショットは明示 purge まで失われない）。
- `Project.trash: TrashedShot[]`（`{shot, frame, layer, deletedAt}`）を project.json に追加（後方互換、旧ファイルは `[]`）。`UndoableData` には含めない。
- `syncTrash()`（project store、autosave watcher の callback から、settle 時に実行・burst 中は source collapse でスキップ）。`prevLiveShots`（Map<lv-id,{shot,frame,layer}>）と現タイムラインを diff。冪等（実変化時のみ mutate）。`deleteShot`/`setShot` は触らず、syncTrash が delete/再撮影上書き/undo-redo を一括吸収。
- assets.ts: `registerTrashedAsset(filename, trashDir)`、`reconcileAssets` に `trashedIds` 引数 + step "1b"（RAM のみの displaced バイトを `_trash` へ書く）。`TRASH_DIR` export。
- **未実装（合意の上 deferred）**: trash リストパネル、restore ボタン、empty-trash/purge。restore はあと一歩（TrashedShot を komas に戻せば次 reconcile が自動で `_trash` から連番名へ引く）。

**GOTCHA（load-bearing）:** `FileSystemFileHandle.getFile()` の File から作った object URL は *ディスク裏付けスナップショット*で、元ファイルが `move()`/rename/上書きされた瞬間に壊れる。Phase 2 は毎編集で rename + delete を `_trash` へ移すので、そのままキャッシュすると削除→undo（やシフト）したフレームがリンク切れ。対策: `resolveAssetUrl` は `createObjectURL` 前に `new Blob([await file.arrayBuffer()])` でメモリ内 detached Blob にする（content 不変なので snapshot は正しいまま）。LRU(500) で制限（タイムラインは仮想化）。同根のバグが audio にも（ロード済 File + 初回保存の自己上書き）→ audio はロード時に RAM detach + 保存済みマーク（`audioSavedDir`）。

**GOTCHA #2 — `move()` は Chrome では OPFS 限定（Chrome 149 確認）:** `FileSystemFileHandle.move()` は OPFS では動くが `showDirectoryPicker` 由来のハンドル（実プロジェクトフォルダ）では THROW。Phase 2 の byte-free rename はローカルフォルダで copy+delete に静かにフォールバック（`_tmp_#` ゴミの原因）。
- `moveEntry` は `move()` → `copyDelete` フォールバック。`copyDelete` は同一ディレクトリ rename でも source を消すこと（消さないと `_tmp_#` + 旧名残留）。`reconcileAssets` 末尾で `_tmp_*` を掃除。
- ローカルフォルダでの再連番はバイトコピー。append（何もシフトしない支配的ケース）は安い、中間 insert/delete のみ高い（tail を raw 含めコピー）。ユーザーは「リアルタイム自動再連番 + safety UI」を deferred より選好。

**Safety UI:** `project.dirty`（未保存編集あり）+ `project.isSaving`（`debounceAsync.isExecuting`、reconcile/copy 実行中）の直交 2 プリミティブ（4状態: saved/pending/writing/direct-save-as）。`beforeunload` は `isSaving || dirty` で警告（再連番中のリロードでフォルダ半端化を防ぐ）。TitleBar は単一 `IconIndicator`（`isOpening||isSaving||dirty` で spinner、他は Disk/Cache アイコン）。
- 残存リスク（未対応）: reconcile 途中のクラッシュ/kill でファイル半 rename + project.json（最後に書く）不整合。beforeunload 警告が緩和策（完全な transactional ではない）。

---

## 外からの編集: MCP / tools bridge（2026-10-23、`_inbox/` のファイル監視は廃止）
koma はプロジェクトをメモリに持ち、autosave で `project.json` を丸ごと書く。外から `project.json` を直接編集しても、動いている koma には見えず、次の保存で消える。**外部（Claude Code・スクリプト・Houdini）がプロジェクトを変えるときは、koma のツールを呼ぶ**。koma がメモリ上のプロジェクトに適用し、通常の autosave が保存する = `project.json` を書くのは koma だけ。**koma が開いていることが前提**（2026-10-01 からあった `_inbox/<name>.json` の 2 秒ポーリング・`applied` / `rejected` への仕分けは 2026-10-23 に削除。パッチの形式と all-or-nothing の検査はそのまま）。

- **経路**: ブラウザのタブは listen できないので、**aux（`yarn dev` / `yarn aux`、Electron 版は main に内蔵）が MCP サーバー `http://127.0.0.1:8090/mcp` を持ち、koma がそこへ `ws://127.0.0.1:8090/tools` で繋いで「ツールの提供者」になる**（`src/stores/tools.ts`、`dev_modules/aux-manager/lib/toolsBridge.js`）。aux はツールの中身を知らず、`tools/list` / `tools/call` を koma に転送するだけ。koma が後から繋いでも `notifications/tools/list_changed` で客に知らせる（セッション保持の Streamable HTTP）。複数の koma（dev と app の同時起動）は新しい接続が勝つ。koma 未接続のときの呼び出しは「koma is not connected…」で失敗。
- **Claude Code**: リポジトリ直下の `.mcp.json`（`koma` = `http://127.0.0.1:8090/mcp`）。`yarn dev` を立てて koma をブラウザで開けば、`get_project` → `set_plan` の順で使える。スクリプトは `POST http://127.0.0.1:8090/call {name, arguments}`（`scripts/lib/komaTools.mjs` の `callTool`。`addsub-plan-copy.mjs` / `addsub-zstep.mjs` の `--write` はこれで送る）。`GET /tools` / `GET /status` もある。
- **ツールの登録**は `registerTool({name, description, inputSchema, execute})`（`src/stores/tools.ts`）。`execute` の返り値が結果（文字列はそのまま、他は JSON）、throw でエラー。**inbox の op は `registerInboxOp(name, handler, {description, properties, required})` の第 3 引数を付けると snake_case のツールになる**（`setPlan` → `set_plan`。op を 1 つだけ包んだパッチとして `applyPatch` に通る。`onConflict` 引数が自動で付く）。`apply_patch` は複数 op をまとめて all-or-nothing。読み取りは `src/stores/projectTools.ts`（`get_project` = レイヤー id 一覧・撮影スロット・選択・`apply_patch` が受ける op 名、`get_shots`）と `src/addsub/tools.ts`（`get_plan` = 補間込み、`list_plans`、`get_cut`、`get_machines` = 両機の座標 + sequence + shoot alerts）。機械を動かすツールは**意図的に無い**（jog / cut / Go to Plan は人が押す）。
- **パッチ**: `{"version": 1, "note": "…", "onConflict": "reject" | "skip" | "overwrite", "ops": [{"op": "<名前>", …}]}`。全 op を先に検査し、1 つでも不可なら何も適用しない。既存データを置き換える op は conflict で、既定は reject。`skip` はその op だけ飛ばす、`overwrite` は置き換える（op 単位でも指定可）。handler は「検査して `{apply}` を返す」だけで、検査中は何も変えない。`apply()` は同期で、置き換えた値を返す（`result.ops[i].before`）。**変更は undo に乗らない**ので、戻すときは `before` から逆パッチを書く。`project.directoryHandle` が無い（保存前のプロジェクト）・開いている最中は null → ツールは「has no folder yet」で失敗。
- タイトルバー右の受け箱アイコン（`TitleBarInbox.vue`）: そのセッションでパッチを処理したら現れ、開くまで点灯。ツール経由は `tool:<name>`、relay 経由は `relay:<client>:<id>` の名前で載る。`alert()` は使わない。
- **relay 経由も残る（Houdini の Send Plans）**: `role=control` のクライアントが `{type:'control', topic:'inbox', data:{id, patch}}` を送ると `inbox.applyPatch` で即適用し `inbox:result` state で返す（`src/addsub/stores/houdini.ts`）。
- 登録済みの op: 汎用 `deleteLayer` / `deleteShots` / `moveShots` / `setCapture`（`src/stores/projectInboxOps.ts`）、addsub `setCut` / `clearCut` / `setPlan` / `clearPlan` / `moveLayerData`（`src/addsub/inboxOps.ts`、ADDSUB.md 参照）。
- 確認済（2026-10-23、`yarn dev --plain` + Chromium + MCP SDK の client）: 16 ツールの登録と list_changed、`set_plan` → `get_plan`、conflict の reject / overwrite / skip、可動域外の拒否、`apply_patch` の all-or-nothing、`get_shots` / `get_machines`、`POST /call`。**Electron 内蔵の aux（main バンドルは通る）と Claude Code からの実接続は未確認。**

---

## MP4 書き出し（2026-10-16）
コマンド **`Export MP4 (Range)…`**（`export_mp4`、File グループ）。範囲は **Shift 選択が複数コマならそれ、なければ in → out**（`project.previewRange`）。ダイアログで From / To / Fps（既定 = プロジェクトの fps）/ Hi Res を直せる。合成は Preview と同じ（アクティブなプリセットのレイヤーを現在レイヤーまで = `compositeLayers(currentLayer)`、`layerView` の opacity / blend、cover-fit）。オニオンスキンは入れない。**何も無いコマは前のコマを保持**（最初のコマより前は黒）、尺を変えない。Hi Res はカメラの JPEG（`shot.jpg`）で最初の 1 枚のサイズ、オフは lv でプロジェクト解像度。出力名 `<プロジェクト名>_<from>-<to>_<fps>fps.mp4`、`showSaveFilePicker`（無ければ download）。進捗はウィンドウタイトル、終わりに `buzz`。
- エンコーダは `src/utils/mp4.ts`（WebCodecs H.264 → VP9 / AV1 フォールバック + mp4-muxer、exhibit の `encode.ts` から移動。exhibit は re-export で従来どおり）。`EncodeSource.blob()` は Blob のほか ImageBitmap / OffscreenCanvas も返せる。合成は `src/utils/exportVideo.ts`（`exportFramesToMp4`）。
- **H.264 の level の罠（2026-10-16、実プロジェクトで「開けないファイル」）**: 以前の候補 `avc1.64002a`（High 4.2）は上限 8192 マクロブロック = 1920×1080 までで、**3:2 の 1920×1280（9600 MB）は `isConfigSupported` が false** → VP9 に落ちて、Chrome では再生できるが QuickTime で開けない MP4 になっていた（exhibit の動画もずっと VP9 だった）。今は `avc1.640033`（5.1）→ `avc1.64003e`（6.2）→ 4.2 → 3.1 の順。Chrome の H.264 エンコーダは **6000×4000 をどの level でも受けない**ので、`fitH264Size(w, h)` が長辺 4096 / 3840 / 2560 / 1920 / 1280 の順に縮めて最初に通るサイズを返す（Chrome 155 / Apple Silicon では 6000×4000 → 2560×1706。4096×2731 / 3840×2560 も不可 = 高さ 2304 超が駄目らしい）。それでも H.264 にならなかったときは保存後に alert（`onCodec`）。確認は Playwright の Google Chrome（本物の H.264 あり）+ ffprobe: lv → h264 High 1920×1280、Hi Res → h264 High 2560×1706。
- 確認はヘッドレス Chromium（メモリ上の偽ショット 12 コマ、1 コマ空き）: 0.8 s / 1920×1280 / 各コマの色 / 空コマの保持。**実プロジェクト（ディスクの lv、数千コマ）での時間とメモリは未確認**（コマごとに decode → 合成 → encode、encoder のキューは 8 で抑える）。
- Tweeq の `InputComplex` は scheme の `label` を入力にも `v-bind` で渡すので、`type: 'boolean'` に `label` を付けるとスイッチの横にも出て 2 重になる。キー名からの自動ラベル（`Case.capital`）に任せる。

---

## ホールドと動画の取り込み（2026-10-27）
**ホールド（Dragonframe の hold）:** `Shot.hold`（コマ数、無し / 1 = そのコマだけ）。ショットは自分のコマから `hold` コマのあいだ画面に残る。**保存は origin のセルだけ**で、続きのセルは `komas` 上では null のまま（保存・reconcile・trash 台帳・insert / delete はこれまでどおり「1 ショット = 1 セル」を見る）。「このコマに何が映るか」は `project.shot(frame, layer)` が解決する（`utils/frames.ts resolveShotAt`: セル自身のショット、無ければ前のショットのホールドが届いていればそれ。ホールドの途中にショットを置くとそこで切れる）。生のセルは `project.cellShot`、origin と held の別は `project.shotOrigin`。Preview / 再生の先読み（`PreviewPlayback`）/ キャスト / タイムラインは `project.shot` 経由。**raw のまま**: exhibit（held コマは空に見える）、`TimelineGraph`、`AddsubVisualizer` の軌跡、relay の push。
- 操作: `]` = Hold +1 / `[` = Hold −1 / 右クリック「Set Hold…」（`viewport.changeHold` / `promptHold` / `setHoldTo` → `project.setHold`）。カーソルが続きのコマにあっても origin に効く。伸ばすと後ろのショットが動く（Insert と同じで、動くときは confirm）、縮めると詰まる（Delete と同じ）。伸ばしたあとカーソルはホールドの末尾へ（`]` 連打で端を引っ張る感じ）。
- 編集との関係: 続きのコマで Delete → そのホールドが 1 縮む（`deleteFrames`）、origin を Delete → span ごと消える（`viewport.deleteShot` が範囲を span まで広げる）、Cmd+X（clear）→ そこでホールドが切れる、ホールドの途中に Insert → ホールドが伸びる、途中に撮影 / paste → ホールドはそこまでに縮む（`setShot` が明示的に書く）。撮影カーソルの前進（`placeShotAndAdvance`）は held コマを飛ばす。
- 表示: 続きのセルはサムネイルを 40% + 上端のバー（`.captured.held`）。×N のバッジはユーザー指定で無し。ツールチップに `Hold: 3 frames (#10–#12)`。
- 確認: vitest（`frames.test.ts`）+ Playwright（`]` `[` / Delete / Cmd+X / 途中への setShot / undo）。**実フォルダでの保存（held コマは空セルなので何も書かれない）・exhibit の見え方は未確認。**

**動画のドロップ → ガイド画像（`src/stores/videoImport.ts`, `src/utils/videoFrames.ts`）:** セルに `.mov` / `.mp4` / `.webm` / `.mkv` などを落とすと、**動画の fps に関係なく格納されている 1 フレーム = 1 コマ**として、そのセルからそのレイヤーに `setShot`（既存は置き換え、confirm に件数を出す。複数の動画は続けて並ぶ）。jpg = フレームの JPEG そのまま、lv = プロジェクト解像度に cover でリサイズ、`shot.source = {file, frame}`（ツールチップの Source）。24 コマごとに `beginInteraction` でまとめ、**`project.flushSave()` で保存してから次を読む**（アセットは `registerCapturedAsset(..., {transient: true})` = 書いたら blob を捨てる。3000 コマを RAM に抱えないため）。進捗はウィンドウタイトル、Esc で中断（それまでの分は残る）。
- **読み手は 2 つ**: **aux（`yarn dev` / `yarn aux`、Electron 版は main 内蔵）が ffmpeg を動かし、tools bridge の HTTP（8090）で流す**（`dev_modules/aux-manager/lib/video.js`、`toolsBridge.js` にルート）: `POST /video` に JSON `{path}`（Electron は `webUtils.getPathForFile` でパスが分かる）か生のバイト列（ブラウザは File を upload、`x-koma-name` ヘッダ、temp に置く）→ `{id, frames, fps, width, height, codec}`、`GET /video/<id>` が `-fps_mode passthrough -f image2pipe -c:v mjpeg` の MJPEG ストリーム（`pipe()` の back-pressure で、renderer が読まないあいだ ffmpeg は待つ = 先読み無し）、`DELETE /video/<id>` で止めて temp を消す。renderer は `fetch` の `ReadableStream` を `utils/jpegStream.ts`（SOI / EOI で切る、vitest）で 1 枚ずつ取り出す。ffmpeg は PATH / `/opt/homebrew/bin` / `/usr/local/bin` / `KOMA_FFMPEG`（GUI アプリはシェルの PATH を継がないので明示的に探す）。**ProRes はこちらだけ**。aux が無い（接続できない / 404 / 503）ときだけ、隠し `<video>` を `requestVideoFrameCallback` で 1.5 秒再生して fps を測り（よくある値に 2% で吸着）、`(i + 0.5) / fps` にシークして canvas → JPEG。Chromium が decode できない形式は「ProRes needs ffmpeg: run yarn dev / yarn aux, or use the desktop app」。**aux のコードを変えたら `yarn dev` を立て直す**（古い aux には `/video` が無く、ブラウザ経路に落ちて ProRes が decode できない = 2026-10-27 に実際に踏んだ）。
- **重複コマを外した動画と AE の Time Remap（`scripts/video-dedupe.mjs`、2026-10-27）**: ホールドの代わりに、`node scripts/video-dedupe.mjs <in.mov> [--fps 24] [--threshold 0.05] [--analyze] [--out dir] [--force]` で **同じ絵が続くコマを落とした `<name>.dedupe.mov`**（ProRes、ソースと同じプロファイル、`--fps` = 24 の CFR。1 コマ = 撮る 1 ショット）と、**`<name>.remap.txt`**（AE の Keyframe Data。元のコマ番号 i → 撮ったショット u(i) の時刻 `u/24`。元と同じ fps のコンポで、24fps として読み込んだ撮影データのレイヤーの Time Remap を選んでペースト）、`<name>.dedupe.json`（`unique[]` = 元コマ → ショット番号、`runs[]` = ショットごとの元の範囲とホールド長）を書く。重複の判定は 1/4 サイズのグレーで **前に残したコマと比べて 24 階調より動いた画素の割合** が `--threshold` % を超えたら新しい絵。レンダー / 無劣化キャプチャは複製が 0 % ちょうどで、小さな葉 1 枚の動きでも 0.05 % 以上あった（`MP_part.mov`: 321 → 221 コマ。最初に平均差分 1.0 で切ったら、葉だけ動くコマまで落ちていた = 平均差分は小物の動きを見落とす）。ノイズのある素材は `--analyze` で「落としたコマの最大 / 残したコマの最小」の余裕を見て閾値を上げる。確認は全 321 コマについて 元コマ i と dedupe の u(i) の一致（再エンコード差 0.04 以下）と、remap の行が `unique[]` と一致すること。**AE に実際にペーストしての確認は未。**
- `?aux=http://127.0.0.1:8091` でページの aux を差し替えられる（`stores/tools.ts` の `AUX_HTTP_URL`、tools bridge の ws もここから作る。テストや 2 つ目の koma 用）。
- 確認: Node で `/video` のルートを実物の ProRes（1920×1080 / 23.976 / 321 コマ、パス指定で 1.1 秒）・upload・途中キャンセル（ffmpeg が残らない）・DELETE（temp が消える）、ブラウザ（Playwright の Chromium、H.264 無し）で ProRes 36 コマを upload 経由で #2–#37 に。**Electron での実際のドロップ（sandbox の preload で `webUtils` が使えるか = 使えなければ upload に落ちるだけ）、長い ProRes の所要時間と RAM は未確認。**

---

## レイヤーの合成と表示切替（2026-10-27）
- **Preview / キャスト / MP4 書き出し / 再生の先読みは、アクティブなプリセットで表示になっている全レイヤーを合成する**（`project.compositeLayers`）。それまでは「現在レイヤーまで」で、上にあるレイヤーは出なかった = Main の撮影コマで、上に Difference で載せた Guide が Preview に出ない（nn_mp で発覚）。非表示のレイヤーは、現在レイヤーや撮影レイヤーであっても出さない（Main を消して Guide だけにすると、撮影コマでもライブビューは出ず Guide だけになる。最初は「現在レイヤーが非表示ならそれ 1 つ」の例外を残していて、Main を消すとライブビューだけ / 真っ黒になった）。
- **ソロ（2026-11-02）**: `project.solo`（セッション限定、保存しない）がオンのあいだ `compositeLayers` は**撮影スロットのレイヤー 1 つだけ**を返す（プリセットで非表示でも出す = ミキサーのソロがミュートに勝つのと同じ。撮影スロットが別レイヤーへ移れば追従）。Preview / キャスト / 再生 / MP4 書き出しの 4 経路とも同じ関数なので全部に効く。タイトルバーの Hi-Res の隣の `S` アイコン（`mdi:alpha-s-box-outline`）とアクション `toggle_solo`（キー **`s`**）。タイムラインは `project.isLayerShown(index)`（ソロ中は撮影レイヤーか、それ以外は目の状態）で行名とセルを薄くし、目のアイコン自体はプリセットの状態のまま。**現在レイヤー（選択セルのレイヤー）の目を切り替えるアクション `toggle_layer_visibility`（キー **`shift+h`**、`h` は Frame All で使用済み）**も同日に追加。確認は Playwright（5557、Main + Guide）: `s` で Guide の行とセルが薄くなる、Main を目で消してもソロ中は表示扱い、もう一度 `s` で戻る。
- **タイムラインの左端にレイヤーごとの目のアイコン**（`Timeline.vue` の `.layer-eye`、`project.setLayerVisible`。Layers ダイアログの Show と同じもの = アクティブなプリセットの `hidden`）。**目（一時的な表示）とタイムラインの行の有無は別物**（2026-11-03、ユーザー指定。同日に一度「非表示なら行も消す」にしたら、目を押した瞬間に行が消えて戻せなかった）: プリセットの stack の項目に `hidden`（目）と `timeline`（行）。目を押しても行は残り、薄くなるだけ。行を外すのはバルーンの「Remove from Timeline」、戻すのはレイヤー名の列の下の「+ N more」のリスト（`project.setLayerOnTimeline`）。Layers ダイアログには Blend / Opacity / 行の有無を置かない（ユーザー指定。Blend と Opacity はバルーン）。`timeline` が無い項目（古いファイル、非表示で追加されたレイヤー）は `!hidden` と同じ（`isOnTimeline`）で、目を押した時点で今の状態を `timeline` に書いて固定する。例外は**撮影レイヤー**で、Timeline を切っても行が残る（`project.timelineLayerIndices`。撮影スロットを見失わないため。バルーンのボタンも無効）。選択中のレイヤーの行が消えたら選択は撮影レイヤーへ移る（`viewport.ts` の watch）。↑↓ もこの行の順に動く。
- **レイヤーごとのアフィン変換（2026-10-27）**: プリセットの表示設定 `LayerView.transform = {scale, x, y, rotate}`（`src/utils/layerTransform.ts`。scale は倍率、x / y はコマの幅 / 高さに対する %、rotate は度・時計回り。コマの中心で拡大・回転してからずらす）。編集はレイヤー名の右のバルーン（下記。Layers ダイアログの列は 2026-11-03 に削除、幅が足りずラベルが隠れていた）（`project.setLayerTransform`。恒等になったら項目ごと消して旧ファイルと同じ形に戻す）。描く側は 4 経路とも同じ関数: Preview は CSS `transform`（`layerTransformCss`）、キャスト / 再生 / MP4 書き出しは canvas の `applyLayerTransform`（`save` / `restore` で囲む）。ライブビューも撮影レイヤーの変換で動く。タイムラインのサムネイルには掛けない。確認は vitest（`layerTransform.test.ts`）+ Playwright（Scale 80% で `.PreviewKoma .layer` の transform と保存値）。**キャスト / 再生 / 書き出しの実画は未確認。**
- **Preview が 2 枚目以降のレイヤーの blend / opacity / transform の変更に追従していなかった（2026-10-27、「Normal 50% が透けない」）**: `PreviewKoma.vue` の `layers` は `asyncComputed` で、**最初の `await` より後に読んだ reactive な値は依存に入らない**。`project.layerView(layer)` をループの中（前のレイヤーの `resolveAssetUrl` を await した後）で読んでいたので、1 枚目以外の設定を変えても再計算されず、コマを動かすまで古い見た目のままだった。今は全レイヤーの shot / view / `enableHiRes` を await の前にまとめて読む。CSS の合成自体（`<video>` の上に Difference、その上に Normal 50%）は単体ページでピクセル値まで確認して正しい。**`asyncComputed` に reactive な読みを足すときは await の前に置く。**
- **レイヤー名の右のスライダーアイコン（常時表示）か行の右クリック → バルーン（`Timeline/LayerViewPopover.vue`）**: Blend / Opacity / Scale / Position / Rotate を Layers ダイアログを開かずにモードレスで編集（`Tq.Popover` + `arrow`、`right-start`、外クリックで閉じる。2026-11-03 にホバーでの出し入れをやめた。アイコンを消して右クリックだけにしたら入口が分からず「弄れなくなった」となったので、アイコンは常時表示に戻した）。macOS の contextmenu は押した瞬間に出るので、離したあと 50 ms ずらして開く（pointerup の light dismiss で閉じるため）。**レイヤー名の列の幅**は右端のドラッグで変える（`timeline.layerColumnWidth`、app config、60–480 px、既定 160）。ダブルクリックで一番長い名前に合わせる。X / Y は 1 行の Position（`Tq.InputVec`）。確認は Playwright（開く / 値が保存とプレビューに即反映 / 外クリックで閉じる）。
- **レイヤーは contain で合わせる（2026-10-27、ユーザー指定）**: Preview の CSS（`object-fit: contain`）、キャスト / MP4 書き出しの `drawContain`、再生 canvas（以前は引き伸ばし）の 4 経路すべて、`utils/fit.ts fitContain` で全体を収める（アスペクトが違えば黒帯）。**lv の生成も contain**（`resizeBlobImage(…, 'contain')` = 全体をプロジェクト解像度に収まる大きさに縮めるだけで、パディング無し。例: 1920×1080 のガイドは 1920×1280 のプロジェクトで 1920×1080 のまま）。撮影・ペースト・動画取り込み・`ensureLv` の 4 か所。以前の cover で切り抜かれた lv は `node scripts/regen-lv.mjs <project> [--layer Guide]`（ffmpeg で jpg から作り直す。project.json は触らない、終わったら koma をリロード）。nn_mp の Guide 221 枚は 2026-10-27 に作り直した。
- **EXIF Orientation（2026-10-27）**: カメラを横に付けると JPEG に `Orientation: Rotate 90 CW` が入り、Hi-Res の `<img>` とエクスポートはそれを適用、lv は画素そのまま、で 90° 食い違っていた。(1) 撮影時に `utils/exif.ts resetExifOrientation` で **Orientation だけを 1 に書き換えて保存**（EXIF 全体は残す。撮影時刻は復旧に使った実績があるので消さない。vitest あり）。(2) 保険として Preview の Hi-Res は `image-orientation: none`、MP4 書き出しの `createImageBitmap` は `imageOrientation: 'none'` = koma は常に画素のまま出す。既存ファイルは `exiftool -overwrite_original -n -Orientation=1 -if '$Orientation and $Orientation# ne 1' -r -ext jpg <project>`（lv は EXIF が無いので対象外。nn_mp の 4 枚は 2026-10-27 に処理済み）。**DNG も同じ**（TIFF の IFD0、`DNGVersion` のあるファイルだけ。先頭 1 MB だけ読んで差し替えるので 40 MB の DNG もコピーしない）。既存の DNG は `-ext dng` で同じ exiftool（nn_mp の 8 枚は処理済み）。
- **ショットのカメラ設定を今のカメラへ（2026-10-27）**: 以前からある `apply_exposure_from_koma`（Apply Exposure from Selected Koma = exposureMode / aperture / shutterSpeed / iso / exposureComp / whiteBalance / colorTemperature）と `apply_exposure_from_prev_frame`（`p`）に加えて、**`apply_camera_from_koma`（Apply Camera Settings from Selected Koma = 露出 + focusDistance）**。どちらも `shot.cameraConfigs` から `tethr.importConfigs`（`App.vue applyConfigsFromShot`。focalLength は読み取り専用かつレンズ表で上書きされるので送らない）。**ショットの右クリックの先頭に 2 つとも出る**。カメラ無し / ショット無し / 記録無しは alert。フォーカスモードが Target のときは送った focusDistance がすぐ上書きされる。
- 確認は Playwright（5555）: 撮影コマで Main のライブビュー + 上のレイヤーの Difference が `.PreviewKoma` に並ぶ、目で消すと消え、戻すと戻る、非表示の行が薄い。

## Preview の落書き（2026-11-03）
Pencil / Eraser ツール（タイムラインと同じ `timeline.currentTool`、キー `g` / `e`）で Preview の上にも描ける。今は**どのコマでも常に最前面に出る 1 枚**で、コマ・レイヤーには紐づかない（ユーザー指定「ひとまず」）。データは `project.viewport.drawing`（`{color, d}[]`、`d` はコマのピクセル座標の SVG パス文字列。配列だと deep watcher が毎回全点を歩くので文字列）、undo に乗る。描画は `Preview.vue` の `.frame` 内の `svg.drawing`（`.frame:before` の暗幕より上の z-index 11、ズームしても線幅は画面上 2 px）、操作は `use/usePreviewDrawing.ts`。

- **Paper.js を使っていない理由**: `new paper.Path` が属する project とツールのイベントは PaperScope で決まり、タイムラインが global scope を使っているので、もう 1 枚の canvas を足すと混ざる。
- 描いている間はプロジェクトに書かず、離したときに 1 回だけ書く（1 ストローク = undo 1 回、何も消さなかった消しゴムは undo に積まれない）。
- `.drawing-input`（ツール中だけ出す透明な面）が `.frame` の click = オートフォーカスを防ぐ。useZUI が左ボタンで wrapper に pointer capture を取るので、move / up は window で聞く。中ボタンのパンとスクロールのズームはツール中も効く。
- **入らないもの**: キャスト（`previewCast.ts`）と MP4 書き出し（ガイドの overlay と同じ扱い）。
- 確認はヘッドレス Chrome: コマ座標、描画、消しゴム、undo / redo、OPFS の project.json に保存されリロード後も残る。実フォルダのプロジェクトとペン入力は未確認。

## Preview レンダリングの二経路
Preview パネルは意図的に2経路: 一時停止/スクラブ/Hi-Res/onionskin/live-view は DOM 経由（`PreviewKoma.vue`、`<img>`/`<video>`）、再生は事前 decode 済 ImageBitmap canvas 経由（`PreviewPlayback.vue`、commit 6f286e2、毎フレーム JPEG decode 回避）。

2026-06-25 にパネル全体を単一 `<canvas>` 化（guides/letterbox は SVG overlay 維持）する案を議論し、ユーザーは **deferre を選択**。
- **理由:** 実現可能だが中規模リライトで回帰リスク。難所: (1) colored onionskin = 毎フレーム offscreen の "multiply tint → screen" 合成、(2) live view は live 中 persistent `<video>` + rAF draw loop、(3) **本当のブロッカー** = Hi-Res ズーム詳細: 今は camera-native jpg を出すので ZUI ズームでプロジェクト解像度超の焦点詳細が見える。固定解像度 canvas backing はこれを回帰させる（保つには transform 変化毎に表示ピクセルサイズで再ラスタライズ要）。
- **方針:** 二経路を「掃除すべきゴミ」と勝手に扱わない。再訪するなら単一 `PreviewRenderer`（再生キャッシュを1モードとして吸収）、canvas を現 `.frame` + CSS transform に残して ZUI/AF 座標を維持、Hi-Res 再ラスタ方式を先に決める。

**Preview のキャスト（2026-10-01）:** relay の画面へ送る映像は `src/stores/previewCast.ts` が Preview と同じ合成（`PreviewKoma` のレイヤー列、`Preview.vue` の重ね順、オニオンスキン、tint、zoom）を canvas に描き直したもの（DOM は stream にできないため）。**`PreviewKoma.vue` / `Preview.vue` の合成を変えたら previewCast も合わせる。** 再生中は `PreviewPlayback` の canvas をコピー。視聴中の画面があるときだけ描く。詳細は ADDSUB.md「Preview のキャストと最後の映像の保持」。

**再生 canvas の先読み（2026-10-01）:** 以前は再生開始でキャッシュを空にしてから decode を始めていたので、最初の 1 周は decode が再生位置に追いつくまでコマが止まって見えた。今は (1) bitmap キャッシュのキーを `frame:layer` でなく **lv のアセット id** にして再生/停止をまたいで保持、(2) **停止中も**再生が始まる位置（`currentFrame`。ループ無しで out-point にいるときは in-point）から 24 コマを先に decode（再生位置が 150 ms 落ち着いてから、並列 4）、(3) `viewport.setPlaybackPreroll()`: 再生開始時、最初の 0.5 秒ぶんが decode 済みになるまで時計と音を止めて待つ（上限 1.5 秒。ジャンプ直後に再生したときだけ効く）。decode するのは合成対象のレイヤー（`compositeLayers`）だけ。decode できない id は `failed` に入れて次の restart まで飛ばす（以前は同じコマを延々と取り直していた）。確認は Playwright（メモリ上の 80 コマ、先読み後 / ジャンプ直後 / out-point から）で表示遅れ 0。**実フォルダの lv、lv が無くて hi-res から作り直す場合は未確認**（後者は先読みの 24 コマより先で追いつかない可能性が残る）。

---

## 連続編集の性能（deep watch source collapse）
`project.ts` は大きな state に `{deep:true}` watcher を2つ: `autoSave`（`pausableWatch` で `project` 全体）と `useRefHistory`（`undoableData`、`komas` 含む）。1px マーカー nudge や wheel-zoom tick（`project.timeline.zoomFactor` 書込み）でも **両方が `komas` を再走査**し、大プロジェクトで連続編集が ~200ms/tick に。

**自明な対策が失敗する理由:** @vueuse の `pausableWatch.pause()` / `useRefHistory.pause()` は eventFilter で **callback だけ**を止める。下の `watch(source,…,{deep:true})` の getter（`traverse(source)`）は毎変化で走る。pause は save/cloneDeep は飛ばすが deep 走査は飛ばさない。

**効いた修正:** burst 中に watch の *source* を定数に collapse（reactive フラグで gate）し、watcher が `project`/`komas` から完全に unsubscribe:
- `autoSave` source: `() => autosaveSuspendDepth.value > 0 ? null : project`
- `undoableData` getter: `historyBatching.value` の間 `null` を返す
- `beginInteraction/endInteraction`（undoable: marker/drawing）は両方 suspend + history を1エントリだけ commit。`history.resume()` を使う（`resume(true)` ではない。null→real の遷移が既に1 commit を schedule するので手動 commit は重複する）。
- `beginAutosaveBatch/endAutosaveBatch`（非 undoable: zoom/pan）は autosave のみ suspend（depth counter でジェスチャ重複可）。history は触らず no-op undo を作らない。
- wheel-zoom は pointer-up が無いので `Tq.Timeline`(tweeq) が frameWidth settle 後に debounce `confirm` を emit。koma は最初の書込みで batch を開き `@confirm` で閉じる。settle/debounce は tweeq 側に置く。

**方針:** 今後「per-frame watch が重い」ケース（pan/scrub/他の連続パラメータ）は `beginAutosaveBatch/endAutosaveBatch` を再利用し、tweeq 入力に settle で `confirm` を emit させる。hot-path の deep 走査を殺すのに `pause()` を使わない。

---

## クリップボード（ショット cut/copy/paste, 2026-06-26）
既存の context ベース selection store（`selection.ts`、cmd+C/X/V → `onCopy/onCut/onPaste`）経由。`viewport.selectShot()` が 'shot' context にこれらを登録。コピー単位 = 選択ショット（currentFrame+currentLayer）、paste = 現セル上書き、cut = copy + deleteShot。
- **Copy**: フル解像度 `image/png` をシステムクリップボードへ（Discord 等が低解像 lv でなく実画像を得る）+ アプリ内 `clipboardShot = {sig, shot: cloneDeep(shot)}`。
- **Paste**: `navigator.clipboard.read()`。署名が `clipboardShot.sig` 一致 → リッチ復元（`resolveBlob`→`registerCapturedAsset` で資産複製して独立化、`setShot`）。不一致 → 外部画像 import（jpeg 正規化 + `resizeBlobImage` で lv、最小メタデータ）。
- `reencodeImage`/`imageSignature` は `utils/image.ts`。

**Web Clipboard の落とし穴（Chrome 149 で実証。信用前に再確認推奨だが強烈に効いた）:**
1. **`image/jpeg` は書込み不可** — `ClipboardItem.supports('image/jpeg')` は false、書込みは `NotAllowedError`。元 JPG をクリップボードに保持は Web API では不可能。PNG（フル解像、可逆ピクセル）のみ。
2. **`web ...` カスタム形式は `navigator.clipboard.write` を HANG させる** — `ClipboardItem.supports('web application/x-koma-shot+json')` は true（誤解を招く！）だが `write([new ClipboardItem({'image/png':png, 'web ...':marker})])` は resolve しない → 画像も載らない（"コピー出来てない" バグ）。修正: 画像単独で書く。
3. **クリップボードは画像を再エンコードする** ので自前マーカーを運べず byte/hash 一致も不可。→ 再エンコード安定な縮小署名で相関（`imageSignature`: 16×16 grayscale, 4-bit bucket。同一画像→等しい、JPEG↔PNG 跨ぎ生存）。
4. 外部 paste ショットは `cameraConfigs` 無し → `Object.entries(shot.cameraConfigs)` がクラッシュ（`TimelineShot.printShotInfo`、黒サムネ化）。メタデータアクセスは guard。

クリップボード write/read 失敗時の `console.error` は維持（`eslint-disable-next-line no-console`、無言失敗は悪い UX）。

---

## Popover / floating-vue 撤去（完了）
koma は floating-vue を段階的に外し Tweeq 側の native Popover（HTML Popover API + CSS Anchor Positioning + `@starting-style` フェード）に統一済み。理由: floating-vue は `opacity .15s` フェードがハードコードで遅い。Electron 34 = Chromium 132 で Popover API / CSS Anchor / `@starting-style`+`allow-discrete` が全部使える。

**標準パターン:** native popover を `:popover-open` + `@starting-style{…:popover-open{opacity:0}}` でフェードイン。開き = `--tq-active-transition-duration`（64ms、`stores/theme.ts`、ユーザー好み）。閉じは `allow-discrete` なしで瞬時。

**位置決めも純 CSS:** `anchor-name`/`position-anchor`/`anchor()`、flip/shift = `position-try-fallbacks`、隙間 = `margin`、スクロール追従はブラウザネイティブ（`autoUpdate` 不要）。**注意: stylus は `anchor()` を関数解釈するので inline style 必須。** `.Popover{position:fixed; inset:auto}`。

**Balloon chrome（SVG 輪郭）:** `dev_modules/tweeq/src/Balloon/Balloon.vue`。backdrop-filter blur + 枠線 + 矢印を継ぎ目なく両立（`corner-shape`/`clip-path:shape()` は Chrome 137/139 で 132 未対応のため）。`.fill`(blur+surface, `clip-path:path()`) と `<svg><path stroke>` が同一生成パス共有。矢印 side/offset は flip 後の確定ジオメトリを `getBoundingClientRect` 実測してパス生成へ（CSS `anchor()` を path 文字列に注入できないのでここだけ JS ~15行）。

**全フェーズ完了（floating-vue も @floating-ui/vue も完全撤去 = Tweeq に位置決めライブラリ無し）:**
- Popover に 64ms フェード（Menu/InputDropdown へ波及）。
- Popover を CSS Anchor 化（API 維持、vec2 分岐温存。InputDropdown は vec2 で無傷）。
- `arrow` prop（true で slot を Balloon 包み、矢印実測）。カメラ popup に適用。
- singleton tooltip（`Tooltip/` 一式、`v-tooltip` ディレクティブ）。落とし穴: Tweeq の CSS リセット（font 等）は `.TqViewport` 内のみ → tooltip は外なので `Popover` に `teleport?: string` prop 追加し `teleport=".TqViewport"`。初回ホバーで右上に出る問題 → `anchorName?` prop + 固定名 `--tq-tooltip` を `mouseenter` で即付与（leave で除去しない、閉じ中も anchor 維持）。
- 最後の `vDropdown`(CNC)/`MultiSelectPopup` も移植して依存削除。`MultiSelectPopup` は `focusedElement` に固定 `--tq-multi-select-anchor` を付与し `anchor(bottom)`/`anchor(right)` を inline で。
- 注: tweeq standalone `yarn.lock` に `@floating-ui/vue` entry が残るが root lockfile 優先で実害なし。

submodule の tweeq を編集する形がユーザー希望。

**モーダルの Esc / Enter と「入れ子のポップオーバー」判定（2026-10-15）:** `PaneModalComplex` / `PaneModalTabs` は「モーダル以外の popover が開いていたらドロップダウンやメニューが開いているとみなして Esc / Enter を譲る」が、以前は `:popover-open` の個数 > 1 で見ていた。shoot alert のバルーン（`popover="manual"`、カメラ未接続などでほぼ常時開いている）・tooltip・multi-select ポップアップも数に入るので、**アラートが出ている間はモーダルが Esc でも Enter でも閉じなかった**（Done / Cancel のクリックだけ効く）。今は `Popover` が **reference がモーダル（`.TqPaneModal`）の中にあるとき** 自分に `data-tq-nested` を付け（`passive` prop の tooltip は付けない）、`PaneModal/nested.ts hasNestedPopover()` はそれだけを見る（`popover="auto"` で判定するのは駄目: InputDropdown / Menu は lightDismiss false = manual）。`InputDropdown` は Esc を自前で処理するようにした（開いていれば閉じて開始時の値に戻す。`.stop` 付き — 閉じる watch が window のリスナーより先に flush されるので、止めないと同じ Esc でモーダルも閉じる）。確認は別ポートの vite + ヘッドレス Chromium（**5555 の dev サーバーは `types.ts` に足した prop を拾わず `passive` が効かなかった** = 型由来の props のキャッシュ。Popover の props を変えたら vite を立て直す）: アラート表示中に Layers を Esc / Enter で閉じる、モーダル内のボタンの tooltip が出ていても Esc で閉じる、モーダル内ドロップダウンの Esc はドロップダウンだけ閉じて 2 回目でモーダル。

**`Tq.InputArray` / `Tq.TableHeader`（2026-11-04）:** `InputArray` は配列の編集全般の部品。`v-model` + `itemKey`、中身は default slot（`{item, index, dragging}`）、できることはオプションで決める: `sortable`（ドラッグのハンドル）/ `removable`（削除ボタン。true か `item => boolean`）/ `appendable`（`create` で作る Add ボタン、`add` slot で差し替え可）。編集はすべて `update:modelValue` で届き、`add` / `remove` イベントがどの編集かを言う（配列が別の何かの見え方でしかない親のため）。`live` を付けるとドラッグの一歩ごとに `update:modelValue`、無ければ離したときに 1 回（`confirm` は編集の完了時）。pointercancel は取り消し。掴んだ行はポインタに追従し、他の行は WAAPI の FLIP で滑る（`TransitionGroup` でなくこれなのは、掴んだ行の inline transform と競合せず、途中の動きからそのまま続けられるため）。新しい行はフェードイン。Pointer capture はリスト側に取る（行は Vue が DOM を動かすと capture が外れる）。グリッドの中ではリストも行も subgrid で親の列に乗るので、`ParameterGrid` の中で `Parameter` を並べられる。ハンドルと削除ボタンは行の両端の余白にぶら下がり列を取らない。削除ボタンは丸い outline に × で、ホバー時だけ `--tq-color-error` で塗る。行の間隔は `InputArray` 自身が `--tq-gap-control` を持つ。行き先の計算は `InputArray/utils.ts dropIndex`（テストは `npx vitest run --root dev_modules/tweeq src/InputArray`）。`TableHeader` は `columns` の文字列を親グリッドの列に並べるヘッダー行で、`InputArray` の `header` slot に入れると同じ余白が付く。

**Layers は Project Settings のタブ（2026-11-04）:** 専用のモーダルをやめた。`layers` アクション（`command+shift+L`、レイヤー名のクリック）は `openProjectSettings('layers')`（`TabsShowOptions.initialTab`、覚えているタブより優先）。並べ替えは離したとき 1 回（`project.setLayerOrder`）。削除は `project.deleteLayer` の印付けなので `@remove` で受ける。名前欄の Enter はモーダルを閉じないよう止めてある。

**semantic 色は Radix の鮮やかさ + Material の調和（2026-11-04）:** `theme/palette.ts`。明度と彩度はパレットの色のまま（Radix の step 9）で、色相だけ accent に反応する。OKLCH で accent に少し寄せ（距離の 15%、最大 8°）、寄せた結果 accent に 24° より近ければ離す（error が primary に見えないように）。パレットの色相からのずれは最大 20°、グレーの accent では反応しない。背景とのコントラストが 4.5 に足りない色だけ明度を動かす。以前の式は accent の明度と彩度を使っていたので、グレーで全部灰色、緑で error がオレンジ、青で暗くて読めなかった。HCT で Tone を揃える案（Material そのまま）も試したが、全体がニュアンスカラーになるのでやめた（ユーザー判断）。`--tq-color-on-error` は error で塗ったときの文字色（白）。エディタのシンタックスの nudge は別で、そのまま。

**矢印は参照の中心を指す（2026-11-04）:** `Balloon` の矢印は角丸に掛からないよう端から `BALLOON_ARROW_INSET`（20 px）より内側にしか行かない。小さいアイコンに `right-start` などで付けると中心がそれより端に来て矢印だけずれていたので、`Popover.update()` が `arrow` のとき交差軸方向にバルーンごとずらす（画面内に収めるシフトのほうが優先）。

**閉じたモーダルがクリックを奪っていた（2026-11-03）:** `PaneModal` の `display flex` が UA の `[popover]:not(:popover-open) {display: none}` に勝つので、閉じたモーダルは `opacity 0` のまま画面中央に残り（top layer の外、中身は `v-if="desc"` で残るのでサイズも最後のまま）、その下のタイムラインのシークやボタンを奪っていた（1400×900 で Layers を閉じたあと、ルーラーの左半分 = 730×507 の範囲）。`display flex` を `:popover-open` の中へ移した。**`[popover]` の要素に `display` を書くときは `:popover-open` の中に。** 確認は Playwright（閉じた後のルーラーの `elementFromPoint`、実マウスでのシーク、開いていない popover で `display` が none でないものが 0 個）。

**useDrag の pointer lock（2026-10-15、防御的）:** `lockPointer` のドラッグ（InputNumber / InputColorPad / InputTime / InputDrum / InputTranslate / MultiSelectPad）は `requestPointerLock` が非同期で、@vueuse `usePointerLock.unlock()` は lock が成立したのを見るまで no-op。素早いフリックで成立前に pointerup が来るとロックが残り得る（カーソルが消え、クリックが全部ロック先に吸われる）。pointerup で `document.exitPointerLock()` も直接呼び、`pointerlockchange` でドラッグ終了後に成立したロックを即解除するようにした。**「モーダルを閉じた後 / 起動から時間が経つとマウスが効かなくなる」の原因として確定したわけではない**（ヘッドレスでは pointer lock 不可、headful Chromium では grant が 5 ms で pointerup より先に来て再現せず）。

---

## Tweeq: ショートカットが効かなくなる（keyboardTarget, 2026-10-27）
症状: 何かの拍子に全ショートカットが効かなくなり、Cmd+P がブラウザの印刷になる。原因: Bndr の `keyboard()` は「押されている（keydown を見た）キーの集合」を持ち、`hotkey()` は**集合全体との完全一致**で照合する。keyup を 1 つ取りこぼすとそのキーが残り、以後どのショートカットも一致しない。取りこぼす場面: **ショートカットが `confirm` / `alert` / `prompt` を出す**（ネイティブのダイアログの間はページに keyup が届かない。Delete の確認、Set Hold… など koma に多い）、keydown で `<input>` にフォーカスが移ってそこで keyup（Bndr は input からのイベントを無視する）、押している途中でウィンドウのフォーカスが外れる。
- 対策: `dev_modules/tweeq/src/use/keyboardTarget.ts`。Tweeq / koma の `Bndr.keyboard()` は全部 `Bndr.keyboard(keyboardTarget())`（actions / CommandPalette / Timeline / useZUI、koma の App.vue の peek と useZUI）。window のキーイベントを複製して流しつつ集合を修復する: keyup は input からでも流す、イベントの修飾フラグと食い違う修飾キーは先に解放、別のキーが押されたときに 2.5 秒以上 keydown（自動リピート）が来ていないキーは解放（本当に押しているキーは数十 ms ごとにリピートが来る。macOS の「リピート入力認識までの時間」の最大 ≈ 2 秒より長く取ってある）、window の blur / focus / hidden と、**`window.alert` / `confirm` / `prompt` を包んで戻ったときに全部解放**。複製イベントの `preventDefault` / `stopPropagation` は元のイベントに効く。
- 確認（Playwright）: keyup の無い Delete の後で Cmd+P → 直後は開かない（2.5 秒待てば開く）、input で keyup → 開く、blur → 開く、keyup の無い Delete の後に本物の `confirm` を出して閉じた直後の Cmd+P → 開く。新しい Bndr（`^0.18.7`）側で直すのが本筋。
- **`<input>` にフォーカスがある間はショートカットが効かないのは仕様**（Bndr が無視する）。Tweeq の InputNumber は Enter 後もフォーカスが残るので、数値を打った後は Esc か外クリックで抜ける。

## Tweeq: 修飾キーの状態（useModifierKeys, 2026-10-01）
症状: カラーピッカー（`InputColorPad`）をクリックしてもポップアップが開かない（ドラッグの tweak は効く）。原因: `useMagicKeys()` は keydown/keyup だけを追うので、keyup がページに届かないと（macOS のスクリーンショット等のシステムショートカット、ネイティブダイアログ）Shift / Cmd が押されたままになる。window の blur/focus でしか戻らない。その状態だと `temporarilyHidePopup`（Shift/Cmd 中はピッカーを隠す）が真のままになり、multi-select も「修飾キーあり」と見て選択が溜まる（`multiSelected` → クリックを無視）。
- 対策: `dev_modules/tweeq/src/use/useModifierKeys.ts`（共有の shift/alt/control/meta）。keydown/keyup に加えて **pointerdown/move/up の修飾フラグでも同期**するので、取りこぼした keyup は次のポインタ操作で直る。`InputColorPad` と `stores/multiSelect` をこれに切り替え。文字キー（h/s/v…）は従来どおり `useMagicKeys`。
- **それでも開かなかった本当の原因（2026-10-08）**: Chrome のネイティブ `popover="auto"` は、**pointerup の最中に表示された popover を、その pointerup の light-dismiss で即閉じる**（pointerdown 時点で存在しなかった popover の「外」で pointerup したと見なす。`beforetoggle open->closed` が `click` の前に出る）。`useDrag` の `onClick` は pointerup ハンドラの中で呼ばれるので、そこで `open = true` にしていた `InputColorPad` だけが毎回これに当たっていた（修飾キーの貼り付きとは別件）。対策: `onClick` では `setTimeout(0)` でイベント処理が終わってから開く。開いている状態でボタンを押すと pointerdown の light-dismiss で先に閉じて `open` が false になるので、トグルの基準は自前の pointerdown リスナーで取った「押し始めの open」。他の `useDrag` の `onClick`（InputNumber / InputTime / InputSwitch / InputDrum）は popover を開かないので対象外。**popover を pointerup / useDrag の onClick から開くときは必ずイベント後にずらす。** 確認は実ブラウザ（Playwright、Chrome）で 開く / 再クリックで閉じる / 外クリック / ドラッグでは開かない / Esc。
- 未対応: `InputNumber`（alt/shift で速度）、`InputRotary`、`InputTranslate`、`InputTime` はまだ `useMagicKeys` の修飾キーを見ている（同じ貼り付きでドラッグ速度が変わり得る）。
- 確認（ヘッドレス Chromium）: Shift / Cmd+Shift を「keydown だけ」にした状態でクリック → 修正前は開かない、修正後は開く。本当に Shift を押したままのクリックは従来どおり開かない。ユーザーの環境で実際に貼り付きが原因だったかは未確認。

---

## ハードウェア: aux トラッカー取得（libsurvive）
`yarn aux` の "Acquiring tracking…" 出っぱなし / 検出が運任せ問題。

**原因1（断続的に全く検出しない）:** 孤児化した `survive-cli` プロセス残留。`yarn aux` を Ctrl+C 以外で終わると子 survive-cli が生き残り HID/CPU(各95%) を奪い新プロセスが POSE を得られない。
→ 対策済: `dev_modules/aux-manager/index.js` に起動時 `killStaleSurvive()`（killPTPProcess と同パターン）+ SIGHUP/exit/uncaughtException で子を確実に回収。

**原因2（全く検出しない の真因）:** `~/.config/libsurvive/config.json` 破損。幽霊ライトハウス（lighthouse1/5 が id:0/mode:0 で OOTXSet:1）が内部スロットを汚し実在 LH（ch13/8）の OOTX デコードと位置ソルブを完全ブロック。症状: 受光(W)/IMU(i) は大量に流れるが POSE が永遠 0、`OOTX not set for LH in channel 13/8` のまま、全 LH `PositionSet:"0"`。`--ootx-ignore-sync-error 1` でも改善せず。
→ 解決法（2026-06-17 実証）: `config.json` を退避（削除）して `yarn recal`（--force-calibrate）を1回。クリーンなら机に置いたまま ~15秒で POSE が出て `PositionSet:1` 保存。以後の通常 `yarn aux` は保存位置を読んで ~2秒ロック。旧 config は `config.json.before-debug-*.bak`。クリーン終了で config 再保存されるので一度良い状態にすれば維持。壊れたら同手順（退避→recal 1回）。
