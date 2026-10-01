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
- 被写体: ブロック（目安 60mm 高、揃えなくてよい）。材料は固定しない（スタイロフォーム、レジン、蝋、アルミ、木など。異素材の積層に限らない）。ブロックの継ぎ足しは 7章
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
- ブロックの高さは揃えなくてよい（目安 60mm）。座標に効くのはブロックの枚数ではなく、A の下に継ぎ足したブロックの **高さの合計 = film lift（mm）** だけ。LED の段ずらしも展開図からのサンプル位置を lift ぶんずらして表すので（8章）、LED のピッチ（33.3mm）と揃える必要も、整数粒である必要もない
- 次のブロックを載せられるのは、上段の残り + 次のブロックの高さ ≤ 100 になってから。交換のしきい値は運用で決める（目安 20〜40mm）

### 7.1 座標系

- **film 座標**: world と同じ向き（Y-up）で、最初のブロック A の底面の角を原点にする。切削が進むと、作業面は film 座標の中を **下へ** 下がっていく
- 2つ目のブロック B は A の下（Y = −h_B〜0）。以降も順に下へ積む
- **world Y = film Y + filmLift + film 原点の高さ**。`filmLift` は A の下に継ぎ足したブロックの高さの合計（mm）で、`project.addsub.filmLift` に持つ。盤上から見ると、段を足すたびに film の世界がそのブロックの高さぶん持ち上がる。カメラと LED が world 座標で上がっていくのはこのため
- LED は filmLift ぶんずらす（8章）
- 切削パスも film 座標で持つ
  - CAM は Fusion 360。書き出した G-code には手を入れない
  - Fusion のセットアップの WCS 原点を film 座標の原点（ブロック A の底面の角）に置き、軸の向きはフライス盤に合わせる（3.0 の対応）。G-code は WCS 基準の座標と `G54` の選択だけを含む
  - koma は各コマの G-code を流す前に、別のコマンドとして `G10 L2 P1 X.. Y.. Z..` を送り、G54 の原点を「film 原点がいまフライス盤のどこにあるか」に合わせる（**Cut パネルの「Set G54」がオンのときだけ**。既定はオフ、実装メモ「cut が G54 を上書きする件」参照）。段を継ぎ足すと、この Z が filmLift ぶん上がる
  - そのため、継ぎ足しても G-code を書き出し直す必要はない
  - Fusion のポストプロセッサが `G10` などで原点を書き換えないことは確認しておく

### 7.2 交換手順

1. 上段の残りが 20mm 未満になったら止める
2. 次のブロックの完全体だけを盤上に載せる
3. **再演パス**: 既存の全コマを、記録済みのカメラ姿勢・露出・LED で、filmLift の差分だけ持ち上げて自動で撮り直す
4. 上段の残りを接ぐ
5. 続きのコマから再開する（カメラは継ぎ足したブロックの高さぶん上から）

### 7.3 koma 側でやること

- 再演パスは 1ブロック = 1レイヤーとして持つ（14章の「再撮影」レイヤー）
- filmLift の更新は「Append Block…」（高さを入力して足す）か、millOffset 校正済みの状態で工具先端を接合面（= 今の film 原点）に当てて実測する照準ボタン。実測のほうが接着層や寸法誤差を吸収できる
- 再演パスの所要時間を見積もる
- Box Rig の縦軸（Y）のストロークの範囲で何段まで行けるか確認する
- 途中で止まったときに再開できるよう、進行状況を project に残す

---

## 8. LED ライティングの記録と再現

- 各コマの LED は **4面の展開図の画像** で持つ。これがそのコマのライティングの元データ
- 画像は film 座標で描く。段ずらし（7章）のぶん、物理的な LED の範囲より下に長くしておく（余白は予定する filmLift の最大値）
- 実機に送るときは、画像を縦に filmLift ぶんずらして、各粒の位置の色を拾う
  - 粒の位置はピクセルの中心と揃わないので、程よく補間する（バイリニア、または LED のピッチ程度の範囲の平均）
  - ブロックの高さと LED のピッチ（33.3mm）は揃っていないが、補間で拾うので問題ない
- **配置マップ**: 各粒の展開図上の座標（面、水平位置、film Y）を ws-fanout のライン順に並べた表。テープ 1400mm、100mm 間隔のジグザグ、33.3mm ピッチ、折り返し位置から生成する
- 送った RGB は画像・配置マップ・filmLift から再計算できるので、保存するのは画像と、配置マップのバージョンだけでよい
  - （2026-10-01 変更）画像の無い照明（faces / Houdini live / 手動 fill）でも撮るので、撮影時に送出した全粒の RGB もショットごとに記録する（実装メモ「ショットの LED 記録」）
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
- Box Rig の XYZ = c + (0, filmLift, 0) + 機械オフセット（12章の手順3で求める）

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
- **撮影データの受け渡し**: （2026-09-27 に変更、実装メモ「koma-relay」参照）Mac mini 常駐の koma-relay へ撮影機の koma が表示用コピーを push し、展示画面はそれを HTTP で読む。以下の Dropbox + フォルダピッカー方式はフォールバックとして残る
- （旧案）撮影機の koma プロジェクトフォルダを Dropbox などで Mac mini に同期し、展示画面から Chrome の File System Access API（`showDirectoryPicker()`）で直接読む
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

### filmLift（2026-09-28、k_base を廃止）
- 旧 `kBase`（最下段ブロックの番号、lift = 60·kBase）は、ブロック高さが一定でないと成り立たないので **`project.addsub.filmLift`（mm）** に置き換えた。座標・LED・G54 原点・再演・recall はすべてこの mm 値だけを使う。ショットは `shot.filmLift` を記録（旧 `shot.kBase` は読み込み時 `migrateAddsubData` で 60·kBase に変換、`_trash` も含む）。
- `project.addsub.blockHeight` は「次に足すブロックの高さ」の既定値（Append Block… の初期値、3D の表示用キューブ）。
- exhibit の relay / project.json 読みは `filmLift` を見て、無ければ旧 `kBase` から換算する。

### コミットの分け方
- `main` に戻せる汎用: `src/utils/fluidnc/`（WebSerial クライアント・status/`$I` パース・G-code ビルダ・vitest）、`src/utils/serialDiscovery.ts`、`src/stores/machine.ts`（`defineMachineStore` ファクトリ）、`src/components/MachinePanel.vue`、`TitleBarMachineConnection.vue`、project ストアの `directoryHandle` 公開と open 時の既定値 cloneDeep。
- 作品固有（このブランチに閉じる）: `src/addsub/**`、`src/exhibit/**` + `exhibit.html`、`App.vue`/`TitleBar.vue` の組み込み、`dev_modules/ws-fanout` submodule、Tracker UI の撤去。

### 機器接続（§3.5）
- 2 台の FluidNC は `$I` の `[MSG: Machine: <name>]` で識別する。**config.yaml の `name:` を `AST200`（フライス盤）/ `BoxRig`（Box Rig）にする**（既定。各パネルの config `machine.<id>.fluidncName` で変更可）。
- **名前で当たらなければ「Grbl っぽいもの = フライス盤」**（2026-09-28）: `MachineDefinition.fluidncFallback`（mill に設定）。`findOwner` の順位は 名前一致（接続済みでも勝つ→その場合は拒否）→ 名前無指定の機械 → fallback 機。無名ボード・素の Grbl・古い config.yaml でも mill に入る（ログに「Taken as … because "<name>" matches no machine name」）。BoxRig は名前一致のみ。
- **どの Connect… ボタンから選んでも正しい機器に届く**: `requestSerialPort(preferred?)`（`utils/serialDiscovery`）は選ばれたポートを preferred ファミリ → 他の全ファミリ（FluidNC / LED Wall）の順で probe し、`{status, family}` を返す。他所に繋がったら押したパネルに「That port is the LED Wall — connected it there」等を出す。コマンドパレットに `Connect Serial Device…`（preferred 無し）と `Rescan Serial Ports`（`discoverSerialPorts()`）。手動選択は過去の rejection を無視して再 probe、バックグラウンド discovery は rejection を尊重。`SerialFamily` に `label` 必須。
- **接続まわりの堅牢化（2026-10-01、実機未確認・vitest `serialDiscovery.test.ts` のみ）**: (1) 所有表 `owners` は `SerialFamily.holder(port)`（そのファミリが今そのポートで開いている機器名、無ければ null）と照合し、裏付けの無い記録は捨てる。(2) probe は 1 回 12 秒で打ち切る（`port.open()` / `close()` には timeout が無く、1 ポートが戻らないと `running` が終わらず以後の Connect が全部「Connecting…」のまま固まっていた）。打ち切りは `{status:'rejected', stuck:true}`。(3) ポートを選んでいる間にバックグラウンド discovery が同じポートを繋いだ場合は `owned` でなく `adopted`。(4) エラー文は `serialRequestError()` に集約し、ポートの素性（`describeSerialPort` = チップ名 + VID:PID、例 `CP210x 10c4:ea60`）と掴んでいる機器名（`Box Rig` / `Mill` / `LED Wall`）を出す。(5) `Rescan Serial Ports` は rejection を消してから再走査（USB を先に挿して後から電源を入れた基板を拾い直せる）。(6) ws-fanout の `WebSerialTransport` は読み取りループが自分で終わったとき（フレーミング／ブレーク／オーバーランなどの非致命エラー、抜線）もポートを閉じる。以前は切断通知だけ出してポートを開いたままにしていたので、リロードまで LED に再接続できなかった（`sender/test/serial.test.ts`）。
- **Hold 中の基板への接続（2026-10-01）**: FluidNC は Hold / Door の間、リアルタイム文字（`?` `~` `^X` など）にしか応えず、行コマンドは `$I` も含めて実行も `ok` もしない（v3.9.9 `Protocol.cpp`: 行を実行するメインループが `protocol_exec_rt_suspend()` の中で止まる）。Idle で `!` を送っても Hold になるので、`stop()` / ESTOP のあとリロードすると両機とも Hold で、以前は `$I` が timeout → 「FluidNC ではない」と拒否 → Resume / Reset は接続しないと押せない、で電源を入れ直すしかなかった。
  - `identify()` は `?` が Hold / Door を返したら `$I` を送らない（待たされた行は解除後に走り、その遅れた `ok` が別の行の返事になるため）。
  - **機械のパネル / タイトルバーの Connect… から選んだとき**: その機械に「未識別」で仮接続する（`machine.unidentified`）。パネルに Resume / Reset が出て、行コマンド（`send` / `stream`、ジョグ・ホーミング・unlock）は拒否。Hold を抜けたら 300 ms 待って `$I`（`confirmIdentity`）→ 自分なら確定、別の機械なら切断して discovery がそちらへ渡す（ピッカーでは 2 台を見分けられないので、取り違えても解除後に正しい側へ行く）。
  - **バックグラウンド discovery / 他所からの pick**: 繋がずに閉じ、probe は `{undecided: 文}` を返す（`SerialProbeResult` の第三の答え）。rejection には数えないので次の discovery でまた訊く。LED など残りのファミリには回さない。未接続の機械のパネルに「Hold 中の基板がある、Connect… で選んで resume / reset」を出す。
  - タイトルバーのポップアップにも `lastError` を出す（以前は無言で「Not connected」に戻った）。
  - 確認はヘッドレス Chromium + 偽の FluidNC 2 台（Hold 中は行を溜めて返さない）: 起動時の案内、仮接続 → Reset / Resume → 識別、取り違え → もう一方へ引き渡し、未識別中はジョグ無効。**実機では未確認**（`^X` 後に Alarm になる設定、Door 状態、解除直後に古い行の `ok` が返る場合）。
