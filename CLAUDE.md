# CLAUDE.md

koma（ストップモーション撮影アプリ）のプロジェクト知識。`~/.claude` のファイルメモリを集約したもの。マシンをまたいで引き継げるよう、リポジトリにコミットして共有する。

## コミュニケーション / 作業スタイル
- **返信は常に日本語**（ユーザーは英語で書くことが多いが日本語の回答を望む。2026-06-02 に明示要望）。散文・説明は日本語で書き、コード/コマンド/パス/識別子/技術固有名詞（API名など）はそのまま。
- **tweeq / tethr は vendored submodule**（`dev_modules/` 配下）。vite alias + tsconfig `paths` で **src に解決**されるため編集は即反映（ビルド不要、`lib/` は存在しない）。ユーザーは submodule を直接編集する形を希望。

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

## Preview レンダリングの二経路
Preview パネルは意図的に2経路: 一時停止/スクラブ/Hi-Res/onionskin/live-view は DOM 経由（`PreviewKoma.vue`、`<img>`/`<video>`）、再生は事前 decode 済 ImageBitmap canvas 経由（`PreviewPlayback.vue`、commit 6f286e2、毎フレーム JPEG decode 回避）。

2026-06-25 にパネル全体を単一 `<canvas>` 化（guides/letterbox は SVG overlay 維持）する案を議論し、ユーザーは **deferre を選択**。
- **理由:** 実現可能だが中規模リライトで回帰リスク。難所: (1) colored onionskin = 毎フレーム offscreen の "multiply tint → screen" 合成、(2) live view は live 中 persistent `<video>` + rAF draw loop、(3) **本当のブロッカー** = Hi-Res ズーム詳細: 今は camera-native jpg を出すので ZUI ズームでプロジェクト解像度超の焦点詳細が見える。固定解像度 canvas backing はこれを回帰させる（保つには transform 変化毎に表示ピクセルサイズで再ラスタライズ要）。
- **方針:** 二経路を「掃除すべきゴミ」と勝手に扱わない。再訪するなら単一 `PreviewRenderer`（再生キャッシュを1モードとして吸収）、canvas を現 `.frame` + CSS transform に残して ZUI/AF 座標を維持、Hi-Res 再ラスタ方式を先に決める。

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

---

## ハードウェア: aux トラッカー取得（libsurvive）
`yarn aux` の "Acquiring tracking…" 出っぱなし / 検出が運任せ問題。

**原因1（断続的に全く検出しない）:** 孤児化した `survive-cli` プロセス残留。`yarn aux` を Ctrl+C 以外で終わると子 survive-cli が生き残り HID/CPU(各95%) を奪い新プロセスが POSE を得られない。
→ 対策済: `dev_modules/aux-manager/index.js` に起動時 `killStaleSurvive()`（killPTPProcess と同パターン）+ SIGHUP/exit/uncaughtException で子を確実に回収。

**原因2（全く検出しない の真因）:** `~/.config/libsurvive/config.json` 破損。幽霊ライトハウス（lighthouse1/5 が id:0/mode:0 で OOTXSet:1）が内部スロットを汚し実在 LH（ch13/8）の OOTX デコードと位置ソルブを完全ブロック。症状: 受光(W)/IMU(i) は大量に流れるが POSE が永遠 0、`OOTX not set for LH in channel 13/8` のまま、全 LH `PositionSet:"0"`。`--ootx-ignore-sync-error 1` でも改善せず。
→ 解決法（2026-06-17 実証）: `config.json` を退避（削除）して `yarn recal`（--force-calibrate）を1回。クリーンなら机に置いたまま ~15秒で POSE が出て `PositionSet:1` 保存。以後の通常 `yarn aux` は保存位置を読んで ~2秒ロック。旧 config は `config.json.before-debug-*.bak`。クリーン終了で config 再保存されるので一度良い状態にすれば維持。壊れたら同手順（退避→recal 1回）。
