# libsurvive (macOS Apple Silicon build / HIDAPI backend)

SteamVR を使わずに Vive Tracker / Lighthouse の pose を取得するための
[cntools/libsurvive](https://github.com/cntools/libsurvive) を、Apple Silicon (arm64) 向けに
**HIDAPI バックエンド**でビルドしたもの。`node-openvr`（= SteamVR ランタイム必須）の代替。

## 重要: なぜ HIDAPI なのか（macOS の肝）

- SteamVR は Apple Silicon macOS では動かない（Intel専用・2020年サポート終了）。
- libsurvive を **libusb** バックエンドでビルドすると、macOS では動かない。
  デバイスの列挙・claim・設定読み取りまでは成功するが、センサーデータの IN 転送の瞬間に
  macOS の IOKit (HIDドライバ) がエンドポイントを奪い返し、
  `no connection to an IOService` / `LIBUSB_ERROR_NO_DEVICE` で失敗する（sudo でも不可）。
- **HIDAPI** バックエンド (`-DUSE_HIDAPI=ON`) は macOS ネイティブの IOHIDManager を使うため、
  カーネルの HID スタックと競合せず読める。**sudo 不要・kext 不要**。← これが正解。

実機検証済み（macOS 26.2 / arm64 / VIVE Tracker 3.0 MV + Watchman ドングル + Lighthouse）:
IMU ストリーミング → Lighthouse 捕捉 → OOTX デコード → キャリブレーション → POSE 連続出力 まで確認。

## ビルド構成

- backend: HIDAPI（`brew install hidapi`、`-DUSE_HIDAPI=ON`）
- 数値: Accelerate(vecLib) cblas + eigen backend
- `install/bin/survive-cli` … pose を stdout に出力（arm64ネイティブ）
- `install/lib/libsurvive/plugins/driver_vive.dylib` … `libhidapi.0.dylib` をリンク

## 再ビルド手順（メモ）

```bash
brew install hidapi          # 必須（libusb ではこれが効かない）
git clone --recursive https://github.com/cntools/libsurvive.git
cd libsurvive
# stdout を行バッファ化するパッチを当てる（理由は下記「行バッファリング」参照）。
# これが無いと aux-manager にパイプしたとき pose が ~0.5 秒ごとの一括更新になる。
git apply <このディレクトリ>/line-buffer.patch
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DUSE_HIDAPI=ON \
  -DCMAKE_SHARED_LINKER_FLAGS="-L/opt/homebrew/lib" \
  -DCMAKE_EXE_LINKER_FLAGS="-L/opt/homebrew/lib"     # ← hidapi のリンクパスを明示しないと失敗する
cmake --build build -j$(sysctl -n hw.ncpu)
cmake --install build --prefix <このディレクトリ>/install
# install 後、bin の rpath が落ちるので付け直す:
for b in survive-cli sensors-readout api_example survive-solver survive-buttons; do
  install_name_tool -add_rpath @loader_path/../lib install/bin/$b
done
```

### 行バッファリング（line-buffer.patch）

survive-cli は記録を `fprintf(stdout, …)` で出すが flush しない。stdout が
**パイプ**（aux-manager が spawn したとき）だと libc が全バッファリング（~64KB）に
なり、~150KB/s の出力では約 0.5 秒ごとにしか flush されない → pose がまとめて
一括到着し、見かけのリフレッシュレートが ~1.5Hz に落ちる。`line-buffer.patch` は
`main()` で `setvbuf(stdout, NULL, _IOLBF, 0)` を呼び、改行ごとに flush させて
これを解消する（ファイル/ターミナル出力時は元から問題にならない）。

## 実行（sudo 不要）

```bash
./install/bin/survive-cli --record-stdout
```

初回はキャリブレーションが走る。トラッカーをベースステーションが見える範囲で動かすと、
数十秒で POSE が出始める。pose 行のフォーマット:

```
<timestamp> <codename> POSE <x> <y> <z> <qw> <qx> <qy> <qz>
```

- `<codename>` 例: `WM0`（トラッカー）, `LH0`（ベースステーション）
- position は (x, y, z) [m]、rotation は quaternion (qw, qx, qy, qz)
- 他に `i`=IMU, `LH_UP`=lighthouse 検出, `CONFIG`=デバイス設定 等の行も流れる

## aux-manager への統合方針

`node-openvr` の `VR_Init` / `GetDeviceToAbsoluteTrackingPose` を捨て、
`survive-cli --record-stdout` を `child_process.spawn` で起動し、stdout を行ごとに
パースして `POSE` 行から `sendOsc('/trackerN/position', x,y,z)` /
`sendOsc('/trackerN/rotation', qw,qx,qy,qz)` に流す。

OpenVR は 4x3 row-major 行列だったが、libsurvive は最初から quaternion なので
`linearly` での行列変換（transpose / getRotation）は不要になる。

## 注意

- キャリブレーションデータは `~/.config/libsurvive/` に保存される（このディレクトリは作成済み）。
- 起動前に他の survive-cli プロセスが残っていないこと（デバイスを掴んでいると開けない）。