- **PiBot V4.96 Pro の USB まわり（販売元ページより、実機では未確認）**: USB-UART は「CP2102-class」。LED の NodeMCU（CP2102）と同じ VID:PID になるので、3 台ともピッカーの表示でも `describeSerialPort` でも区別できない（macOS の `cu.usbserial-…` も挿した順で変わる）。機器の判別は probe だけが頼り。基板に **USB 5V test jumper** があり、挿すと USB の 5V で基板が動く（ベンチテスト用）。主電源 12–24V を繋ぐ前に外す指定。外した状態では USB だけ挿しても ESP32 は動かない。
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
- `cut` は（`cutSetsWorkOffset` がオンなら）先に `G10 L2 P1` で G54 原点を `filmOriginMill(filmLift)` に合わせてから G-code を流す。`extend` 前の table 位置を `returnPosition` に保存し `retract` で戻す。
- `stop()` = abort + 両機に feed hold。**ESTOP**（タイトルバーの赤ボタン / コマンド `estop` / `shift+escape`）= シーケンス実行中でなくても両機を同時に feed hold + 主軸停止（0x9E）。復帰（`~`/`$X`/reset）は機械パネルから。
- Sigma fp の撮影は App.vue の `shoot()` をそのまま使う（`sequence.registerCapture`）。park 参照ショットは kind `park` のレイヤー（無ければ作る）に入る。
- **再演パス（§7.2）**: `startReplay(range)`。記録済みショットの rig 軸を `Δlift`（現在の filmLift − 撮影時の `shot.filmLift`）だけ持ち上げ、LED 画像を現在の lift で再サンプル、露出を再適用して kind `replay`・ラベル `Replay +<lift>mm` のレイヤーに撮り直す（rig ∥ led → settle → capture）。
- **レイヤー（§14.1 の実装）**: レイヤーは「名前付きの独立したタイムライン（本編とフレーム番号を共有）」で、いくつでも作れる（`project.layers[i] = {id, name}`、index = `koma.shots[]` のスロット。追加のみで並べ替え・削除はしない）。機能の割り当ては無く、テストも再演も park もただの名前付きレイヤー。**表示情報はプリセット** `project.layerPresets[]`（`{id, name, layers: [{layerId, opacity, mixBlendMode}]}`、配列順 = 表示順（下→上）、載っていないレイヤーは非表示）で、`activeLayerPreset` で切替。Layers ダイアログ（`command+shift+L` / Timeline 左端のレイヤー名クリック）でプリセットの作成・改名・削除、レイヤーの表示/順序/ブレンド/不透明度、追加、撮影先の指定。タイムライン・プレビューはアクティブなプリセットの順で合成（`compositeLayers`）。**「画像の下をクリックするとレイヤーが増える」挙動は廃止**（↑↓は表示順で移動）。旧ファイルはレイヤーの opacity/blend を "Default" プリセットへ移行。
- **レイヤーの削除と一覧の並び（2026-10-01）**: レイヤーは保存スロット（index = `koma.shots[]` の位置、ファイル名にも入る）なので、**削除はスロットに印を付けるだけ**（`layer.deleted`）。ショット・ファイル・plan はそのまま、番号の振り直しもファイル移動も無い。削除したレイヤーは全プリセット・タイムライン・Park layer の選択肢・relay の push・exhibit（本編の穴埋め previz、他テイク、そのレイヤーの `_trash`）から消える。Layers ダイアログの各行のゴミ箱で削除、下の「Deleted」欄の Restore で戻せる（全プリセットの一番上に非表示で戻る）。本編（layer 0）は削除不可、撮影スロットが載っていたら同じコマの本編へ移す。undo には乗らない。**ディスクは空かない**（完全消去は未実装）。
  - プリセットは `stack`（非表示も含む全レイヤーの並び、`hidden` 付き）を正とし、`layers`（表示中だけ）はそこから毎回作り直す派生。古いビルド（配信中の exhibit など）は `layers` だけを読むので従来どおり動く。Show のオン/オフは `hidden` を切り替えるだけなので**行が動かない**（以前は非表示にするとプリセットから外れ、戻すと一番上に入り直し、blend / opacity も消えていた）。Order の上下は非表示の行にも効く。旧ファイルはプリセットに無いレイヤーを一番上に非表示で足す。
  - exhibit が previz を映すのは「Exhibit」プリセットとは別の仕組み（名前に previz を含むレイヤー、または「Previz」プリセットのレイヤーで、本編の未撮影コマを埋める）。映したくなければそのレイヤーを削除する。
  - 確認済（スクラッチの Chromium）: Show 切替で行順不変、UI からの削除 → プリセット・表示から消える / ショットは残る / 撮影スロットが本編へ、リロード後も維持、Restore、exhibit のテイク数 7 → 4（previz の穴埋め 3 が消える）。
- **テストショット**: 「New Test Shot…」で名前付きレイヤーを作り、撮影スロットをそのレイヤーの現在コマに移す。手動撮影もシーケンスもそのレイヤーに沿って進む。park ショットの行き先は Shot Sequence 設定の「Park layer」（未指定なら "Park" を自動作成）、再演パスは `Replay +<lift>mm` を作って進行に id を保存。§14.2 のフォルダ分けと移行は未実装。
- **LED 追従**: LED ストアは撮影コマ（`captureShot.frame`）に合わせて自動でその照明を出す（`followCapture`）。`workLight` で一時的に全白、戻すとコマの照明に復帰。シーケンスの `led` ステップは「出ていることを確認して ACK を待つ」だけ。
- **In → Out の連続撮影（2026-10-01）**: `sequence.startRange()`（Shot Sequence の Run「In → Out (a–b)」/ コマンド `sequence_run_range`）。プレビュー範囲の in から out まで、撮影レイヤー上で 1 コマずつ通常のシーケンスを回して out で止まる。既にショットのあるコマは撮り直し（旧ショットは `_trash`）。撮影のたびに out-point が撮影カーソルへ動く既存の挙動は、範囲実行中は毎コマ・終了時に元の範囲へ戻す。途中で止めたら Resume が残りの範囲を続ける（`progress.range`）。plan / previz の無いコマに当たるとそこで止まる（Continuous と同じ）。
- **settle = 固定待ち + ライブビューが静止するまで（2026-10-01、`src/addsub/motion.ts`）**: `settleMs` は必ず待つ最小値。`settleStill`（既定オン、Settings の「Until Still」）なら、その後もライブビューの連続フレーム差分（160×108 グレースケールの平均絶対差）が「静止時のレベル × 1.5」以下で 1 秒続くまで待ち、`settleMaxMs`（既定 20 秒）で打ち切って撮る（warning を出す）。静止時のレベルは rig を動かす直前に 0.8 秒測り、実行中は**下げる方向にだけ**更新する（前コマの揺れ残りで基準が甘くなっていかないように。打ち切りになったら測り直し）。ライブビューが無い・更新されないときは固定待ちだけ。実行中のメッセージに `motion 0.82 (still ≤ 0.60)` と出るので、効き具合はそこで見る。
  - 確認はハード無し（偽のリグ + 減衰振動するライブビュー）: 固定 2 秒では残り振幅 3.6 px で撮っていたのが、静止待ちで ~7 秒・0.4–0.5 px。**実機のライブビュー（ノイズ、LED のちらつき、PTP の fps）でしきい値が妥当かは未確認**。効きすぎる（毎コマ打ち切りまで待つ）ならオフにして `settleMs` を伸ばす。定数は `sequence.ts` の `STILL_FACTOR` / `STILL_HOLD_MS`。

### 作業座標（cncjs 風）
- MachinePanel は軸ごとに **Machine（MPos）と Work（WPos）** を並べ、Work 側に「ここをゼロ」「値を指定」（どちらも `G10 L20 P1`、動かずにオフセットだけ変わる）と「Work 0 へ移動」。「Zero all here」「Go to 0」も。リグは撮影で機械座標しか使わないので作業座標はジョグの目安用。フライス盤の G54 は「Set G54」オン時にシーケンスが毎コマ `G10 L2 P1` で film 原点に合わせ直すので、手でゼロを切ってもコマ撮り時には上書きされる。
- 校正の近道: Shot Sequence 設定「Mill offset」の照準ボタン = 工具先端が film 原点（ブロック A の底面角、テーブルは撮影位置）にある状態で押すと `millOffset = filmOriginWorld + [0, filmLift, 0] − cycle(mpos)` を確定。「Film lift」の照準ボタンはその逆で、millOffset 確定後に接合面へ当てて `filmLift = mpos.z + millOffset.y − filmOriginWorld.y` を実測。

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
- `pixels` は粒ごとに **world 座標 [x, y, z]（mm）と展開図上の横位置 u（mm, 左端から）**。縦は koma が粒の world Y から film lift（filmLift + film 原点 Y）を引いて展開図の `topFilmY` 基準に変換するので、`set.json` は filmLift に依存しない。`imageWidth` は展開図の幅（mm）で、画像の px スケールはこれから決まる。
- `geometry` は表示専用の glTF（Houdini の ROP glTF、mm 単位）。リグ・壁・フライス盤など任意。無い間はパラメータ生成の立方体外形を出す。
- `set.json` が無いときだけ `led/layout.ts` の生成器にフォールバック。**実測（2026-09-25）: 壁は X 1831 × Y 1400 × Z 1991 mm、テープ 1400 mm = 高さなので縦置き、粒ピッチ 33.3 mm、テープ間隔 100 mm。** L/R 面（1991）に 19 本（ライン 1 = 10 本、ライン 2 = 9 本）、B/F 面（1831）に 18 本（10 + 8）を中央寄せで並べ、ライン内は上→下→上のジグザグ。開始側（`startSide`）と壁の上端 Y（`topY` = 1400 と仮定）は要確認。
- **Box Rig の可動域（2026-09-29 更新）**: **X/Z は機械原点（枠の中心）を挟んで −550…+550**、Y は 0…−900（上でホーミング、負方向）。Y 下げ切りで高さ 400（仮）→ 既定の `rigOffset = [0, −1300, 0]`（X/Z は機械原点 = world 原点）、`rigLimits = x [−550,550], y [−900,0], z [−550,550]`（`config.ts` の `RIG_LIMITS`）。旧 placeholder（0…1200 / offset [−600,−1300,−600]）のまま保存されたプロジェクトは `migrateAddsubData` が新既定に置き換える（ユーザーが編集した値は触らない）。Plan パネルとジョグの範囲もこれに従う。
- 粒ごとにピッチ幅のボックス平均でサンプル。firmware の INFO と粒数が食い違うと LED パネルにエラーを出す。

