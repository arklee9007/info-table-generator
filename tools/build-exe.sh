#!/usr/bin/env bash
# build-exe.sh —— 构建 Windows 便携版（免安装文件夹，zip 交付）。
# 形态：解压后双击「信息表生成器.exe」即用；首次运行 SmartScreen 点「更多信息→仍要运行」。
# 为什么不是 NSIS 安装包：electron-builder 的 win 目标在 Linux 下需 wine（rcedit/NSIS），
# 本机 apt 装 wine 极慢（i386 索引 6 分钟未下完），故 v1 走手工组装便携版；
# NSIS 安装包可在 Windows 机器上用壳内 electron-builder 配置一键打出（见 WINDOWS-BUILD-NOTE.md）。
# 用法：bash tools/build-exe.sh
# 产物：shells/electron/out/信息表生成器-<版本>-win64.zip
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHELL_DIR="$ROOT/shells/electron"
ELECTRON_VERSION="$(node -e "console.log(require('$SHELL_DIR/node_modules/electron/package.json').version)")"
VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/app/version.json','utf8')).version)")"
CACHE_DIR="$HOME/workspace/.toolchains/electron-win32"
ZIP_NAME="electron-v${ELECTRON_VERSION}-win32-x64.zip"
OUT_DIR="$SHELL_DIR/out"
APP_NAME="信息表生成器"

echo "构建 EXE 便携版 v$VERSION（Electron $ELECTRON_VERSION）"

# 1) 最新 PWA 发行目录拷进壳
node "$ROOT/tools/build-pwa.mjs" >/dev/null
rm -rf "$SHELL_DIR/app"
cp -r "$ROOT/dist-pwa" "$SHELL_DIR/app"

# 2) 更新配置（空 = 不检查更新）
UPDATE_URL="$(tr -d ' \t\r\n' <"$SHELL_DIR/update-url.txt" 2>/dev/null || true)"
node -e "
const fs=require('fs');
fs.writeFileSync('$SHELL_DIR/update-config.json', JSON.stringify({updateUrl: process.argv[1]}));
" "$UPDATE_URL"

# 3) 壳 package.json 版本同步（asar 内版本须与 version.json 一致）
node -e "
const fs=require('fs');
const f='$SHELL_DIR/package.json';
const p=JSON.parse(fs.readFileSync(f,'utf8'));
p.version='$VERSION';
fs.writeFileSync(f, JSON.stringify(p,null,2)+'\n');
"

# 4) 取官方 Electron win32 发行包（缓存 + SHA256 校验）
mkdir -p "$CACHE_DIR"
cd "$CACHE_DIR"
if [ ! -f "$ZIP_NAME" ]; then
  curl -sL -o "$ZIP_NAME" "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/${ZIP_NAME}"
fi
curl -sL -o SHASUMS256.txt "https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/SHASUMS256.txt"
grep -F " *$ZIP_NAME" SHASUMS256.txt | sha256sum -c - || { echo "发行包 SHA 校验失败"; rm -f "$ZIP_NAME"; exit 1; }

# 5) 组装
STAGE="$(mktemp -d "$HOME/workspace/.toolchains/exe-stage.XXXXXX")"
unzip -q -o "$CACHE_DIR/$ZIP_NAME" -d "$STAGE"
rm -f "$STAGE/resources/default_app.asar"
# 打包 asar（只含壳文件 + app/，不含 node_modules）
ASAR_SRC="$(mktemp -d "$HOME/workspace/.toolchains/asar-src.XXXXXX")"
cp "$SHELL_DIR/main.js" "$SHELL_DIR/preload.js" "$SHELL_DIR/package.json" "$SHELL_DIR/update-config.json" "$ASAR_SRC/"
cp -r "$SHELL_DIR/app" "$ASAR_SRC/app"
"$SHELL_DIR/node_modules/.bin/asar" pack "$ASAR_SRC" "$STAGE/resources/app.asar" >/dev/null
rm -rf "$ASAR_SRC"
mv "$STAGE/electron.exe" "$STAGE/${APP_NAME}.exe"

# 6) 打 zip（文件夹形态：信息表生成器/…）
mkdir -p "$OUT_DIR"
ZIP_OUT="$OUT_DIR/${APP_NAME}-${VERSION}-win64.zip"
rm -f "$ZIP_OUT"
cd "$(dirname "$STAGE")"
mv "$STAGE" "$HOME/workspace/.toolchains/${APP_NAME}"
cd "$HOME/workspace/.toolchains"
zip -q -r "$ZIP_OUT" "${APP_NAME}"
rm -rf "$HOME/workspace/.toolchains/${APP_NAME}"

echo "---- 产物 ----"
ls -la "$ZIP_OUT"
echo "sha256 $(sha256sum "$ZIP_OUT" | cut -c1-16)…"
unzip -l "$ZIP_OUT" | head -8
