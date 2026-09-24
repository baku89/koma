# ADDSUB.md — koma の `addsub` ブランチ（積層と切削）の文脈

このブランチ（`addsub`）は [baku89/koma](https://github.com/baku89/koma) の作品用ブランチで、作品「積層と切削（Addition and Subtraction / addsub）」の撮影システムとして使う。`main` の koma は汎用のコマ撮りアプリ。このブランチでは、コマ撮りの1コマごとに **フライス盤による切削** と **6軸モーションコントロールリグ（Box Rig）によるカメラ移動**、**周囲のLED照明** を制御する。

koma 全体のプロジェクト知識（Tethr、アセット保存、Preview、性能、Popover など）は `CLAUDE.md` にある。このブランチの `CLAUDE.md` の冒頭に `@ADDSUB.md` を1行足して読み込ませる（`main` にマージするときにこの行を持ち込まない）。このファイルはそれに足す、作品・展示・ハードウェア側の文脈。

- 返信・説明は日本語。コード、コマンド、パス、識別子はそのまま
- tweeq / tethr は `dev_modules/` の vendored submodule を直接編集する（`main` と同じ）

---

## 1. 作品と展示

- 作品: ブロックをCNCで1コマずつ削り、そのたびに撮影するストップモーション。Strata-cut Animation（Fischinger、David Daniels、宇佐美毅）の系譜
- 展示: 東京都写真美術館「日本の新進作家 vol.23」。展示名は「Milling Stop-Motion」
- 会期: **2026-09-30 〜 2027-01-17**。会期中ずっと会場で公開制作する
- 撮り方: straight-ahead（頭から順に、1本の連続ショット）。最終的に短編映像に圧縮する
- 尺の目安: 2.5〜3分 @ **18fps** → おおよそ 2,700〜3,240コマ
- 音楽: Max Cooper。124 BPM。構成は冒頭 ~40秒がアンビエント、その後リズムが立ち上がる。撮影を進めながら映像を共有し、音と往復して詰めていく
- 作品ページ（devlog）: https://baku89.com/assembling-anew

### 運用条件（ソフトの設計に効くもの）

- **3.5ヶ月の連続運用**。会場には常に作者か助っ人がいる（無人運転ではない）。作者が不在の期間（2026-11 上旬〜下旬）は助っ人が回す
  - → 作者以外でも「再開」「止める」「異常から戻す」ができるUIが要る
- 館の開館時間内で撮る。電源断・ブラウザ再起動・PCスリープからの復帰を前提にする
- 観客が見ている前で動く。動作中の安全（非常停止、筐体内への手の侵入）は展示エンジニアと相談済みの範囲で扱う
- 精度より **再現性（repeatability）** を優先。目標は各回転軸 ~0.0015°
- 信頼性の主戦略は **park frame（毎コマ同じ基準姿勢で撮る参照フレーム）＋フィデューシャルマーカー**。機械精度で詰めるより、あとから検出・補正できる状態を保つ

---

## 2. 1コマの流れ（想定）

実装はまだ固まっていない。現時点での想定手順:

1. フライス盤で1コマ分の切削（CAM で書き出したそのコマの G-code を FluidNC に流す。集塵の on/off も G-code の中に書く）。Box Rig の移動は G-code を書き出さず、koma がカメラ姿勢から逆運動学（10章）で計算して送る
2. スピンドル停止・主軸退避を確認
3. フライス盤の X 軸を撮影位置まで突き出し、ブロックを本体から離れた場所に出す（フライス盤 +X = world +Z、F面側）
4. Box Rig をそのコマのカメラ姿勢へ移動
5. LED をそのコマの状態に設定（SHOW の ACK を待つ）
6. 揺れが収まるのを待って撮影（Tethr / Sigma fp）。待ち時間は固定値で始め、ライブビューのフレーム間の差分が収まったかで判定できるとよい
7. 必要に応じて park 姿勢で参照ショット
8. X 軸を切削位置に戻し、次のコマへ

各ステップは「完了を確認してから次へ」を原則にする（FluidNC の `Idle` 状態、LED の ACK、撮影完了イベント）。途中で止まったとき、どのステップから再開すればよいか分かる状態を project に残す。

**撮影位置（X の突き出し）について**

- 撮影位置は毎コマ同じ X 座標に固定する。値は project に持つ
- カメラから見たブロックの位置は、この X 移動の再現性にも左右される。park 参照ショットとマーカーで、ずれを検出できるようにしておく
- 12章の手順3（Box Rig とフライス盤の位置合わせ）は、撮影位置に出した状態で行う
- 撮影中もフライス盤のモーターは励磁したままにして、テーブルが動かないようにする

---

## 3. ハードウェア

### 3.0 座標系

- **Box Rig の座標系を previz（Houdini）と同じ Y-up の右手系にする**。これを world 座標と呼ぶ
  - +X = R面、−X = L面、+Y = 上、+Z = F面、−Z = B面（LED の面の名前と同じ）
  - previz のカメラ位置と回転は、変換なしで Box Rig の座標になる
- Box Rig の FluidNC の軸もこれに合わせる: X = ガントリー送り、Y = 縦軸、Z = キャリッジ送り、A/B/C = rx/ry/rz
  - 以前の Z-up での呼び名からの読み替え: 旧 Z（縦）→ Y、旧 Y（キャリッジ）→ Z。旧 Y と新 Z は向きが逆になるので、方向ピンの反転とホーミング方向を合わせ直す
  - 新しい +Z 側が F面になっているか要確認
- **フライス盤は FluidNC・G-code とも一般的な Z-up のまま**にする。CAM は工具軸が Z であることを前提にしているため
- フライス盤は正面が L面（world −X）を向くように置く。この向きでは、フライス盤の軸と world の軸がこう対応する
  - フライス盤 +X（正面から見て右）→ world +Z（F面側）
  - フライス盤 +Y（奥）→ world +X
  - フライス盤 +Z（上）→ world +Y
  - world = (mill Y, mill Z, mill X) + t。軸を巡回させただけなので右手系のまま
- koma と previz では、フライス盤をこの向きに回して t だけずらして置いたものとして扱い、座標は全部 world で持つ。G-code に書き出すときだけフライス盤の座標に戻す（CAM の座標系の設定で行う）
- t は 12章の手順3で求める

### 3.1 Box Rig（自作 6軸モーションコントロールリグ）

1500mm 立方の箱の中で、カメラを吊り下げて動かす。

- 軸構成は「H」字型: 2本のレールの間を 1500mm のブリッジが渡る。ブリッジが X 方向に、キャリッジがブリッジに沿って Z 方向に動く。キャリッジから縦軸（Y）が下向きに伸び、その先にパン/ティルト/ロールの雲台、その先にカメラ
- カメラ: Sigma fp
- 縦軸（Y）のストローク: ~1250mm
- **吊り下げた縦軸は剛性が低く揺れやすい**。特にガントリー（X）の加減速で先端のカメラが振れる
  - FluidNC の `acceleration_mm_per_sec2` をかなり低くする（特に X）
  - FluidNC の加減速は台形で、S字（ジャーク制限）は無いはずなので、効くのは加速度を下げることくらい
  - 移動後は揺れが収まるのを待ってから撮る（2章）
- フレーム: V-Slot 2040 × 1500mm

**駆動と steps_per_mm（1/8 step = 1600 steps/rev）**

| 軸 | 機構 | steps_per_mm |
|---|---|---|
| X | NEMA23、GT2 30T プーリー、閉ループ GT2 ベルトでガントリーを引く（X1/X2 の2モーター、squaring） | 26.667 |
| Z | GT2 20T、V-Slot 片側に沿わせたベルト（ループではない）、モーターがガントリーに乗る | 40 |
| Y | SFU1204 ボールねじ（φ12、リード4、L=1200mm）。上でホーミングし、可動域は負方向 | 400 |
| A/B/C | 回転軸、単位は度。モーター 18T → 96T ギア（比 5.333）。ヘリンボーンギア（PLA-CF） | 23.704 steps/° |

- 縦軸（Y）は非励磁ブレーキ付きモーター（24V）。ブレーキは FluidNC の stepper enable で制御し `idle_ms: 255`
- マイクロステップは全軸 1/8。細かくしないのは速度とトルクの余裕を優先したため
- 回転軸は連続回転があり得るので `hard_limits: false`。ホーミングは光学スロットセンサ

**コントローラ**

- PiBot FluidNC ESP32 GRBL CNC Controller **V4.96 Pro**（当初の V5.88 Ultra はリミット端子まわりの短絡で故障、Pro に切り替え）
- FluidNC 必須（grblHAL の web builder は4軸まで）
- エンジンは `I2S_STREAM`
- 自作基板
  - `cnctmc-breakout`: PiBot → LAN（RJ45）への分配。1モーター1ポート。pin 1=Vio、2–4=モーター信号、5–7=GND、8=LIM。C チャンネルの STEP/DIR/EN は SN74HCT125N でバッファ
  - `cnctmc-mounter`: モーター1個ぶんのドライバ基板（TMC2208、縦軸（Y）のみ TMC2209 の standalone StepStick モード）
- X1 は PiBot オンボードソケット直結、X2 以降は breakout → mounter

**PiBot のソケットと実機の軸（工場設定のスロットを付け替え）**

左の列は PiBot のソケット名。FluidNC の軸名は 3.0 のとおり X/Y/Z/A/B/C を world に合わせて付ける。

| PiBot ソケット | 実機の軸 | リミット |
|---|---|---|
| X | X1（motor0） | gpio.33（両端の N.C. スイッチを直列） |
| Y | X2（motor1、squaring） | gpio.32（+端のみ） |
| Z | Z（キャリッジ） | gpio.35 |
| A | Y（縦軸） | gpio.34 |
| B | A（ティルト） | gpio.39 |
| C | B（パン） | gpio.36 |
| （7軸目） | C（ロール） | 空き Y/Z/A ソケットの MS3 I2SO 線（STEP i2so.6 / DIR i2so.11 / EN i2so.14）、リミット gpio.2 |

- X は + 方向にホーミング、`mpos_mm: 1000`。X1/X2 とも `limit_pos_pin`
- 他軸の N.C. スイッチは `limit_all_pin`。極性（`:low`）は配線後に `Pn:` を見てピンごとに決める

### 3.2 フライス盤（オリジナルマインド KitMill AST200、協賛貸与）

- テーブル: X 425.8mm × Y 134mm、T溝幅 11mm、ピッチ 65mm、M8 T溝ナット
- モーター: NU2M-056NS（ユニポーラ6線、2A/相、バイポーラ直列で ~1.0A RMS）。内蔵 24V/300W 電源
- コントローラ: PiBot FluidNC ESP32 GRBL CNC Controller V4.96 Pro（Box Rig とは別個体）、オンボード TMC2209
  - **切削時は SpreadCycle 必須**（StealthChop は負荷で脱調する）
- スピンドル: ブラシ付き DC 24V/100W。Pololu G2 High-Power Motor Driver 24v13 で駆動
- 集塵: PiBot の MOSFET 出力 → 集塵機キットの J7 フォトカプラ入力。FluidNC の coolant 出力（M8/M9）か user output（M62/M63）に割り当て、切削の G-code の中で on/off する。撮影シーケンスでは扱わない
- ワーク固定: ミスミ TAKPS8 偏心クランプを使った自作バイス
- コレット: Φ4/6/8（最大 Φ8）
- 被写体: 高さ 60mm に切り揃えたブロック。材料は固定しない（スタイロフォーム、レジン、蝋、アルミ、木など。異素材の積層に限らない）。ブロックの継ぎ足しは 7章
- エンドミルは荒削りに安価な超硬アップカット、仕上げに国産ボールエンドミル

### 3.3 LED 照明（Box Rig の周囲4面）

- WS2815（DC12V、RGB、30 LEDs/m）。1400mm に切り、ジグザグ配置、1データラインあたり最大10本
- 8データライン（各面2本: L1/L2/B1/B2/R1/R2/F1/F2）
- 自作基板
  - `ws-fanout`: ESP32（NodeMCU ESP-32S）で8ライン出力。レベルシフタ SN74HCT32N、直列 330Ω。GPIO16/17/18/19/21/22/23/25 → L1/L2/B1/B2/R1/R2/F1/F2
  - `ws-uturn`: テープの折り返しと 12V 注入
- ファームウェア: PlatformIO/Arduino、FastLED RMT 8ch
- **koma との通信**: フレームワーク非依存の TypeScript WebSerial 送信モジュールを koma から import する
  - 独自バイナリプロトコル（`LINE` 部分更新 / `SHOW` ラッチ＋出力後 ACK / `FILL` / `INFO` / `SET`）。Adalight は使わない
  - 921600 bps、CP2102 経由。全画面更新で ~9–10fps（コマ撮りには十分）
  - 帯域が足りなくなったら ESP32-S3 か Wi‑Fi ブリッジに移行
- ESP32 と LED の 12V 電源は GND 共通

### 3.4 電源

- LED: 12V（Cosel PLA600F-12 + 300W）
- モーター: 24V 系統を別に。PiBot（X1）、X2、Y/Z/A/B/C の幹線をキャリッジで分岐
- LED 用 ESP32 と FluidNC は別基板

### 3.5 PC との接続

- 2台の FluidNC、LED の ESP32 はすべて **WebSerial** でつなぐ。カメラは WebUSB（Tethr）
- 1台の PC の、撮影 UI の1つのタブがすべての機器を掴む（WebSerial も WebUSB も、1つのポートは1つのタブしか開けない）
- 2台の PiBot は同じ USB シリアル変換チップなので、USB の VID/PID では見分けられない。ポートを開いたあと FluidNC に問い合わせて（`$I` のビルド情報や、config の `name:` など）どちらの機械かを判定する。config の `name:` を機械ごとに変えておく
- 許可済みのポートは `navigator.serial.getPorts()` で取れるので、リロードや再起動のあとも選び直さずに再接続できる
- G-code は1行送って `ok` を待つ方式で流す（FluidNC の受信バッファを溢れさせない）。状態は `?` のリアルタイムコマンドで定期的に取る
- config.yaml のアップロードは、これまでどおり FluidNC の WebUI で行う（4章。シリアルの XModem は化ける）

---

## 4. 既知の落とし穴

### FluidNC（v3.9.9）

- YAML で値の後ろのインラインコメントは parse エラー（行頭 `#` は可）
- I2S エンジン（STREAM / STATIC）では step ピンは全て I2SO。gpio の step ピンは拒否される
- 工場 YAML の `i2so:` セクションは必須。無いと起動時に panic
- 未接続の PiBot リミット入力は浮いているので、スイッチ無しの `Pn:` は当てにならない
- どれかの軸のリミットが入力ありと読まれていると、ホーミングは全部 `ALARM:12`（Ambiguous limit switch touching）で拒否される。未配線の軸は `NO_PIN` にしておく
- シリアルの XModem での config 転送はランダムにバイトが化ける（`Key cycl` のような謎エラーになる）。config.yaml は WebUI のファイルマネージャでアップし、再起動前に読み戻して確認する

### ハード由来

- cnctmc-breakout の Vio ポリスイッチ（0.5A）は、TMC2208 を逆挿しすると飛んで抵抗が戻らなくなった（Vio が ~3V まで落ちる）。1.1A hold に交換。逆挿しした TMC2208 は廃棄
- cnctmc-mounter v2.1: `ENABLE_HALL` のはんだブリッジを閉じないと G が GND に落ちない（浮く）。`LIM2` はホールIC の GND 戻り側にあり信号経路ではない

---

## 5. `main` ブランチとの関係

- ライセンスは koma と同じ GPL-3.0
- 作品用の変更は `addsub` ブランチで行う。`main` は汎用の koma のまま保つ
- 作品固有でないもの（Tethr の修正、汎用UI、WebSerial や FluidNC の汎用通信層、14章のレイヤーと保存構造など）は、あとで `main` に取り込める単位でコミットを分ける。作品固有の変更と同じコミットに混ぜない
- 作品固有のもの（撮影シーケンス、軸割り当て、LED のレイアウト、previz からのパス読み込み、15章の展示画面）は `addsub` ブランチに閉じる
- 展示後、このシステム（ソフトのパッケージとソース、リグの設計データ）は作品の一部として美術館への収蔵を相談している。作者が同一性を保証したバージョンを固定できるよう、`addsub` ブランチにタグやリリースを切れる状態を保つ

---

## 6. 未決事項

- Houdini が `previz/` に書き出すファイルの具体的な形式（13.1）
- 異常時の扱い（脱調検知、撮影失敗、LED の ACK タイムアウト）と、作者不在時に助っ人が復帰させる手順
- park frame とフィデューシャルマーカーを使った位置ずれの検出・補正をどこまでソフトに持たせるか

---

## 7. ブロックの継ぎ足し

- フライス盤の切削高さは 100mm が限度なので、盤上には常に2段までしか載せない
- ブロックの高さは **60mm** に揃える。LED のピッチ（33.3mm）とは揃えない。LED の段ずらしは展開図からのサンプル位置をずらして表すので（8章）、整数粒である必要はない
- 次のブロックを載せられるのは、上段の残りが 40mm 以下になってから（残り + 60 ≤ 100）。交換のしきい値は運用で決める（目安 20〜40mm）

### 7.1 座標系

- **film 座標**: world と同じ向き（Y-up）で、最初のブロック A の底面の角を原点にする。切削が進むと、作業面は film 座標の中を **下へ** 下がっていく
- 2つ目のブロック B は A の下（Y = −60〜0）。k 番目は Y = −60k 〜 −60(k−1)
- **world Y = film Y + 60 · k_base + ブロック底面の高さ**（k_base は盤上の最下段のブロック番号）。盤上から見ると、段を足すたびに film の世界が1ブロックぶん持ち上がる。カメラと LED が world 座標で上がっていくのはこのため
- LED は段ごとに 60mm · k_base ぶんずらす（8章）
- 切削パスも film 座標で持つ
  - CAM は Fusion 360。書き出した G-code には手を入れない
  - Fusion のセットアップの WCS 原点を film 座標の原点（ブロック A の底面の角）に置き、軸の向きはフライス盤に合わせる（3.0 の対応）。G-code は WCS 基準の座標と `G54` の選択だけを含む
  - koma は各コマの G-code を流す前に、別のコマンドとして `G10 L2 P1 X.. Y.. Z..` を送り、G54 の原点を「film 原点がいまフライス盤のどこにあるか」に合わせる。段を継ぎ足すと、この Z が 60mm ずつ上がる
  - そのため、継ぎ足しても G-code を書き出し直す必要はない
  - Fusion のポストプロセッサが `G10` などで原点を書き換えないことは確認しておく

### 7.2 交換手順

1. 上段の残りが 20mm 未満になったら止める
2. 次のブロックの完全体だけを盤上に載せる
3. **再演パス**: 既存の全コマを、記録済みのカメラ姿勢・露出・LED で、k_base だけ更新して自動で撮り直す
4. 上段の残りを接ぐ
5. 続きのコマから再開する（カメラは 60mm 上から）

### 7.3 koma 側でやること

- 再演パスは 1ブロック = 1レイヤーとして持つ（14章の「再撮影」レイヤー）
- 再演パスの所要時間を見積もる
- Box Rig の縦軸（Y）のストロークの範囲で何段まで行けるか確認する
- 途中で止まったときに再開できるよう、進行状況を project に残す

---

## 8. LED ライティングの記録と再現

- 各コマの LED は **4面の展開図の画像** で持つ。これがそのコマのライティングの元データ
- 画像は film 座標で描く。段ずらし（7章）のぶん、物理的な LED の範囲より下に長くしておく（余白は予定ブロック数 × 60mm）
- 実機に送るときは、画像を縦に 60mm × k_base ずらして、各粒の位置の色を拾う
  - 粒の位置はピクセルの中心と揃わないので、程よく補間する（バイリニア、または LED のピッチ程度の範囲の平均）
  - ブロックの高さ（60mm）と LED のピッチ（33.3mm）は揃っていないが、補間で拾うので問題ない
- **配置マップ**: 各粒の展開図上の座標（面、水平位置、film Y）を ws-fanout のライン順に並べた表。テープ 1400mm、100mm 間隔のジグザグ、33.3mm ピッチ、折り返し位置から生成する
- 送った RGB は画像・配置マップ・k_base から再計算できるので、保存するのは画像と、配置マップのバージョンだけでよい
- AE のコンポジションは4面の展開図として作り、コマごとの画像として書き出す

### 8.1 AE からのリアルタイムプレビュー（候補）

1. Syphon → 仮想カメラ → `getUserMedia`。手軽だが、圧縮と色変換を通る
2. aux-manager で Syphon を受けて WebSocket で流す。ネイティブモジュールが要る
3. LED 用の連番を書き出す（非リアルタイム）

プレビューは 1、本番はコマ番号で決まる連番（3）が確実。AE のビューアを Syphon に出す方法（プラグインか画面キャプチャか）は未確認。

---

## 9. ライブビューのキャスト

館内 LAN の中で、ライブビューを別の端末に映す（館外は後回し）。

- webcam / UVC は `getUserMedia` の MediaStream をそのまま使える
- PTP 直結の fp は、JPEG を canvas に描いて `canvas.captureStream()` にする
  - 描画はフレームが届いたときに行う（rAF は裏タブで止まる）
  - PTP バスの負荷は増えない
- WebRTC: `addTrack`、`degradationPreference: 'maintain-resolution'` と `maxBitrate` を指定
- シグナリングは aux-manager に WebSocket を足す。LAN 内なら host candidate だけで足り、STUN/TURN は要らない
- ビューアは `<video>` だけの静的ページ

**代替**: JPEG を WebSocket で中継して `<img>` を差し替える。再エンコードがなく実装も短いので、LAN 内ならこちらのほうが扱いやすい。

館外から見る場合は TURN が必須で、ライブビューに加えて最新のコマと状態も送る。

---

## 10. カメラ雲台と投影中心

- 電動雲台は縦軸（Y）の先端に **逆さ** に取り付ける。FluidNC の A/B/C = rx/ry/rz = ティルト/パン/ロール
- カメラの XY は回転軸と揃っている。光軸方向に、投影中心（入射瞳）が回転中心から距離 d ずれている（Houdini のカメラと同じく、カメラは −Z を向く）
- 構造は一般的な3軸ジンバルを逆さにしたもの。外側（縦軸に近い側）から順に:
  1. **パン**（B）: 鉛直軸まわり（Y 軸）
  2. L字のアームが降りて **ロール**（C）: 光軸まわり（Z 軸）
  3. 前に突き出した両腕の間の **ティルト**（A）: X 軸まわり
- よって R = R_pan · R_roll · R_tilt（外側から内側へ掛ける）
- Houdini の回転順序（固定軸で先に適用される順）でいうと `xzy`。previz のカメラをこの回転順序にしておけば、チャンネルの値が雲台の角度にそのまま対応する
- ジンバルロックはロール ±90° で起きる。ロールは小さく使うので実用上は問題ない
- 各軸の回転の符号が Houdini と一致しているか（逆さ取り付けで反転していないか）は実機で確認する

### 10.1 逆運動学

- o = (0, 0, −d)（カメラ座標での投影中心のずれ。d > 0 なら回転中心より前）
- 回転中心 c = p − R · o（p は previz の投影中心、R はカメラの姿勢）
- Box Rig の XYZ = c + (0, 60 · k_base, 0) + 機械オフセット（12章の手順3で求める）

o と機械オフセットの求め方は 12章。同じキューブは park frame の位置ずれ検出にも使える。解析は OpenCV.js などでブラウザ内で完結させる。

---

## 11. UI

- 独自のUIやスタイルは作らない。Tweeq のコンポーネントと全体のスタイルに極力合わせる。足りない部品は Tweeq 側に足す（`main` に戻せる形で）

### 11.1 全体の方向

- `main` の Vive Tracker（libsurvive / aux-manager）まわりの表示を、2台の CNC のジョグと 3D プレビューに置き換える
- 3D ビュー
  - フライス盤のヘッド（主軸）の現在位置
  - カメラの現在の姿勢と、撮影済みコマのカメラ位置の軌跡
- 右ペイン: 各 CNC のステータス（FluidNC の状態、座標、アラーム）と、一般的なジョグ
  - フライス盤: 3軸（X/Y/Z）
  - Box Rig: 6軸（X/Y/Z + カメラ回転 A/B/C）

### 11.2 3D ビュー上のジョグ

- 対象（ヘッド / カメラ）から6方向に立体の矢印を出し、クリックまたはドラッグで移動させる
- 矢印はビューの視点に合わせて回転して描く（どの角度から見ても押せる向きにする）
- カメラの回転
  - A/B/C を軸ごとに直接回すこともできる
  - 基本は **現在のビューを基準にしたパン・ティルト・ロール**。ビュー基準の回転は、目標の R を 10章の順序（パン → ロール → ティルト）で分解して A/B/C にする
  - パン・ティルト・ロールの回転中心は、雲台の回転中心ではなく **投影中心（入射瞳）** にできるとよい。10章の o を使って XYZ を同時に補正すれば、画面が視差なく振れる

---

## 12. キャリブレーション（ウィザード）

10章で使う o と機械オフセットをここで求める。

- ウィザードはコマンド（コマンドパレット）から起動する
- リグの移動・撮影・解析まで koma が自動で進め、人がやるのはターゲットの設置と結果の確認だけにする

### 12.1 ターゲット: 3Dプリントのキューブ

- 一辺 60mm（ブロックと同じ）。2色の FDM 出力（白地に黒の丸の点格子、各面 4×4〜5×5）
- ブロック用のバイスに咥える。バイスの固定側の面と底面が基準になるので、キューブの結果がそのままブロックの座標系で出る
- バイスのジョーに隠れる下側には点を置かない
- 点に ID は埋め込まない。リグの指令姿勢からキューブの模型を画面に投影し、最も近い点と対応づける
- 面ごとに点の数か配置を少し変えて、指令姿勢が大きく狂ったときの面の取り違えを検出できるようにする
- 出力の反りや寸法誤差があるので、面同士の位置関係は最初に全方位から撮って推定する（バンドル調整）

### 12.2 初期値（スペックと CAD から）

- レンズ: Sigma 105mm マクロ。Sigma fp は 35.9×23.9mm / 6000×4000px、画素ピッチ ~5.98µm → 無限遠で fx ≈ 17,500px
- マクロは近接で実効焦点距離が大きく変わるので、上の値は初期値と検算にだけ使う
- cx, cy は画像中心、歪みはほぼゼロから始める
- d =（雲台の回転中心 → マウント面、CAD から）+（マウント面 → 入射瞳、実測）

### 12.3 手順

0. 準備: 本番と同じピント位置で MF 固定（以後ピントリングに触らない）、露出固定、絞り込んで被写界深度を稼ぐ。解析はフル解像度 JPG
1. 内部パラメータ: キューブをいろいろな位置・角度で画面に入れて 20〜30枚 → fx, fy, cx, cy、歪み。再投影誤差 0.5px 以下が目安
2. 投影中心のずれ o: XYZ 固定で rx / ry を7段階ずつ振る → 各画像の投影中心 C_i に円を当てはめる → 円の中心が回転中心、中心→C_i をカメラ座標に戻したものが o。rz も振って C_i がほぼ動かないことを確認
3. Box Rig とフライス盤の位置合わせ: 回転固定で XYZ を 10〜20点 → 指令 XYZ と推定カメラ位置から剛体変換（Kabsch）。回転は 3.0 の置き方で決まっているので、求まるのはほぼ平行移動 t と、置いたときの小さな回転誤差。残差で steps_per_mm や直角度の狂いも見る
4. 検証: 投影中心まわりに振って視差が出ないこと。previz の姿勢でレンダーをオニオンスキンで重ね、輪郭が合うこと

- ボケた点は重心計算から外す
- 推定値がスペック・CAD の初期値から大きく外れたら、取り違えか検出ミスを疑って止める
- やり直し: 1・2 はレンズ交換・ピント変更時、3 は搬入後とリグ・フライス盤が動いたとき（会期中の定期チェックにも使う）

---

## 13. 1コマに紐づくデータと previz

各コマに以下を持たせる。

- フライス盤の G-code（CAM で書き出した、そのコマで新しく削るぶん）
- previz 画像（オニオンスキン・照合用）
- カメラ姿勢（film 座標、7章）とカメラの設定（焦点距離など）
- LED の展開図の画像（8章）

### 13.1 Houdini から koma の project に直接書き込む

previz は Houdini で作る。上のデータは Houdini が koma の project フォルダに直接書き出す。

- Houdini が書くのは project の中の専用フォルダ（例: `previz/`）だけにする。koma の `project.json` には触らない。koma は `previz/` を読むだけにして、書き込む側を1つに絞る
  - 例: `previz/frames.json`（コマごとのカメラ姿勢と設定）、`previz/led/0001.png`、`previz/gcode/0001.nc`、`previz/render/0001.jpg`
- 書き出す前に既存の `previz/` をバックアップする（日時付きのフォルダにコピー）
- 書きかけを koma に読ませないよう、一時ファイルに書いてから rename する
- koma は `previz/` の変更を検知して読み直す（`FileSystemObserver`、なければポーリング。15.2 と同じ仕組み）
- koma の project は OPFS と実フォルダのどちらにも置けるが、addsub では実フォルダの project を使う（Houdini、Dropbox から見えるように）

**焦点距離の向き**

レンズは 105mm の単焦点なので、焦点距離は Houdini から koma に指示する値ではない。逆に、12章で実測した内部パラメータ（fx, fy, cx, cy, 歪み）を koma が project に書き、Houdini のカメラをそれに合わせる。

- 例: `calibration.json`（koma が書き、Houdini が読む）

### 13.2 Houdini と koma のリアルタイム通信

ファイルでの受け渡しとは別に、Houdini で編集しながら koma 側で確かめるための経路を持つ。

- aux-manager の WebSocket（9章）を中継にして、Houdini（Python の WebSocket クライアント）と koma をつなぐ
- 使い道の例
  - Houdini のタイムラインのフレームに合わせて、koma のオニオンスキンや LED のプレビューを切り替える
  - Houdini で動かしているカメラに Box Rig を追従させる
- Box Rig の追従は実機が動くので、koma 側で明示的にオンにしたときだけにし、速度と可動範囲に制限をかける

## 14. レイヤーと保存構造

この章の内容は作品固有ではないので、`main` に取り込める形で作る。

### 14.1 レイヤーに種類を持たせる

これまでは 1, 2, 3 の連番だけだったが、用途を持たせる。

- 本番
- テストショット
- 読み込み（previz やオニオンスキン用に、koma の外から持ち込んだ画像）
- 再撮影（7章の再演パスもここに入る）

### 14.2 保存フォルダ

- これまではルートに全部並べていたのを、レイヤーごとにフォルダにまとめる
- 既存プロジェクトの移行手順を用意する

### 14.3 `_lv`（リサイズ画像）の扱い（将来）

- `_lv` を画像ファイルとして project に保存するのをやめる
- 撮影画像の雑なハッシュ（ファイルサイズ＋先頭数十KB など、超高速に計算できるもの）をキーに、リサイズ画像を OPFS などに永続化するキャッシュにする
- キャッシュが消えても元画像から作り直せるので、project の中身は撮影画像とメタデータだけになる

---

## 15. 展示用の画面

koma の別 URL として、会場のモニターに映す画面を用意する。

### 15.1 構成

- 送出機: Mac mini、モニター2面
- 画面A: これまでに撮った映像をループ再生する。撮影初期はテストショットも含める
- 画面B: 図面のような、再帰的に分割したグリッドのレイアウト。区画ごとに次を映す
  - 画面Aで今出ているコマのメタデータ（撮影日時、何コマ目か、レイヤーの種類＝本番・テスト・再撮影など）
  - いまフライス盤に送っている G-code（実行中の行がわかるように）
  - Box Rig とフライス盤の 3D（11章の 3D ビューを表示専用で使う）
  - 現在のカメラ入力（ライブビュー）
  - devlog（https://baku89.com/assembling-anew）の QR コード

### 15.2 実装

- koma の別ルートとして作る
- **撮影データの受け渡し**: 撮影機の koma プロジェクトフォルダを Dropbox などで Mac mini に同期し、展示画面から Chrome の File System Access API（`showDirectoryPicker()`）で直接読む
  - 撮影側の koma は実フォルダの project を使う（13.1）
  - フォルダのハンドルは IndexedDB に保存して、再起動後も開き直せるようにする。再起動のたびに許可を求められると毎朝の立ち上げが手間なので、Chrome の「毎回許可」（persistent permission）を使う
  - Dropbox は「オフラインで使用可能」にしておく（オンラインのみのファイルは読めない）
  - 同期の途中で書きかけのファイルを読むことがあるので、JSON の parse に失敗したら少し待って読み直す
  - 変更の検知は `FileSystemObserver` が使えれば使い、なければ数秒おきにポーリングする
  - リサイズ画像（14.3）は Mac mini 側の OPFS に作る
- 画面Aのコマが変わったら、画面Bのメタデータもそのコマに合わせて切り替える
- 再生には 14.3 のリサイズ画像キャッシュを使う。コマ数が数千になるので、先読みは再生位置の前後だけにする
- グリッドは分割の木（縦横・比率・中身）としてデータで持ち、区画の中身を差し替えられるようにする
- QR コードはブラウザ内で生成する

**ライブビューと CNC の状態の受け渡し**

撮影済みのコマは同期フォルダで足りるが、ライブビュー、送出中の G-code の行、Box Rig とフライス盤の現在位置はリアルタイムに要る。Dropbox の同期では遅いので、撮影機から 9章の WebSocket 中継で送る。WebUSB のカメラと WebSerial の機器は1つのタブしか掴めないので、展示画面はそれらに直接触らない。

**2面への配置**

- Chrome の Window Management API（`getScreenDetails()`）で画面を列挙し、ウィンドウをそれぞれのモニターに置いて全画面にする
- 初回だけ権限の許可が要る

### 15.3 起動と常時表示

- 電源を入れるだけで展示画面まで立ち上がるようにする。Mac mini は「停電後に自動的に起動」をオンにし、ログイン項目で Chrome をキオスクモードで立ち上げ、展示画面を開く
- 画面のスリープは Wake Lock API と macOS の設定の両方で止める
- 3.5ヶ月同じ配置で映し続けるので、焼き付き対策に数分おきに全体を数px ずらす（特に OLED の場合）

### 15.4 未決事項

- テストショットをいつまで画面Aに含めるか（本番のコマ数で切り替えるか、手動か）
- 画面Aの再生速度（本番どおり 18fps か）と、ループの範囲（全コマか、直近のみか）

---

## 実装メモ（as-built, 2026-09-24 初回コミット時点）

`addsub` ブランチの現状。仕様（上の章）との差分と、実機で確認が要る仮定を残す。

### コミットの分け方
- `main` に戻せる汎用: `src/utils/fluidnc/`（WebSerial クライアント・status/`$I` パース・G-code ビルダ・vitest）、`src/utils/serialDiscovery.ts`、`src/stores/machine.ts`（`defineMachineStore` ファクトリ）、`src/components/MachinePanel.vue`、`TitleBarMachineConnection.vue`、project ストアの `directoryHandle` 公開と open 時の既定値 cloneDeep。
- 作品固有（このブランチに閉じる）: `src/addsub/**`、`src/exhibit/**` + `exhibit.html`、`App.vue`/`TitleBar.vue` の組み込み、`dev_modules/ws-fanout` submodule、Tracker UI の撤去。

### 機器接続（§3.5）
- 2 台の FluidNC は `$I` の `[MSG: Machine: <name>]` で識別する。**config.yaml の `name:` を `AST200`（フライス盤）/ `BoxRig`（Box Rig）にする**（既定。各パネルの config `machine.<id>.fluidncName` で変更可）。
- `navigator.serial.getPorts()` の全ポートを起動時と `connect` イベント時に順に開いて識別し、該当機に渡す。LED（ws-fanout）も同じ仕組みで PING/INFO で識別。ポート open は ESP32 をリセットし得るので、1 ポートは 1 回しか開かない（`serialDiscovery` が調停）。
- 送信は 1 行→`ok` 待ち。realtime（`?` `!` `~` `^X` `0x85`）は生バイトで別送。`waitIdle` は Idle を 2 回連続で見るまで待つ（`ok` は「planner に入った」の意味で、直後の 1 回目の Idle は信用しない）。

### previz/frames.json（§13.1 の未決を仮決め）
```json
{
  "version": 1,
  "fps": 18,
  "paths": {"gcode": "gcode/%04d.nc", "led": "led/%04d.png", "render": "render/%04d.jpg"},
  "ledTopFilmY": 1500,
  "frames": [
    {"frame": 1,
     "camera": {"position": [x, y, z], "rotation": [x, y, z, w]},
     "cameraConfigs": {"aperture": 8},
     "gcode": "gcode/0001.nc", "led": "led/0001.png", "render": "render/0001.jpg",
     "cut": true}
  ]
}
```
- `position` は film 座標 mm・投影中心（入射瞳）。`rotation` は quaternion、代わりに `"angles": {"tilt","pan","roll"}`（度）でも可。
- `paths` は省略時の既定パターン（`%04d` = `frame` の値）。フレーム個別の `gcode`/`led`/`render` が優先。`"cut": false` で切削なし。
- koma 側は timeline frame + `project.addsub.previzFrameOffset` = previz `frame`。`FileSystemObserver` があれば監視、無ければ 3 秒ポーリング。parse 失敗は書きかけとみなし再試行。

### シーケンス（§2）
- `src/addsub/stores/sequence.ts`。ステップ: `cut → extend → (rig ∥ led) → settle → capture → park → retract`（主軸停止・退避は CAM の G-code に含まれるので `cut` の一部。rig 移動と LED は別機器なので並列）。各ステップ完了ごとに `project.addsub.sequence` に進行を保存（frame / step / done / status / returnPosition）。パネルの「Resume」でステップを選んで再開。
- `cut` は先に `G10 L2 P1` で G54 原点を `filmOriginMill(kBase)` に合わせてから G-code を流す。`extend` 前の table 位置を `returnPosition` に保存し `retract` で戻す。
- `stop()` = abort + 両機に feed hold。**ESTOP**（タイトルバーの赤ボタン / コマンド `estop` / `shift+escape`）= シーケンス実行中でなくても両機を同時に feed hold + 主軸停止（0x9E）。復帰（`~`/`$X`/reset）は機械パネルから。
- Sigma fp の撮影は App.vue の `shoot()` をそのまま使う（`sequence.registerCapture`）。park 参照ショットは kind `park` のレイヤー（無ければ作る）に入る。
- **再演パス（§7.2）**: `startReplay(range)`。記録済みショットの rig 軸を `60·Δk_base` だけ持ち上げ、LED 画像を現在の lift で再サンプル、露出を再適用して kind `replay`・ラベル `replay k<n>` のレイヤーに撮り直す（rig ∥ led → settle → capture）。
- **レイヤー（§14.1 の実装）**: レイヤーは「名前付きの独立したタイムライン（本編とフレーム番号を共有）」で、いくつでも作れる（`project.layers[i] = {id, name}`、index = `koma.shots[]` のスロット。追加のみで並べ替え・削除はしない）。機能の割り当ては無く、テストも再演も park もただの名前付きレイヤー。**表示情報はプリセット** `project.layerPresets[]`（`{id, name, layers: [{layerId, opacity, mixBlendMode}]}`、配列順 = 表示順（下→上）、載っていないレイヤーは非表示）で、`activeLayerPreset` で切替。Layers ダイアログ（`command+shift+L` / Timeline 左端のレイヤー名クリック）でプリセットの作成・改名・削除、レイヤーの表示/順序/ブレンド/不透明度、追加、撮影先の指定。タイムライン・プレビューはアクティブなプリセットの順で合成（`compositeLayers`）。**「画像の下をクリックするとレイヤーが増える」挙動は廃止**（↑↓は表示順で移動）。旧ファイルはレイヤーの opacity/blend を "Default" プリセットへ移行。
- **テストショット**: 「New Test Shot…」で名前付きレイヤーを作り、撮影スロットをそのレイヤーの現在コマに移す。手動撮影もシーケンスもそのレイヤーに沿って進む。park ショットの行き先は Shot Sequence 設定の「Park layer」（未指定なら "Park" を自動作成）、再演パスは `Replay k<n>` を作って進行に id を保存。§14.2 のフォルダ分けと移行は未実装。
- **LED 追従**: LED ストアは撮影コマ（`captureShot.frame`）に合わせて自動でその照明を出す（`followCapture`）。`workLight` で一時的に全白、戻すとコマの照明に復帰。シーケンスの `led` ステップは「出ていることを確認して ACK を待つ」だけ。
- 揺れ判定はまだ固定待ち（`settleMs`）。ライブビュー差分は未実装。

### 作業座標（cncjs 風）
- MachinePanel は軸ごとに **Machine（MPos）と Work（WPos）** を並べ、Work 側に「ここをゼロ」「値を指定」（どちらも `G10 L20 P1`、動かずにオフセットだけ変わる）と「Work 0 へ移動」。「Zero all here」「Go to 0」も。リグは撮影で機械座標しか使わないので作業座標はジョグの目安用。フライス盤の G54 はシーケンスが毎コマ `G10 L2 P1` で film 原点に合わせ直すので、手でゼロを切ってもコマ撮り時には上書きされる。
- 校正の近道: Shot Sequence 設定「Mill offset」の照準ボタン = 工具先端が film 原点（ブロック A の底面角、テーブルは撮影位置）にある状態で押すと `millOffset = filmOriginWorld + [0, 60·k, 0] − cycle(mpos)` を確定。

### 切削パス（G-code）の表示
- パーサ `src/utils/fluidnc/toolpath.ts`（G0–G3・平面・G90/91・G20/21・G53 はスキップ、円弧は折れ線化、行番号つき、vitest あり）。
- **exhibit の G-CODE 区画**（図録の `gcode-viz.psd` の作法）: いま映っているコマの NC を、細線（切削 = 白 45%、ラピッド = 灰 25%）＋各行の G-code 文字を移動終点に添えて、ゆっくり回る透視投影で 2D canvas に描く。ヘッダ行（G90 G94 … M3）は始点に積む。文字数は区画面積に応じて間引き。NC の解決: 本編／previz コマは `previz/frames.json`、他レイヤーのテイクは `project.addsub.layerGcode[layerId]`（`%04d` = そのレイヤーのフレーム）。vice-tests-2021 では 2021 年の `render/<scene>/<scene>_nc/<scene>.NNN_T?.nc`（フレーム NNN = 1 始まり、T は最大のもの）を `previz/gcode/<scene>/%04d.nc` に取り込み済み（pole / natori / bevel / arcwave / scifi / logo。arc2 と VICE_001 は該当無し）。
- koma 本体の 3D プレビューには G-code を出さない（ユーザー判断）。exhibit 側の線は WebGL（three.js LineSegments）で描き、14k 行のファイルでも 60fps。文字は 200 行に 1 つ。

### 座標・運動学（§3.0, §7.1, §10）
- `src/addsub/coords.ts`, `kinematics.ts`。R = Ry(pan)·Rz(roll)·Rx(tilt)、分解は `rotationToAngles`（ロール ±90° でジンバルロック）。IK/FK は vitest で往復確認済み。
- **実機で要確認の仮定**: 回転軸の符号（`calibration.rotarySigns`）、film 原点の world 位置（`filmOriginWorld`）、`rigOffset`、`millOffset`、フライス盤は X/Y ともテーブル移動（AST200）として `tableShiftWorld` で扱っている。
- 校正ウィザード（§12）は未実装。値は Shot Sequence パネルの Settings で手入力。

### LED 配置と Box Rig の見た目（§8、Houdini から書き出す）
`previz/set.json`（koma は読むだけ。frames.json と同じ監視）:
```json
{
  "version": 1,
  "led": {
    "layoutVersion": 1,
    "imageWidth": 6000,
    "pitch": 33.333,
    "lines": [
      {"name": "L1", "pixels": [[x, y, z, u], ...]},
      {"name": "L2", "pixels": [...]}, ... 8 本（ws-fanout のライン順 L1 L2 B1 B2 R1 R2 F1 F2）
    ]
  },
  "geometry": [
    {"name": "rig",  "file": "geo/rig.glb",  "wireframe": true, "color": "#888888", "opacity": 0.6},
    {"name": "walls", "file": "geo/walls.glb"}
  ]
}
```
- `pixels` は粒ごとに **world 座標 [x, y, z]（mm）と展開図上の横位置 u（mm, 左端から）**。縦は koma が粒の world Y から film lift（60·k_base + film 原点 Y）を引いて展開図の `topFilmY` 基準に変換するので、`set.json` は k_base に依存しない。`imageWidth` は展開図の幅（mm）で、画像の px スケールはこれから決まる。
- `geometry` は表示専用の glTF（Houdini の ROP glTF、mm 単位）。リグ・壁・フライス盤など任意。無い間はパラメータ生成の立方体外形を出す。
- `set.json` が無いときだけ `led/layout.ts` の生成器にフォールバック。**実測（2026-09-25）: 壁は X 1831 × Y 1400 × Z 1991 mm、テープ 1400 mm = 高さなので縦置き、粒ピッチ 33.3 mm、テープ間隔 100 mm。** L/R 面（1991）に 19 本（ライン 1 = 10 本、ライン 2 = 9 本）、B/F 面（1831）に 18 本（10 + 8）を中央寄せで並べ、ライン内は上→下→上のジグザグ。開始側（`startSide`）と壁の上端 Y（`topY` = 1400 と仮定）は要確認。
- **Box Rig の可動域（2026-09-25）**: X 1200・Z 1200・Y 900（上でホーミング、負方向）。Y 下げ切りで高さ 400（仮）→ 既定の `rigOffset = [−600, −1300, −600]`（X/Z は可動域中心 = world 原点と仮定）、`rigLimits = x [0,1200], y [−900,0], z [0,1200]`。
- 粒ごとにピッチ幅のボックス平均でサンプル。firmware の INFO と粒数が食い違うと LED パネルにエラーを出す。

### 展示画面（§15）
- `/exhibit.html`。`?screen=a`（ループ再生、BroadcastChannel で再生位置を配信）/ `?screen=b`（グリッド）/ 無指定で並列表示。フォルダハンドルは IndexedDB、`project.json` を 4 秒ポーリング。全体モノスペース（Fira Code）。
- **画面 A は「全テイク」**: 全レイヤー（本編・テスト・再演・park）のショットと `_trash` のミスコマを **撮影日時順**に並べ、ブラウザ内で **WebCodecs（H.264）+ mp4-muxer で MP4 に変換**して `<video loop>` で滑らかにループ再生する（ffmpeg 相当をネイティブ依存なしで）。動画は OPFS にキャッシュ（テイク一覧の署名がキー）、新しいテイクが増えると 10 分に 1 回を上限にバックグラウンドで作り直す。エンコード中や WebCodecs が無い環境は `_lv` の画像差し替えで再生。再生位置（動画時間 → テイク index）を画面 B に配信。
- **画面 B**: 分割グリッド（FRAME = 今映っているテイクのメタデータ: 番号・撮影日時・レイヤー名 / 破棄テイク・露出・k・リグ軸、SEQUENCE、DEVLOG の QR、ライブビュー / G-code / 3D はリレー未実装でプレースホルダ）。
### テストデータ: 2021 年の VICE 撮影（Dragonframe）の取り込み
- `scripts/import-dragonframe.mjs <dgn-root> <dest> --name …` で Dragonframe の `.dgn` を koma プロジェクトに変換（テイクごとに名前付きレイヤー、フレーム 0 始まり。EDL から外れたコマは `_trash` に「撮影されたフレーム」つきで入る。EXIF + take.xml のメタデータ、meta.txt の FIRST FRAME でカメラ時計を補正。jpg は 3000px に縮小、lv は 1920px、RAW はコピーせず名前だけ）。
- 生成済み: `~/Dropbox/Works/2024/10_addsub/capture/vice-tests-2021`（"VICE tests 2021"、14 テイク = 440 コマ + 破棄 145、1.2 GB）。プリセット "All takes" / "Main only"。
- `scripts/import-sequence.mjs <dir> <project> --name …` で画像連番をレイヤーとして追加（`Previz (shapes)` = `prj/render/2024_10_addsub_shapes.viewport_preview1_cache` の 840 枚を取り込み済み）。
- 展示は **"Exhibit" という名前のプリセット**があればそのレイヤーだけを対象にする（previz 等の参照レイヤーを外すため）。vice-tests-2021 では "Exhibit" = 撮影テイク 14 レイヤー（previz 除外）。
- 展示ページの確認用に `exhibit.html?opfs=<name>&seed=<url>` を追加（フォルダピッカー無しで、URL から project.json と lv を OPFS に流し込んで読む）。dev では `public/_dev-*` のシンボリックリンク（gitignore 済み）で実フォルダを配信。

### 手元で試す（ハード無しの確認）
- `yarn test`（parse・IK・LED map）。
- ESP32 dev board に FluidNC を焼き、config.yaml に `name: BoxRig` を書けば、モーター無しでも識別・自動再接続・ジョグ送信・Idle 待ちを確認できる。`name: AST200` にすればフライス盤側。
- 同じ板に `dev_modules/ws-fanout/firmware` を焼けば（NodeMCU は BOOT 長押し個体あり）、LED 未接続でも INFO / SHOW ACK まで通る。

### 未実装（仕様にあるもの）
- §8.1 AE リアルタイムプレビュー、§9 ライブビューのキャスト、§12 校正ウィザード、§13.2 Houdini とのリアルタイム通信、§14 レイヤー種別と保存フォルダ、§15 のリレー依存パネルと `_lv` キャッシュ、揺れ収束のライブビュー判定、脱調検知。