### 展示画面（§15）
- `/exhibit.html`。`?screen=a`（ループ再生、BroadcastChannel で再生位置を配信）/ `?screen=b`（グリッド）/ 無指定で並列表示。フォルダハンドルは IndexedDB、`project.json` を 4 秒ポーリング。全体モノスペース（Fira Code）。
- **画面 A は「全テイク」**: 全レイヤー（本編・テスト・再演・park）のショットと `_trash` のミスコマを **撮影日時順**に並べ、ブラウザ内で **WebCodecs（H.264）+ mp4-muxer で MP4 に変換**して `<video loop>` で滑らかにループ再生する（ffmpeg 相当をネイティブ依存なしで）。動画は OPFS にキャッシュ（テイク一覧の署名がキー）、新しいテイクが増えると 10 分に 1 回を上限にバックグラウンドで作り直す。エンコード中や WebCodecs が無い環境は `_lv` の画像差し替えで再生。再生位置（動画時間 → テイク index）を画面 B に配信。
- **画面 B**: 分割グリッド（FRAME = 今映っているテイクのメタデータ: 番号・撮影日時・レイヤー名 / 破棄テイク・露出・k・リグ軸、SEQUENCE、DEVLOG の QR、LIVE VIEW（上段右の大区画）、BOX RIG / MILL の座標、G-CODE）。ヘッダに `● LIVE / ○ OFFLINE`（撮影機の接続）。
- **A→B の同期（2026-09-28）**: A は BroadcastChannel に `{index, filename}` を流し（変化時 + 1 秒ごとの heartbeat）、B は **ファイル名で**自分の一覧に照合する（`store.syncTo`）。2 窓は project.json の版が違い得る（テイク追加直後、A が古い一覧でエンコードした動画を再生中）ので index だけだと本編に 1 コマ増えた時点でずれる。A 側も動画を「エンコード時のテイク一覧」（`videoFrames`）で時間→テイクに直してから現一覧に照合する。「Open A and B on two screens」は `noopener` で開く（同一オリジンの popup は opener と同じレンダラ = 同じメインスレッドを共有し、B の WebGL/デコードが A の動画を止めるため）。`?relay=` / `?opfs=` は新窓に引き継ぐ。
- **G-CODE 区画の負荷（2026-09-28）**: 以前は A が 18fps で進むたびに B がその NC を fetch → メインスレッドで parse → `ref()` で deep reactive 化（数万要素の segments が Proxy 越しになる）→ geometry 再構築、で毎コマ数十 ms 落ちていた。今は `toolpath.worker.ts` が Worker で parse して three.js 軸の Float32Array（transferable）を返し、`toolpathParser.ts` が path キーで LRU(60) キャッシュ、Pane は `shallowRef` で受け、差し替えは **400 ms スロットル**（leading + trailing）。切削中の進捗ハイライトは色属性の書き換えだけ（`setSent`）。実測（vice-tests、Playwright）: 18fps でテイクを流して 12 s に 12 ファイル差し替え、rAF 60fps、longtask 0。
- **ソースの選択と復元（2026-09-28）**: 起動時は relay を探し（**`/api/status` が JSON で `capture` を持つ時だけ relay と見なす** — vite dev は任意パスに index.html を 200 で返すので、以前は dev で常に relay 扱いになり `?opfs=` も記憶フォルダも効かなかった）、`localStorage` の `sourcePref` が `dir` なら IndexedDB のフォルダハンドルを優先、無ければ relay → `?opfs=` → 記憶フォルダ。relay が見つかれば live 状態はどのソースでも購読する（フォルダを選んでも relay を切らない）。Setup の「Use relay instead」で戻せる。再起動後の `prompt` 状態はページ上の最初の click / key で `requestPermission` を呼ぶ（ボタンを探さなくてよい）。Chrome の "Allow on every visit" を選べば以後不要（Chrome 122+、IndexedDB から復元したハンドルの再プロンプトで出る）。`navigator.storage.persist()` も要求。

### 画面 A の一時停止（2026-09-29）
- **Space で画面 A を停止 / 再開**。キーを受けるのは `Exhibit.vue`（どのウィンドウでも）で、BroadcastChannel `koma-exhibit` に `{type: 'toggle-pause'}` を流し、`ScreenA.vue` が受ける（同じウィンドウの別 BroadcastChannel インスタンスにも届くので、並列表示・A 単独・B 単独のウィンドウのどれで押しても同じ経路）。Setup の input / button にフォーカスがあるときの Space はそのコントロールのもの。
- 停止中は `<video>` を pause、画像フォールバックはコマ送りを止める。heartbeat の announce は続くので画面 B はそのコマのまま。カウンタに `❙❙ paused`。
- **5 分で自動再開**（`PAUSE_TIMEOUT`）。止めたまま忘れても展示が固まったままにならない。
- 停止中は動画を差し替えない（頭に飛ぶので）: `ensureVideo` は何もしない、進行中のエンコードが終わったら `pendingVideo` に置いて再開時に切り替える。
- 環境音は止めない（映像と独立のループ）。
- 確認済（Playwright、OPFS の vice-tests）: 画像フォールバック / 動画の両方で停止・再開、B のウィンドウから止めて A のウィンドウから再開、B が同じコマで止まる。5 分の自動再開と、停止中にエンコードが終わる場合は未確認。

### 画面 A の環境音（2026-09-28）
- Max Cooper のトラックから **クリック/パーカッション成分だけ**を抜いたステム `public/sound/exhibit-clicks.mp3`（4:59、320 kbps、ピーク −3.9 dB / 平均 −37 dB。疎な音なので静か）を、画面 A が載っている窓（`?screen=a` と両方表示）で `<audio loop>` ループ再生する。`src/exhibit/sound.ts`（`useExhibitSound`）、Exhibit.vue の Setup に On/Off と音量（localStorage `exhibit.sound.*`、展示機ごと）、`?mute` で強制無音。映像との同期はしない（独立ループ）。
- autoplay: キオスク Chrome は `--autoplay-policy=no-user-gesture-required` で起動するので即再生。ブロックされる環境では Setup に "autoplay blocked" と出て、ページ上の最初の click / key で始まる（headless Chromium で両経路確認済み）。
- 抜き出し方（再現用）: `demucs -n htdemucs -d mps --mp3` で 4 ステム → `other` を librosa の HPSS（`margin=(1.0, 3.0)`）で percussive 側だけ取ったもの。drums ステムではなく other の percussive がクリックだった。demucs は `pipx install --python python3.11 demucs` + `pipx inject demucs numpy librosa soundfile`（Python 3.14 は torch 不可）。

### 展示画面の堅牢化メモ（2026-09-28）
- **画面 A の `<video>`/`<img>` は絶対配置 + `object-fit: cover`**（ユーザー指定）。以前は grid 内の `height:100%` が auto 行に対して解決できず、3:2 の動画が幅から高さを取って下にはみ出していた（1600×1000 のペインで縦 1066 px を実測）。
- `store.readText` のテキストキャッシュを LRU(100) に（画面 B は表示コマごとに NC を読むので、以前は全コマ分を保持し続けた）。
- koma-relay: WebSocket 毎に `error` リスナー（無いと不正フレーム 1 つで Node ごと落ちる。予約 opcode を送る probe で生存確認済み）、`server.on('error')`、`unhandledRejection` のログ化。
- **Chrome 自体が落ちる件（dev、2026-09-24〜）**: ブラウザプロセスの `partition_alloc_support.cc: Detected dangling raw_ptr in unretained`（Chrome 153 内部のバグ検出）。ダンプに WebUSB スレッドがあり koma 本体（Tethr/WebSerial）と同居していた。別プロファイルで exhibit と本体を 65 回リロードしても再現せず。切り分けは「exhibit を別プロファイルで開く」（本番のキオスクと同じ構成）。

### 展示機への受け渡し: koma-relay（2026-09-27）
Dropbox 同期とフォルダピッカー方式をやめ、**常時稼働する展示機（Mac mini）側に小さな Node サーバー `dev_modules/koma-relay` を置き、撮影 PC の koma はそこへ push する客**にした。撮影 PC が居なくても展示機は最後に push されたコピーで回り続け、居れば同じ経路でライブ状態が届く。2 台は Ethernet 直結（link-local + Bonjour、`koma-exhibit.local` のようなホスト名。保険に固定 IP も可）。

- **サーバー** (`yarn relay` だけで起動。既定 = port 7777、表示用コピー `~/koma-exhibit-project`、静的配信は repo の `dist/`。変更は `-- --dir … --port … --static … --token …` か env `KOMA_RELAY_*`。起動時に koma のポップアップに入れるホスト名候補（`<hostname>.local` と LAN IPv4）を表示、`dist/exhibit.html` が無ければ `yarn build` を促す、ポート衝突は EADDRINUSE を明示して exit 1、`--help` あり): (1) ビルド済み koma（`dist/`）を静的配信 → キオスクは `http://localhost:7777/exhibit.html` を開くだけ（ピッカー・権限プロンプト無し）、(2) `PUT /api/file/<rel>`（tmp+rename で原子的、`X-Mtime` を mtime に反映）/ `GET /api/manifest`（rel → size,mtime）/ `GET /project/<rel>`（ETag = size-mtime、条件付き GET）、(3) WebSocket `/ws?role=capture|exhibit`: capture の `{type:'state',topic,data}` を保持して全 exhibit に配信（後から繋いだ exhibit にも hello で再生）、`signal` を capture ↔ exhibit で中継、`file` で push 完了を通知、ping で死活監視。capture は常に 1 本（新しい接続が古いのを置き換える）。
- **koma 側 `src/stores/relay.ts`（汎用）**: 接続先は app config（`relay.host` / `relay.port`（既定 7777 = `RELAY_DEFAULT_PORT`）/ `relay.token`、プロジェクトでなく機械の設定。旧 `relay.url` は初回にホスト/ポートへ分割して破棄）。タイトルバーの `TitleBarRelayConnection`（モニタ共有アイコン）はホスト欄とポート欄が別（ポートは既定値入り）。ホスト欄に `http://x:8000/` のような URL を貼っても confirm 時に `normalizeHost()` が分割する（keystroke 毎にやると `http://` の `/` が消えるので confirm 時のみ）。`url` は computed（`http://host:port`）。入力は keystroke 毎に model が変わるので接続 watch は 400 ms debounce。
  - **表示用コピーの push**: `project.onSaved`（`saveProject` 後に発火する新フック）ごとに、`_lv`（live + `_trash`）と登録された extra files（`previz/frames.json`・`set.json`・参照 G-code・`layerGcode`）を差分 push、最後に `project.json`。差分判定は **タグ**（プレビューはアセット id、previz は `lastModified` スタンプ）→ タグが変わったものだけ **ローカル stat（size+mtime）と manifest を比較**して違えば送る。リロード後は id が振り直されるが stat 比較で既送分は送らない（実測: 再読込後の再同期は project.json 4 KB のみ）。フル解像 jpg / RAW は送らない = 展示機のコピーは「表示用」、原本のバックアップは別途。
  - **ライブ状態 publish**（`src/addsub/relayPublish.ts`）: `machine:mill` / `machine:rig`（state・mpos・wpos・alarm・streamProgress、100 ms スロットル）、`sequence`（running・step・message・progress・filmLift・captureFrame・**cutting = {frame, path, index, total}**）。`sequence.cutting` は `stepCut` が `mill.stream` の間だけ立てる。
  - **ライブビュー = WebRTC**: 送るのはカメラの生映像ではなく **Preview パネルのキャスト**（`src/stores/previewCast.ts`、下の「Preview のキャスト」）。exhibit の `want-live` ごとに RTCPeerConnection を 1 本（`iceServers: []`、直結なので host candidate のみ）。`degradationPreference: 'maintain-resolution'`、`maxBitrate 6 Mbps`、`contentHint 'detail'`。stream が差し替わったら `replaceTrack`（再ネゴ無し）。
- **exhibit 側**: `source.ts`（`HttpSource` = relay の `/project/`、`DirSource` = 従来のフォルダ/OPFS）、`relay.ts`（WS 購読 + WebRTC answerer）。起動時 `?relay=<url>` → 同一オリジンの `/api/status` 探査 → `?opfs=` → IndexedDB のフォルダ、の順で決める。push 完了の `file` 通知で即 `project.json` を読み直す（4 秒ポーリングは保険）。開発時は `exhibit.html?relay=http://localhost:7799`（CORS 許可済み）。
- 検証済（2026-09-27、mock と canvas.captureStream で）: 接続・push（新規/削除→`_trash`/リロード後の無再送）・WS の状態配信・WebRTC のオファー/差し替え/停止・キオスク経路（relay が配る `exhibit.html` から自動検出）。実カメラ・実 Ethernet 直結は未。
- **ビルド**: `public/_dev-*`（開発用シンボリックリンク）を dist にコピーしないよう vite.config に `publicWithoutDevLinks` プラグイン（`copyPublicDir:false` + 自前コピー）。1.2 GB のテストプロジェクトが dist に入る/ダングリングでビルドが落ちるのを防ぐ。
- `exhibit.html` は Google Fonts を CDN から読むので、館内 LAN に外向きが無い場合は Fira Code を self-host する。

**展示機のセットアップ（macOS 素の状態から、git 運用）** — ユーザー希望: ちょこちょこ改修するので展示機にも repo を置いて `git pull` で更新する。

1. Node.js: https://nodejs.org の LTS `.pkg` を入れる（`/usr/local/bin/node`）。yarn は `sudo npm i -g yarn`（この repo は yarn classic 1.x）。git はターミナルで `git` と打つと Command Line Tools の導入ダイアログが出るのでそれで入れる。
2. GitHub 認証: `dev_modules/ws-fanout` は private なので `git clone` 時に user 名 + Personal Access Token（repo 読み取り）を入れる。macOS の git は osxkeychain に保存するので 1 回で済む。
3. `git clone --recursive -b addsub https://github.com/baku89/koma ~/koma && cd ~/koma && yarn install && yarn build`（`yarn install` は electron のバイナリも落とすので数分）。
4. `sh dev_modules/koma-relay/exhibit-machine/install-launchd.sh --kiosk`（Chrome を入れておく）。login 時に **relay と展示画面の両方**が立ち上がり、落ちたら再起動される。ログは `~/Library/Logs/koma-relay.log` / `koma-exhibit-kiosk.log`。`--kiosk` 無しなら relay だけ、`--remove` で両方解除（Chrome も終了）。
   - 展示画面は `exhibit-machine/kiosk.mjs`（下の「展示画面の自動起動」）。ディスプレイを左から順に取り、既定は 1 枚目 = 画面 A、2 枚目 = 画面 B。逆なら `KOMA_EXHIBIT_SCREENS=b,a sh …/install-launchd.sh --kiosk`（左右は システム設定 > ディスプレイ > 配置 の並び）。
   - 環境変数で変更（**インストール時に付けた `KOMA_*` が plist に書き込まれる**。変えるときはもう一度実行）: `KOMA_RELAY_DIR`（表示用コピーの置き場、既定 `~/koma-exhibit-project`）、`KOMA_RELAY_PORT`（7777）、`KOMA_RELAY_TOKEN`、`KOMA_EXHIBIT_SCREENS`。
   - 手で 2 面に出す従来の方法（Chrome を普通に起動して `http://localhost:7777/exhibit.html?setup` の「Open A and B on two screens」）も残っている。
5. macOS 側: システム設定 > 一般 > 共有 の「ローカルホスト名」を `koma-exhibit` に（→ `koma-exhibit.local`）。ファイアウォールが有効なら初回に node の受信許可を聞かれるので許可。省エネルギー: ディスプレイ/コンピュータのスリープを「しない」、「停電後に自動的に起動」を ON。ユーザ > ログインオプションで自動ログイン。
6. 撮影 PC の koma: タイトルバーの relay ポップアップのホスト欄に `koma-exhibit.local`（ポートは既定 7777 のまま。token を付けたなら同じ文字列）。Wi-Fi 経由でも同じ（同じ SSID にいること。mDNS を通さない Wi-Fi なら Mac mini の IP を直接。`ipconfig getifaddr en0` で確認）。
7. 更新: 展示機で `cd ~/koma && git pull && git submodule update --init --recursive && yarn install && yarn build`。relay は配信する dist を読み直すだけなので再起動不要（relay 自体を直したときだけ `launchctl kickstart -k gui/$(id -u)/com.baku89.koma-relay`）。Chrome は各画面で cmd+R、または `launchctl kickstart -k gui/$(id -u)/com.baku89.koma-exhibit-kiosk`（Chrome ごと立ち上げ直す）。

**展示画面の自動起動（2026-10-02、`exhibit-machine/kiosk.mjs` + `kiosk.sh`）** — 朝プロジェクターを点けて Mac mini を起動するだけで、2 面に全画面で出る。
- Chrome を 1 つ（プロファイル `~/Library/Application Support/koma-exhibit-chrome`、`--kiosk`）立ち上げ、**DevTools プロトコル（`--remote-debugging-port=9333`、localhost のみ）でウィンドウを置く**: `Target.createTarget({newWindow})` で 2 枚目を開き、`getScreenDetails()`（`Browser.grantPermissions` で許可済みにする）でディスプレイを読み、`Browser.setWindowBounds` で各ディスプレイへ移して fullscreen。macOS の許可ダイアログもクリックも要らない。
  - 2 枚を 1 プロファイルに置く理由: 画面 B は BroadcastChannel で画面 A に追従するので、プロファイルを分けると同期しない。Chrome のコマンドライン（`--window-position`）で置けるのは最初の 1 枚だけ。
- 5 秒ごとに見直す: ディスプレイが後から現れた（プロジェクターを Mac より後に点けた）、ウィンドウが閉じられた、全画面を抜けた → 開き直して置き直す。起動直後は全ディスプレイが揃うまで 20 秒まで待つ（Chrome は起動直後に 1 枚しか報告しないことがある）。
- 起動時は relay がページを返すまで待つ。Chrome が終了したらスクリプトも終了し、launchd（KeepAlive）が全体を立ち上げ直す。Chrome が動いている間は `caffeinate -dis` でスリープを止める。
- `KOMA_EXHIBIT_SCREENS`: ディスプレイ左から順に `a` / `b` / `ab`（1 枚に両方）/ `-`（そのディスプレイは使わない）。例: 手元モニタ + プロジェクター 2 台なら `-,a,b`。
- 設定（S キーの Setup、環境音の音量など）と OPFS の動画キャッシュはこのプロファイルに入る。普段使いの Chrome とは別なので、初回は入れ直し。
- Node 22 以降が要る（組み込みの WebSocket。依存パッケージ無し）。
- 確認済（2026-10-02、開発機の 2 画面、Chrome 154）: A / B が各ディスプレイにツールバー無しの全画面で出る、B が A に追従、`b,a` で入れ替え、B を閉じる + A の全画面を外す → 15 秒以内に復帰、launchd 経由の起動・再登録・解除。**未確認: 展示機の実プロジェクター、Mac の電源投入 → 自動ログインからの一連、プロジェクターを後から点けた場合。**

Node を入れられない／repo を置きたくない機械向けには `yarn pack:exhibit`（`scripts/pack-exhibit.sh`）で `build/koma-exhibit/`（dist + relay + ws + 同じ start.sh / kiosk.sh / install-launchd.sh）を作ってコピーする経路も残してある。

### Preview のキャストと最後の映像の保持（2026-10-01）
exhibit の LIVE VIEW 区画に出るのを「カメラの最新映像」から「**撮影機の Preview に出ているもの**」に変えた。シーク中のコマ、オニオンスキン（色付き含む）、レイヤー合成、再生、Preview Zoom がそのまま映り、撮影コマにいるときはライブビューが入る。

- **撮影機側 `src/stores/previewCast.ts`（汎用）**: Preview は DOM（`<img>`/`<video>` + CSS の opacity / blend）で stream として取れないので、同じ合成を canvas（プロジェクト解像度、長辺 1920 まで）に描いて `captureStream()` し、`relay.setLiveStream()` に渡す。`komaAt` が `PreviewKoma.vue` のレイヤー列、`scene` が `Preview.vue` の重ね順の写し（**Preview 側を変えたらここも合わせる**）。コマごとにオフスクリーンで合成 → コマの opacity / tint（multiply → screen）で本体へ。再生中は `PreviewPlayback` の canvas をそのままコピー（`setPlaybackCanvas`）。
- キャストに**入らないもの**: Hi-Res（常に lv）、パネルの ZUI パン/ズーム、ガイド（SVG overlay）、進捗ポップアップ、shoot alert。
- 描くのは視聴中（`relay.liveViewers > 0`）だけ。静止シーンは変化時 + 1 秒ごとの heartbeat（後から繋いだ画面にも絵が届く）、ライブビューが入っているときは最大 30 fps。**裏タブでは rAF が止まるので 1 fps に落ちる**（撮影機の koma は前面に）。
- カメラが無くても canvas の track があるので、ライブビュー無しでもシークしたコマが映る。
- **空白のコマでは前の絵を保持する（2026-10-01）**: Preview に描くものが無いとき（ショットの無いコマ、ライブビューの無い撮影コマ、再生中にそれらを通るとき、lv をまだ decode できていない / 解決できないコマ）は canvas を描き直さず、最後の絵をそのまま送り続ける（`previewCast.ts` の `hasPicture()`。判定はシーンの中身で行い、画素は見ない）。heartbeat は canvas を自分自身に描いて出す（後から繋いだ画面にも保持中の絵が届く）。撮影機の Preview 自体は従来どおり黒。
  - 起動してから最初の絵が出るまでは relay に stream を渡さない（`offered`）。その間 exhibit は「live view is off on the shooting machine」と自分で保存した最後の絵（暗め）を出す。最初の絵が出た時点で、待っていた画面に offer が飛ぶ。
  - 確認済（Playwright、テスト用 relay、メモリ上のショット）: 空のコマ / ライブビュー無しの撮影コマへのシーク、再生で空のコマを通過、保持中に exhibit をリロード、空のコマで撮影機をリロード → 絵のあるコマへ移動。実カメラ（シャッターの瞬間にライブビューが途切れるか）は未確認。
- **最後の映像の保持（exhibit 側 `src/exhibit/lastLive.ts`）**: stream が無くなる瞬間（撮影機の終了・切断）に `<video>` の最後のフレームを JPEG にして IndexedDB（`exhibit.lastLive`）へ。受信中も 10 秒ごとに保存（展示機の再起動・停電用）。stream が無い間はその絵を従来の「off」と同じ暗さで出し、「last picture <日時>」を添える。展示機をリロードしても残る。
- 確認済（スクラッチの playwright-core、偽のライブビュー、テスト用 relay）: ライブ / オニオンスキン / 色付き / シーク / ズーム / 再生 / ライブビュー無し が Preview と同じ絵で exhibit に届く、撮影機を閉じる → 保持、exhibit をリロード → 保持。実カメラ・実 LAN は未。
- 既知: dev で `exhibit.html?relay=`（別オリジン）を使うと、`project.json` の条件付き GET が relay の CORS（`Access-Control-Allow-Headers` に `If-None-Match` が無い）で弾かれる。キオスク（relay 自身が配る同一オリジン）では起きない。未修正。

### スマホ用ジョグページ `/jog.html`（2026-09-28）
WebSerial のポートは koma のタブが握っているので、スマホは **koma-relay の `role=control` 経由**で koma に頼む（Houdini と同じ経路）。ハード無しでも relay + koma + ページの往復は確認済み（`cancel` → koma が「Box Rig is not connected」を `jog:result` で返す）。実機での方向の確認は未。

- **ページ** `src/jog/`（`jog.html` は vite の第 3 エントリ、relay の `dist/` から配信）。`?machine=mill|rig` でタブ、`?relay=http://host:port`（既定 = 自分の origin、relay 配信時はそのまま）、`?token=`。relay と token は localStorage に記憶。タイトルバーの relay ポップアップに **URL と QR コード**（`qrcode`）と「Phone jog」スイッチ（`remoteJog.enabled`、app config）。
- **プロトコル**: control `jog` `{id, machine, action, axis?, delta?, feed?}`（action = step | cancel | hold | resume | unlock | home | reset | zero | estop）→ `src/stores/remoteJog.ts`（汎用、`setup([mill, rig], {busy, estop})` は `relayPublish.ts` から）。返事は state `jog:result` `{id, ok, error}`。`remoteJog` state に `{enabled, machines}`。`machine:<id>` の state に `def`（label / axes / units / jogFeed / showFeed）を追加してページがパッドを組む。
- **安全側の設計**: タップ = 1 ステップ（`$J=G91`）だけで、押しっぱなしの連続ジョグは無い（Wi-Fi でリリースが落ちると軸が走り続けるため）。1 ステップの上限 200 mm / 180°。シーケンス実行中は step / home / resume を拒否。ESTOP はタイトルバーと同じ `sequence.estop()`。Home / Reset / Zero は 2 タップ確認。
- **配置（ユーザー指定）**: 十字を 3×3 グリッドとみなし、縦軸を**右上・右下**に詰める。ミル = X/Y（正面から見たテーブル、+X 右 = F 面側、+Y 奥 = R 面側）+ 角に Z。Box Rig = X/Z（上から見て F 面が下）+ 角に Y、もう 1 つの十字がカメラ視点の tilt（上下 = A）/ pan（左右 = B）+ 角に roll（C）。ボタンは矢印 + 軸名だけ（説明文字は `title` 属性のみ）。軸色は 3D ビューと同じ（X 赤 / Y 緑 / Z 青 / A 橙 / B 桃 / C 水色）。**A/B/C の矢印の向き（sign）は実機で要確認**、`LAYOUTS` の `sign` を入れ替えるだけ。
- ステップ: mm は 0.1 / 1 / 10 / 50、度は 0.1 / 1 / 5 / 15。ジョグの送り速度は koma 側の既定（`jogFeed`）。ミルには **feed / rapid オーバーライド**の行（下記）、Box Rig には無し（`panel.showFeed: false`）。
- **QR / URL は relay が `/api/status` で返す LAN アドレス**（`lanHosts`: 非ループバック IPv4 → `<hostname>.local`、`port`）から組む（`relay.lanUrl`）。撮影 PC が「localhost」と打っていてもスマホから開ける URL になる。relay が古くて `lanHosts` を返さない場合は打った host にフォールバックし、ポップアップに注意を出す。
- 画面スリープは Wake Lock、タップは `navigator.vibrate`。裏タブ・スリープからは自動再接続。

### Plan（撮影計画）の作成・補間・shoot condition（2026-09-29）
`FramePlan {rig?, camera?, cameraConfigs?, note?}`（`project.addsub.plan[layerId][frame]`、`src/addsub/plan.ts`）を土台に:
- **現在値から Plan を作る**: `sequence.setPlanFromCurrent(frame, layer, {rig, camera})`。rig = `rig.mpos`（機械座標、6 軸）、camera = `tethr.exportConfigs()` のうち `PLAN_CAMERA_CONFIG_NAMES` = **aperture / shutterSpeed / iso / focusDistance だけ**（ユーザー指定: Mode は M 固定、単焦点なので focalLength 不要、WB / exposureComp / colorTemperature は作品を通して固定）。既存の plan とマージ（rig を記録すると `camera` 姿勢は消す）。コマンド: `plan_set_from_current`（両方）/ `plan_set_rig_from_current` / `plan_set_camera_from_current` / `go_to_plan_selected` / `plan_clear`（いずれも**選択セル** = `viewport.currentFrame/currentLayer`。ラベルは短く保つ — Tweeq の Menu はアイテム高さ固定で、長いラベルは折り返して次の行に被る。Menu 側も `white-space: nowrap` にした）。タイムラインのショット右クリックにも「Set Plan from Current…」「Go to Plan…」「Clear Plan」。Shot Sequence パネルの保存ボタンは capture frame に対して同じ。
- **補間**: `effectivePlanFor(project, frame, layer)` = そのコマ自身の plan（`explicit`）か、前後の planned frame から線形補間した plan（`interpolated`, `from`/`to`）。rig 軸は両方にある軸を lerp（片方だけなら hold）、camera 姿勢は lerp/slerp、cameraConfigs は前のキーを hold（露出はステップ）。範囲外（最初のキーより前 / 最後のキーより後）は無し。`resolveSource` / `goToPlan` / `rigTargetForShot` / `hasSource` はすべて effective を見る。タイムラインは補間コマを点線・半透明の `mdi:map-marker-outline` で、3D は小さい点で、パネルは `~ … (3→10)` で表示。
- **Go to Plan** = `sequence.goToPlan(frame, layer, {rig, camera})`: リグを plan の姿勢へ `moveTo`（limits check、rigFeed）し、**カメラにも plan の設定を `importConfigs`**。片方が無くてもできる方はやり、できなかった理由をまとめて throw。
- **shoot condition**: `stores/shootAlerts.ts` に `registerAlertProvider(fn)` を追加（汎用、ユーザー JS 条件の後に評価）。`src/addsub/shootConditions.ts` が capture frame の plan に対して (1) リグ各軸が `project.addsub.planTolerance`（既定 linear 0.2 mm / rotary 0.1°、Shot Sequence 設定で変更）以内、(2) `PLAN_CHECKED_CONFIG_NAMES`（= aperture / shutterSpeed / iso、focusDistance は適用のみ）の各値が一致（数値は等値、他は文字列一致。カメラが値を返さない config はスキップ）、を alert にする（`sequence.planAlerts`）。Grbl の MPos は指令値（ステップ量子化）なので許容差で判定。シーケンスの capture も `shoot()` 経由なので同じ条件で止まる。
- **Plan パネル**（`src/addsub/components/PlanPanel.vue`、Shot Sequence の下）: **選択セル**（`viewport.currentFrame/currentLayer`）の plan を直接編集。X/Y/Z は `rigLimits` を min/max にした InputNumber（= スライダー付き）、A/B/C は ±180°。カメラ設定（Aperture / Shutter / ISO / Focus）は `TethrConfig.vue` を流用し、接続中のカメラの `option`（絞り・SS・ISO のドラム）で選ぶ。未接続時は自由入力（数値文字列は number に）。各行の × でその設定を plan から外す。補間コマを開くと値は読めるが「Make key」か最初の編集でそのコマ自身の plan（6 軸すべて）になる。編集は毎回 `setPlan` で丸ごと書き戻す（リグの姿勢を編集すると `camera` 姿勢は消える）。
- 未対応: 補間は線形のみ（ease 無し）、plan の `note`、Preview への planned コマ表示（previz render を重ねる等）。

### コマごとの G-code（drop → Cut → shoot condition、2026-09-30）
タイムラインのセルに `.nc` / `.gcode` / `.ngc` / `.tap` をドロップすると、そのコマの「撮影前に流す切削」になる（`src/addsub/cuts.ts`）。
- **保存**: ファイルはプロジェクトフォルダの `gcode/<layerId>/<NNNN>_<元の名前>` にコピー（`project.writeProjectFile`。未保存の in-app プロジェクトはここで OPFS に materialize される）。記録は `project.addsub.cuts[layerId][frame] = {source:'file'|'previz', file, name, addedAt, lines, estimatedSec, run}`。複数ファイルをまとめて落とすと名前順にそのコマから連番で付く。Cut パネルの「Attach」（`showOpenFilePicker`）でも同じ。
- **解決順**（`sequence.gcodeFor(frame, layer)`）: ドロップしたファイル → `previz/frames.json` の cut。sequence の `cut` ステップ、タイトルバー中央の **`Cut #N`** ボタン（capture frame。切削中は `#N 43% · −2:10` になり押すと `stop()` = feed hold）、Cut パネルの「Cut now」（選択セル）はすべて `runCut()` を通り、`G10 L2 P1` → stream → Idle 待ちのあと **`run = {startedAt, durationMs, linesSent, total, done, error, filmLift, estimatedSec}`** を記録する。previz のコマも初回実行時に `source:'previz'` のレコードができる（path は毎回 previz から引き直す）。撮影時は `shot.cut = {file, durationMs}` も残る。
- **shoot condition**: `sequence.cutAlerts()` — G-code があるのに `run.done` でない（未実行 / 途中停止 / ファイル差し替え後）と「Frame N: G-code … not cut yet」で止まる。`project.addsub.requireCut`（Cut パネルの Require）でオフ。sequence 経由の capture も同じ判定。
- **ETA**: `parseToolpath` が F ワード（modal、初期 `DEFAULT_FEED` 300）と rapid（`DEFAULT_RAPID_FEED` 1500 mm/min、`addsub.millRapidFeed` は今は未接続）から各セグメント末尾の累積秒 `t` と合計 `seconds` を出す（加減速無し）。worker の `CompactToolpath` に `time`/`seconds` が乗り、`toolpathTimeAt(tp, sentLines)` で送信済み行から残りを出す。実行中は経過 20 s 以降は「経過 / 見積り経過」の比、それまではプロジェクトの完了済み run から求めた `measuredTimeRatio` で補正（0.3–5 にクランプ）。`sequence.cutProgress` = `{sent, total, fraction, elapsedMs, remainingMs}`。
- **表示**: セルの左下にバッジ（橙 = 未切削、灰 ✓ = 済み、hover で run 情報）。Cut パネル（Shot Sequence の下）: 選択セルのファイル / 行数 / 見積り / 最後の run / Cut now / Require / 累計 mill time。3D ビュー（`AddsubVisualizer`）に **capture frame（切削中はそのコマ）のツールパス**をブロック位置に描く: worker の three 軸 (mill X, mill Z, −mill Y) を `toolpathAxes.matrix` で film (−z, y, x) に置換、原点は G-code が走る作業原点（下の「3D ビューの修正」参照）。rapid 灰 / 切削 白 / 送信済み 青（`mill.streamProgress.index` で色属性だけ更新）。工具先端は既存のマーカー。info の「Cut #N」ブロックの **focus** ボタンで OrbitControls をパスの中心へ（半径 ×2.5）。「koma 本体の 3D には G-code を出さない」という以前の判断はこの要望で覆した（exhibit 風のラベルは出さない）。
- **移動**: `toolpath.worker.ts` / `toolpathParser.ts` を `src/exhibit/` から **`src/utils/fluidnc/`** へ（main に戻せる汎用）。exhibit の `Pane.vue` / `toolpathView.ts` は import 先を変えただけ。
- exhibit の `gcodePathFor` と relay の extra files はドロップ済みファイル（`source:'file'`）を最優先で拾う（tag = `cut:<addedAt>`）。
- **HMR 無効**（`vite.config.ts` `server.hmr: false`、ユーザー要望）: このタブがカメラと全シリアルポートを握るので、コード変更は明示的なリロードでだけ反映。ページ全体の `dragover`/`drop` も `preventDefault`（セル以外にファイルを落としてもタブが遷移しない）。
- 未確認: 実機での cut 実行 → run 記録 → ETA。ブラウザ（Playwright、ミル無し）で drop → バッジ / パネル / タイトルバー / shoot alert までは確認済み。
- TS の注意: `tsc --noEmit` で `sequence.ts` の `camera.tethr.exportConfigs` が「Ref のまま」に見えるエラーが出るが、これは前セッションの plan コード由来で pinia の型アンラップの問題（vite/eslint/vitest は通る）。

### Feed / rapid オーバーライド（2026-09-29、cncjs の feed override 相当）
cncjs の 10〜200% スライダは Grbl 1.1 の**リアルタイム文字を生バイトで送るだけ**（`0x90` = 100% に戻す、`0x91`/`0x92` = ±10%、`0x93`/`0x94` = ±1%。rapid は `0x95`/`0x96`/`0x97` = 100/50/25%、spindle は `0x99`〜`0x9D`）。行キューを通らず即時に効き、送出中のプログラム（`cut` ステップの G-code）にもかかる。現在値は `?` の応答の `Ov:feed,rapid,spindle` で返るが、**変化時か N 回に 1 回しか載らない**ので `machine.override` に最後の値を保持（reset / 切断で null）。FluidNC も同じ実装。
- `FluidNCClient.feedOverride(0 | ±10 | ±1)` / `rapidOverride(100 | 50 | 25)`（`Realtime` 定数）、machine store は送信後に `?` を打って値を取り直す。
- MachinePanel（ミルのみ、`panel.showFeed`）に「Override」行（−10 / −1 / 現在% / +1 / +10 と rapid 25/50/100）。ジョグページのミルにも同じ行（`feedOverride` / `rapidOverride` action。シーケンス実行中でも受け付ける — それが用途）。
- 注意: Grbl のオーバーライドは**リセットしないと残る**（ソフトリセット `^X` で 100% に戻る）。cut ステップ前に 100% に戻す処理は入れていない（意図的に遅くしたまま次コマへ行きたい場面があるため）。

### MachinePanel: 位置の直接指定とリミットスイッチ表示（2026-09-29）
- **Work 座標の表示が入力になった**（両レイアウト）。普段は軸の現在値に追従し、編集（数値入力 / スライダーのドラッグ）すると「ターゲット」として保持、右の照準ボタンが有効になる。押すまで何も動かない。押すと `$J=G90 G21 <軸><値> F<jogFeed>`（作業座標の絶対ジョグ、1 軸だけ。0x85 でキャンセル可）。到着（±0.0005）でターゲット解除 → 追従に戻る。その軸を ± でジョグしてもターゲットは捨てる。右クリック →「Reset to Default」で現在値に戻す。Enter では動かない（ボタンのみ）。
- スライダーの範囲は `MachinePanel` の `limits` prop（**機械座標**、WCO を引いて作業座標にずらす）。リグは `project.addsub.rigLimits` を渡す（範囲外の入力はクランプ）。limits の無い軸は範囲なしのドラッグ数値、回転軸は ±180° のバー（クランプ無し）。ミルは未指定。
- InputNumber の罠: (1) `step` を付けないと表示桁がスライダーの px 幅で決まり整数に丸まる → `:step="0.001"`。(2) フォーカス中は外からの model 変化を表示に反映しない（Enter 後もフォーカスが残る）→ `@confirm` で blur。(3) 現在値が範囲外だとクランプした値を勝手に emit する → ターゲット未設定時は「クランプした現在値」と同じ emit を編集と見なさない。
- **リミットスイッチ**: status report の `Pn:` を `parsePins()`（`utils/fluidnc/status.ts`）で `{limits: Axis[], probe, others}` に分け、`machine.pins` に出す。パネルに「Limits」行（軸ごとのランプ、押されていれば橙に点灯。Probe / Door など他の入力は active の時だけ出る）、grid レイアウトでは軸ラベルも橙になる。`Pn:` が無い report = 全部 clear。更新は status のポーリング間隔（200 ms）。**X1/X2 のような 2 モーター軸は 1 文字にまとまるので、どちらのスイッチかは区別できない**。未配線の入力は浮いて active に読めることがある（4章）。
- 確認はハード無し: Playwright で `navigator.serial` を偽の FluidNC 2 台（`$I` / `?` / `$J=` / `G10 L20` に応答）に差し替えて、識別 → 編集 → Go → 到着、クランプ、WCO つきのミル、Pn 表示まで通した。実機での確認は未。

### 撮影後の自動移動と Auto run（2026-10-01）
人が毎コマ立ち会う撮り方（切削 → 掃除 → 目視 → シャッター）のための半自動。フルの Shot Sequence（§2）とは別物で、**手動のシャッター（`shoot` / `force-shoot` アクション）が引き金**。`placeShotAndAdvance` のあと `sequence.afterShot()` を呼ぶ（await しない）。
- **自動移動**（Auto run のオン/オフに関係なく常時）: 次のコマに plan のリグ姿勢があり、いまのリグ位置からの **X/Y/Z 直線距離が `project.addsub.autoMoveMaxDistance`（既定 100 mm、Shot Sequence 設定の「Auto move」、0 = 無効）未満**のときだけ、`rig.moveTo` でそこへ動かす。以上なら動かさず `message` に残す（plan の shoot condition がシャッターを止めるので、Go to Plan は人が押す）。回転軸の差は距離に数えない。既に許容差内なら何も送らない。
- **Auto run**（タイトルバー中央、Cut ボタンの左の「Auto」トグル。`sequence.autoRun`、**保存せず起動時オフ**）: 上の移動のあと、そのコマの G-code が未切削なら `runCut` で流し、終わったら **ブザー**（`utils/sound.ts` `buzz('done')` = 高い短音 3 回、WebAudio 合成）。人が掃除してシャッターを切ると次のコマで同じことが起きる。カメラ設定（plan の cameraConfigs）は適用しない。
- 失敗・停止（`stop()` = Cut ボタン、ESTOP、ALARM など）は低い長音 2 回 + 読み上げで、**Auto run を自動でオフ**にする。G-code の無いコマに来たとき（仕込んだ連番の終わり）もエラー音と「Frame N has no G-code」。10 cm 以上でカメラを動かさなかったときは読み上げる（切削は行う）。
- 実行中は `sequence.running` が立つので、Cut / Go to Plan / スマホのジョグは拒否される。切削中のシャッターは cut の shoot condition（`requireCut`）が止める。
- 確認済（Playwright、`navigator.serial` を偽の FluidNC 2 台に差し替え）: 移動のみ（Auto オフ）、切削のみ、移動 + 切削、10 cm 超で不動、途中 stop で feed hold + Auto オフ、トグル。**実機・実カメラのシャッター起点、ブザーの音量は未確認。**

### STL 連番 → コマごとの差分ツールパス（Fusion スクリプト、2026-10-01）
- `scripts/fusion/KomaCarveSequence/`（Fusion の Scripts フォルダにシンボリックリンク済み、Utilities > Scripts and Add-Ins > KomaCarveSequence）。STL 連番（Houdini 書き出し、メートル単位）から、**コマ N の G-code = コマ N−1 の形からコマ N の形へ削るぶんだけ**を作る。
- 仕組み: 手で用意した「テンプレート setup」をコマごとに複製し、**model = コマ N のメッシュ、stock（From solid）= コマ N−1 のメッシュ**に差し替えて、その中の Parallel を生成 → NC プログラムで post。Parallel は **Rest Machining オン、Source = From setup stock** にしておく（stock が model より上に残っている所だけ切る）。パラメータ名は `useRestMachining` / `restMaterialSource`（Fusion 同梱のヘルプで確認）。
- テンプレート側の条件: (1) WCS 原点は固定の場所（model origin か選択点）。stock / model の box point だと stock が毎コマ変わるので原点が動く。(2) ドキュメントに NC プログラムが 1 つあること（post と post プロパティをそこから流用）。スクリプトは実行前に rest machining オフ / box point 原点 / NC プログラム無しを警告する。
- 設定はスクリプト冒頭（`STL_DIR`, `OUT_DIR`, `TEMPLATE_SETUP`, `FRAMES`, `POST`）。出力は `OUT_DIR/<連番名>_<NNNN>.nc` と `carve_sequence.log`（コマごとの ok / no toolpath / 加工時間）。setup は `carve NNNN`、メッシュは `<連番名>_NNNN` の名前で残り、再実行では再利用する。出力ファイルをまとめて koma のセルに落とせば名前順に連番で付く。
- 初回実行（2026-10-01、`261001_carve_test` 36 枚 → 35 本、template "Setup3" / "Parallel2"、`restMaterialSource = 'job'`）: 全コマ生成・post できた。`Setups.itemByName` は該当なしで例外を投げる（None を返さない）ので名前検索は自前のループにした。
- **WCS 原点が stock box point のままだと Z0 がコマごとに下がる**（実測）: stock = 前コマのメッシュなので、Z0 = 前コマの最高点になる。carve_test では 50.000 → 49.083 mm と 35 コマで 0.92 mm ずれ、そのまま流すと後のコマほど浅く切れる。初回は G-code 側で補正した（各ファイルの絶対 Z を `−(50 − 前コマの最高点)` だけシフトして、Z0 = 元の上面 50 mm に固定。`gcode/main/00NN_261001_carve_test_00MM.nc` の先頭コメントにシフト量）。次からはテンプレートの WCS 原点を model origin か選択点にする。XY は stock の外形が変わらないので動かない（原点は stock の角、X −1.2…61.2 / Y 0…80）。
- carve_test は F62–96 に inbox パッチで付けた（plan は付けていない）。

### inbox の op と Z ステップ（2026-10-01）
- 外からプロジェクトを変える経路は `_inbox/` のパッチ（CLAUDE.md「プロジェクトの inbox」）。addsub の op（`src/addsub/inboxOps.ts`、`layer` は layer id、`frame` はタイムラインのコマ）:
  - `{"op": "setCut", "layer": "main", "frame": 41, "file": "gcode/main/0041_….nc", "name": "….nc"}` — ファイルは先にプロジェクトフォルダへ置く。行数と見積りは koma が計算。conflict = そのコマに既に付けたファイルがある。切削中のコマは拒否。
  - `{"op": "setPlan", "layer": "main", "frame": 41, "plan": {"rig": {…}, "cameraConfigs": {…}}}` — rig は `rigLimits` 外なら拒否。conflict = そのコマ自身の plan がある。
  - `clearCut` / `clearPlan`（ファイルは消さない）。
- **`scripts/addsub-zstep.mjs`**: あるコマに付いた G-code の絶対 Z を 1 コマごとに累積でずらして後続のコマに付け、同時に plan のリグ Y も刻む。`node scripts/addsub-zstep.mjs <project> --from 37 --start 41 --count 20 --dz -0.5 --rig-dy -0.5 [--plan-from N] [--layer main] [--write] [--force]`。無印は dry-run、`--write` で `gcode/<layer>/NNNN_<名前> Z-0.5.nc` と inbox パッチを書く（`--force` = overwrite、`--direct` = inbox 無しの koma 向けに project.json を直接編集）。Z をずらすのは G90 の行だけで、`G28` / `G30` / `G53` / `G10` / `G92` の行と G91 の行はそのまま。plan の基準は `--plan-from`（既定 start−1）のコマの plan。
- 初回: F37 の `Flat mill 60x80 2mm down.nc` から **F42–61**（Z −0.5…−10、リグ Y −550.5…−560、基準は F41 の plan）を仕込んだ。F41 起点の最初のパッチは、リロード時点で F41 に手動の plan があったので丸ごと拒否された（想定どおりの挙動）。
- **Plan パネルが小数の plan を丸めていた**（同日修正）: リグ軸の `Tq.InputNumber` が `:step="1"`（回転軸 0.1）で、InputNumber は表示した値を step に量子化して即 emit し返すので、**コマを選択しただけで −550.5 が −550 に書き戻された**（F40 の a −86.019 → F41 で −86 になっていたのも同じ）。`step` は「ドラッグの刻み」ではなく「保存される分解能」として 0.001 に。数値入力に粗い `step` を付けるときはこの書き戻しに注意。

### cut が G54 を上書きする件（2026-10-01、既定オフに変更）
- **事故**: `Flat mill 60x80 2mm down.nc`（Fusion、`G28 G91 Z0` → `G54` → `G0 X.. Y..` → `Z0` → `G1 Z-1`）を shot に付けて Cut したら Z が上がりきって HARD LIMIT。cncjs では正常。原因は koma が stream の直前に必ず送っていた `G10 L2 P1`: `millOffset` / `filmOriginWorld` が未校正（既定 [0,0,0]、filmLift 0）だと **`G10 L2 P1 X0 Y0 Z0` = G54 を機械原点に置く**ので、ファイルの `Z0` が機械 Z0（ホーミングのスイッチ位置、pull-off より上）になる。`G10 L2` は FluidNC に永続保存されるので、**手で取った G54 のゼロもそこで消える**（cncjs に戻っても直らない。取り直しが要る）。
- **変更**: `project.addsub.cutSetsWorkOffset`（既定 **false**、Cut パネルの「Set G54」）。オフなら koma は G-code をそのまま流すだけで、機械に設定済みの作業原点（cncjs や MachinePanel の「ここをゼロ」で取ったもの）で走る = 普通のセンダーと同じ。オンのときだけ従来どおり `G10 L2 P1`（`sequence.cutWorkOffsetLine()`、パネルに送る行を表示）。§7.1 の「継ぎ足しても G-code を書き出し直さない」運用は、`millOffset` を校正（Shot Sequence 設定の照準ボタン）してからオンにする。
- koma が cut の前後に足す操作はこれだけ（`prepareGCode` はコメントと空行を落とすのみ、stream は 1 行→`ok`）。

### 3D ビューの修正とツールチップの切削時間（2026-10-01）
- **カメラのモデルの向き**: `public/camera.fbx` はレンズが +Z 側（ボディ z −0.03〜0.005、レンズ z 0.005〜0.144）。カメラは −Z を向く約束（§10）なので、`AddsubVisualizer` でモデルを Y 軸まわりに 180° 回して載せる。姿勢の計算やジョグの矢印は触っていない。
- **ツールパスの原点**: 以前は常に film 原点（未校正だと機械原点と同じ）に描いていたので、「Set G54」オフで手で取った作業原点で走らせると、工具先端のマーカー（MPos）とパスがずれて見えた。今は G-code が実際に走る作業原点に置く: 「Set G54」オフ = コントローラの今の WCO（`mill.mpos − mill.wpos`）、オン = `filmOriginMill(filmLift)`。world へは工具マーカーと同じ `millToWorld(…) + tableShift`。ミル未接続なら WCO は 0 扱い（機械原点）。
- **shot ツールチップ**: 「Cut File」「Time to Cut」（`run.durationMs` = 最初の行の送出から Idle まで。途中停止は `(stopped at line a/b)`）。セルの cut 記録に run があればそれ、無ければ撮影時の `shot.cut`。

### カメラギズモ: Local / Global と Orbit（2026-10-01、§11.2）
- **移動の矢印の座標系**を 3D ビュー右下の `Local | Global` で切り替える（app config `addsub.view.gizmoSpace`、既定 **Local**）。Local = カメラの向きに乗った軸（Right/Left・Up/Down・Fwd/Back。カメラは −Z を向くので Fwd = 視線方向へ寄る）。クリックで矢印の向きに `jogStep` mm、X/Y/Z を同時に `$J=G91` で送る（リグの X/Y/Z は world 軸なので、向きのベクトルがそのまま移動量）。Global は従来どおりリグの X/Y/Z を 1 軸ずつ。回転のリング（Pan/Tilt/Roll）は変えていない。
- **Orbit ハンドル**（黄）: **world の X=0, Z=0 を通る縦軸**まわりにカメラごと回す。`kinematics.ts orbitRigAxes(axes, deg, cal)` = 回転中心を縦軸まわりに回し、パン（B）を同じ角度だけ足す（R' = Ry(Δ)·R なので tilt / roll / 高さは不変、縦軸上の被写体は画面の同じ位置に残る）。1 クリック = `jogStep`°、X・Z・B を 1 本の相対ジョグで送る（途中の軌跡は弧でなく弦）。表示はカメラを通る水平のリングと縦軸の線、リング上のカメラの両側に矢印。カメラが縦軸の上（半径 20 mm 未満）では出さない（ただのパンになる）。
- Orbit だけは行き先が `rigLimits` の X/Z を出るなら送らず、Box Rig の情報欄に理由を 3 秒出す（計算が機械座標の真値に依存するため。他の矢印は従来どおり FluidNC 任せ）。
- 縦軸は world 原点。既定の `rigOffset` は X/Z = 0 なのでリグの機械座標 X=0, Z=0 と同じ。`rigOffset` の X/Z を変えると機械座標とはずれる。
- 確認済（ヘッドレス Chromium、`navigator.serial` を偽の FluidNC に差し替え）: Local の Fwd / Right が向きどおりの 3 軸ジョグになる、Global は 1 軸、Orbit は半径を保って X・Z・B が動く、可動域外は拒否。vitest に orbit の往復テスト。**実機では未確認**（パンの符号 `rotarySigns.b` が逆だと Orbit でカメラが縦軸から外を向いていく）。

### shot ツールチップの Box Rig 座標（クリックで移動、2026-10-01）
- タイムラインの shot ツールチップ（`TimelineShot.vue` `printRigInfo`）の末尾に、撮影時の `shot.rig`（機械座標）を **X/Y/Z = mm、A/B/C = °**（小数 3 桁、単位は `RIG_DEFINITION.axisInfo`）で出す。**見出し行（"Box Rig … Click to move"）をクリックすると全軸、各軸の行をクリックするとその軸だけ**がその値へ動く（`sequence.recallRig(frame, layer, axes?)`。全軸は右クリックの「Move Rig to Shot Camera Position」と同じ。limits check あり、シーケンス実行中は拒否、失敗は alert）。`shot.rig` の無いショット（外部 paste、取り込み）にはブロックを出さない。
- `recallRig` は Y を「撮影後に足した filmLift」ぶん持ち上げるので、表示値（記録値）と行き先が違うときはヒントに `(Y +60 mm lift)` と出す（Y だけのクリックも持ち上げた値へ行く）。リグ未接続なら `Not connected`。
- **Tweeq 側（汎用、main に戻せる）**: `v-tooltip="{content, html: true, actions: {name: fn}}"`。html 内の `data-tooltip-action="name"` の要素がクリック可能になり（hover で背景、`cursor: pointer`）、`actions` を持つツールチップはポインタが乗っている間は閉じない（要素から離れて 150 ms 以内に乗れば維持）。`actions` の無いツールチップは従来どおり即閉じ。
- 副作用: rig つきの shot のツールチップは上へ動くとポインタを掴むので、**上の段のレイヤーのセルへまっすぐ上がると前のツールチップが残る**（横に外せば 150 ms で閉じる）。
- 確認済（Playwright、仮の shot と偽の `rig.client` / `rig.moveTo`）: 表示、hover 維持、全軸 / Y だけ / B だけのクリックで `moveTo` に渡る target（lift 込み）、可動域外と未接続の alert、アクション外の行は無反応。実機での移動は未。

### MachinePanel の機械別レイアウト（2026-09-28）
`MachineDefinition.panel`（`layout: 'rows' | 'grid'`, `gridColumns`, `showFeed`, `showGoToZero`）。Box Rig は `grid`（Work 座標のみ、X Y Z / A B C の 3 列 2 行、各セルに値・−/+・zero/set）、Feed 入力と「Go to 0」無し。ミルは従来の行レイアウト（machine / work）。軸ごとの「Go to # = 0」ボタンは両方から削除（Work 行の「Go to 0」はミルのみ）。

### LED Wall の手動出力（2026-09-27）
- **Faces**: 面ごと（L/B/R/F、各面の 2 ライン = ws-fanout のライン順 L1 L2 B1 B2 R1 R2 F1 F2 を index で 4 等分）に 1 色。色は `project.addsub.led.faceColors`（hex）に保存、スイッチ `led.faceLight` で「コマの照明」の代わりに出す。優先順位は work light > faces > follow。
- タイトルバー右のデバイス一覧に LED Wall も入れた（`src/addsub/components/TitleBarLedConnection.vue`、リグの隣・relay の前）: 接続状態、Connect/Disconnect、White/Off、Work light / Faces / Follow のトグル、いま出ている照明・latency（電流見積りの表示は 2026-09-29 に削除。ストアの `power` も無し）。
- **Chase**（配線チェック、`led.startChase({mode, stepMs, line?})` / `stopChase()`）: `pixel` = 白 1 粒をライン順に走らせる、`line` = ライン丸ごとを順に点灯。実行中は他のモードを止め、終了/停止で元の状態に戻す。モードと step は app config。ws-fanout の `scripts/chase.ts` と同じ手順（全消灯 → 走らせ → 消灯）。
- ブラウザの**バックグラウンドタブはタイマーが ~1 Hz に絞られる**ので、chase を裏タブで走らせると 1 粒/秒になる（バグではない。sequence も同じなので撮影中の koma タブは前面に）。ハード無しの確認は `dev_modules/ws-fanout/sender/test/mock-device.ts` の `MockDevice` を `WsFanout.fromTransport` に渡して `led.device` に差す。
- **White ボタンは削除（2026-10-01）**: タイトルバーのメニューと LED パネルの両方から外した（全白は Work light で足りる）。メニューは幅固定（17rem）をやめてボタンの行に合わせて広がり、エラー文はその幅で折り返す。
- **Tweeq 側（汎用）**: `InputButton` / `InputButtonToggle` のラベルは `white-space: nowrap`。高さ固定のボタンなので折り返すと上下にはみ出す（LED メニューの "Work light"、タイトルバー中央の Cut ボタンの `#47 84% · −0:09` が 2 行になっていた。後者は中央カラムが `min-content` 幅なので、折り返せると最長の単語まで縮む）。

### LED の壁バッファ（2026-09-28）
`led.wall`（ライン毎の RGB `Uint8Array[]`、`layout.lineCounts` 由来）+ `led.wallVersion` が「壁に出ているべき色」の正。全モード（コマの照明 / faces / Houdini live / work light / chase の各ステップ）はまずここに書き、デバイスが繋がっていれば `pushWall()` で LINE→SHOW する。**デバイス無しでも 3D ビュー（`AddsubVisualizer` の LED 点群）に色が出る**（以前は `device.getLine` を読んでいたので未接続だと灰色、`fill()` は show イベントを出さないので work light も反映されなかった）。`showImage`/`showColors`/`showFaces` は未接続時 `null` を返す（throw しない。sequence は事前に `led.connected` を見る）。接続した瞬間に `shownKey` をリセットしてバッファ全体を送る。Houdini の `led:frame` も未接続で preview に乗る。

### ショットの LED 記録（2026-10-01）
撮影した時点で壁に出ていた**全粒の RGB をそのまま記録**する。LED 画像が無い照明（faces / Houdini live / 手動 fill / work light）で撮ったショットでも「Recall Shot Lighting (LED)」が効く。

- **記録**: `led.recordForShot()`（App.vue の `shoot()` が露光前に呼び、ショット確定時に await）。中身はデバイス側のバッファ（`device.getLine(i)` = 実際に LINE で送ったもの、gain 適用後）を露光時点でコピーしたもの。**壁が繋がっているときだけ**記録する（未接続のプレビュー用バッファは「送出した」ものではないので記録しない）。書き込みに失敗しても撮影は止めない（console.error のみ）。
- **保存先**: プロジェクトフォルダの `led-wall/<SHA-1 先頭 16 桁>.ledwall`（`src/addsub/led/wallRecord.ts`）。内容ハッシュが名前なので、同じ照明のショットは 1 ファイルを共有する。形式は `'KLW1' | u8 ライン数 | u16le 粒数 × ライン | RGB…`（ws-fanout のライン順、3108 粒で 9,345 byte）。project.json には入れない（3000 コマで ~37 MB になり autosave が重くなるため）。
- **ショット側**: `shot.led = {file?, layoutVersion, wall?, brightnessCap?}`（`ShotLedRecord`）。`file` は画像由来のときだけ（live の `'live'` マーカーはもう記録しない。旧ショットの `'live'` は画像として扱わない）。`brightnessCap` はファームの輝度上限（記録のみ、recall では触らない）。
- **recall**（`sequence.recallLed`）: 記録した粒を**そのまま**戻す（`led.showWallRecord`: サンプル・gain・lift 無し、ラインは現在の配置にクリップ）。例外は「撮影後に filmLift が変わっていて、かつ画像がある」ときだけで、従来どおり画像を現在の lift で再サンプルする（`recallRig` が Y を持ち上げるのと同じ扱い）。粒の記録が無い旧ショットは 画像 → そのコマの previz 照明 の順。
- **再演パス**: 画像があれば従来どおり再サンプル、無ければ記録した粒をそのまま出す（lift ぶんの縦ずらしはできない。面ごと一様な faces なら問題なし）。
- ファイルは消さない（ショットを消しても `led-wall/` は残る。1 照明 9 KB）。relay の表示用コピーには送っていない。
- 確認済（Playwright + `MockDevice`）: faces で記録 → 消灯 → recall で全ライン一致、同じ照明は同じファイル、lift 変更時の分岐、未接続では記録なし。実機は未。

### Houdini からの直接制御（2026-09-28、§13.2 の実装）
Houdini の LED 点群（1 点 = 1 粒、ws-fanout のライン順、`Cd` = 0-1 RGB、`face` 属性 = ライン名 L1…F2、P は Box Rig 機械座標 m）を、ファイル経由（配置）とリアルタイム（色・カメラ・フレーム）の両方で koma に流す。

- **配置 = `previz/set.json`**: `led.frame: "rig"`（既定 `world`）と `led.unit: "m"`（既定 mm）を追加。koma が `rigOffset` で world に直すので、LED はリグと一体の物理座標のまま書ける（校正し直しても set.json は不変）。`u`（展開図の横位置）は Houdini 側で付ける（§8 の VEX、`imageWidth` = 2·(1831+1991) = 7644）。書き出しは `scripts/houdini/koma_bridge.py` の `export_set_json()`。
- **リアルタイム = koma-relay の `role=control`**: 第三のクライアント種。`{type:'control', topic, data}` を capture（koma）へそのまま転送、state 配信は exhibit と同じく受け取れる。token は capture と同じものが要る。koma 側は `relay.onControl(topic, handler)`（汎用）→ `src/addsub/stores/houdini.ts` がトピックを配線、`HoudiniPanel.vue`（右ペイン "Houdini Live"）にスイッチ。**Houdini が繋がっただけでは何も動かない**（各トピックにスイッチ）。
  - `led:frame` `{rgb: base64（全ライン連結・3 byte/粒）, layoutVersion}` → `led.pushLiveFrame()`。LED ストアの **`liveLight`**（優先順位 work light > live > faces > follow）。latch 中に来たフレームは最新だけ残す（スクラブで遅れない）。`led.showColors()` が粒色を直接出す汎用 API（画像サンプル無し、gain は適用）。
  - `rig:pose` `{position, rotation|angles, frame: film|world|rig, unit}` または `{axes:{x,y,z,a,b,c}}` → IK → `rigLimits` 内・シーケンス停止中・Idle/Jog のときだけ、`$J=G90 G53` の絶対ジョグ（直前のジョグは 0x85 でキャンセル、200 ms 間隔、`addsub.houdini.rigFollowFeed` 既定 600 mm/min）。**`rigFollow` は永続化せず起動時 off**、シーケンス開始で自動 off。
  - `timeline:frame` `{frame}`（previz 番号）→ `previzFrameOffset` を引いてプレビューフレームへ（`followTimeline`、既定 on）。
- **Houdini 側 `scripts/houdini/koma_bridge.py`**: 依存なし（標準ライブラリだけの最小 WebSocket クライアント、relay の ping に pong を返すリーダースレッド付き）。`KomaBridge(url).send_led(geo)` / `send_camera(cam)` / `send_pose()` / `send_axes()` / `send_frame()`、`follow_playbar(led_node=, camera=)` で playbar 連動。動作確認済（relay + 偽 capture + Python、3 トピックの転送と ping 生存）。ブラウザ側（koma 本体でのスイッチ→LED/リグ）は実機・ハード無し mock ともに未確認。
- **シェルフ「Koma」**（2026-10-01、`scripts/houdini/toolbar/koma.shelf` + `koma_shelf.py`）: `python3 scripts/houdini/install.py [21.0]` が `$HOUDINI_USER_PREF_DIR/packages/koma.json`（`hpath` = `scripts/houdini`、env `KOMA_HOUDINI`）を書く → Houdini を再起動 → シェルフ領域の + > Shelves > Koma。ツール: **LED Live**（playbar 連動のトグル。フレーム番号と LED 色を毎フレーム送る）/ **LED Send**（いまのフレームを 1 回）/ **Koma Stop**（連動停止 + 切断）/ **Export Set**（プロジェクトフォルダを選んで `previz/set.json`）/ **Koma Settings**（relay URL・token・LED ノード・カメラ）。設定は `$HOUDINI_USER_PREF_DIR/koma_bridge.json`。LED ノードは保存済みのもの、無ければ選択中の SOP（初回に保存）。接続と playbar コールバックはモジュールが保持するので Houdini セッション中は続く。確認は hython（シェルフの読み込み、1 回送信、連動のオン/オフ、relay 不通のエラー、set.json）で、playbar は hython に無いので代役で発火させた。**GUI の Houdini でのボタン操作と実 playbar は未確認。**
- 本番の照明はこれまでどおり展開図 PNG（filmLift 非依存、再演で再サンプル可）。直接色は lookdev / スクラブ確認用で、filmLift のシフトは Houdini が知っている前提。

### テストデータ: 2021 年の VICE 撮影（Dragonframe）の取り込み
- `scripts/import-dragonframe.mjs <dgn-root> <dest> --name …` で Dragonframe の `.dgn` を koma プロジェクトに変換（テイクごとに名前付きレイヤー、フレーム 0 始まり。EDL から外れたコマは `_trash` に「撮影されたフレーム」つきで入る。EXIF + take.xml のメタデータ、meta.txt の FIRST FRAME でカメラ時計を補正。jpg は 3000px に縮小、lv は 1920px、RAW はコピーせず名前だけ）。
- 生成済み: `~/Dropbox/Works/2024/10_addsub/capture/vice-tests-2021`（"VICE tests 2021"、14 テイク = 440 コマ + 破棄 145、1.2 GB）。プリセット "All takes" / "Main only"。
- `scripts/import-sequence.mjs <dir> <project> --name …` で画像連番をレイヤーとして追加（`Previz (shapes)` = `prj/render/2024_10_addsub_shapes.viewport_preview1_cache` の 840 枚を取り込み済み）。
- 展示は **"Exhibit" という名前のプリセット**があればそのレイヤーだけを対象にする（previz 等の参照レイヤーを外すため）。vice-tests-2021 では "Exhibit" = 撮影テイク 14 レイヤー（previz 除外）。
- 展示ページの確認用に `exhibit.html?opfs=<name>&seed=<url>` を追加（フォルダピッカー無しで、URL から project.json と lv を OPFS に流し込んで読む）。dev では `public/_dev-*` のシンボリックリンク（gitignore 済み）で実フォルダを配信。

### `yarn aux` からトラッカーと DMX を撤去（2026-10-01）
- `dev_modules/aux-manager` は **ptpcamera の kill と OSC ブリッジ（WebSocket 8080 ↔ UDP in 5200 / out 5201）だけ**になった。Vive Tracker（libsurvive の `survive-cli` 起動・POSE のパース・smoothing・outlier gate・再校正）と DMX（Art-Net、`/dmx<N>`）は削除、`yarn recal` / `yarn raw` と依存（`dmx-ts` / `artnet` / `fps`）も削除。CLAUDE.md の「aux トラッカー取得（libsurvive）」の節は `main` の記録で、このブランチの `yarn aux` には当てはまらない。
- 残したもの: `dev_modules/libsurvive/`（ビルド済みバイナリ）、koma 側の `stores/tracker.ts` / `auxDevices.ts` / `dmx.ts` / `DmxControl.vue`（トラッカーは常に無効、DMX のスライダーと blackout は `/dmx<N>` を OSC で出すだけでどこにも届かない）。OSC の `/shoot` は従来どおり効く。

### 手元で試す（ハード無しの確認）
- `yarn test`（parse・IK・LED map）。
- ESP32 dev board に FluidNC を焼き、config.yaml に `name: BoxRig` を書けば、モーター無しでも識別・自動再接続・ジョグ送信・Idle 待ちを確認できる。`name: AST200` にすればフライス盤側。
- 同じ板に `dev_modules/ws-fanout/firmware` を焼けば（NodeMCU は BOOT 長押し個体あり）、LED 未接続でも INFO / SHOW ACK まで通る。

### 未実装（仕様にあるもの）
- §8.1 AE リアルタイムプレビュー、§9 館外へのキャスト（館内は koma-relay の WebRTC で済む）、§12 校正ウィザード、§13.2 Houdini とのリアルタイム通信、§14 レイヤー種別と保存フォルダ、§15 の 3D 区画（今は座標の数値表示）と `_lv` キャッシュ、relay の launchd / キオスク起動手順、脱調検知。
