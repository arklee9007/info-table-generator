#!/usr/bin/env bash
# build-apk.sh —— 构建自签 APK（无 Gradle，直接调 aapt2/javac/d8/zipalign/apksigner）。
# 用法：bash tools/build-apk.sh
# 环境：JAVA_HOME（默认 ~/workspace/.toolchains/jdk17）、ANDROID_HOME（默认 ~/workspace/.toolchains/android-sdk）。
# 密钥：首建自动生成 shells/android/itg-release.keystore + keystore.properties，之后复用；
#      覆盖升级必须同一把密钥，此两文件须留底保管，丢失则已装用户无法覆盖升级。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHELL_DIR="$ROOT/shells/android"
JAVA_HOME="${JAVA_HOME:-$HOME/workspace/.toolchains/jdk17}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/workspace/.toolchains/android-sdk}"
export PATH="$JAVA_HOME/bin:$PATH"
BT="$ANDROID_HOME/build-tools/34.0.0"
ANDROID_JAR="$ANDROID_HOME/platforms/android-34/android.jar"

for t in "$JAVA_HOME/bin/javac" "$JAVA_HOME/bin/keytool" "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$ANDROID_JAR"; do
  [ -e "$t" ] || { echo "缺工具：$t" >&2; exit 1; }
done

VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/app/version.json','utf8')).version)")"
IFS=. read -r MAJOR MINOR PATCH <<<"$VERSION"
VERSION_CODE=$((MAJOR * 10000 + MINOR * 100 + PATCH))
echo "构建 APK v$VERSION (code $VERSION_CODE)"

# 1) 先构建最新 PWA 发行目录（壳内资产与 PWA 同一份）
node "$ROOT/tools/build-pwa.mjs" >/dev/null

BUILD="$SHELL_DIR/build"
OUT="$SHELL_DIR/out"
rm -rf "$BUILD"
mkdir -p "$BUILD/flat" "$BUILD/classes" "$BUILD/dex" "$OUT"

# 2) 生成 UpdateConfig（更新源地址，空 = 不检查更新）
UPDATE_URL="$(tr -d ' \t\r\n' <"$SHELL_DIR/update-url.txt" 2>/dev/null || true)"
GEN="$BUILD/gen/top/infotable/generator"
mkdir -p "$GEN"
ESCAPED_URL="$(printf '%s' "$UPDATE_URL" | sed 's/\\/\\\\/g; s/"/\\"/g')"
cat >"$GEN/UpdateConfig.java" <<EOF
package top.infotable.generator;
// 构建生成：更新源地址（version.json 的 https 地址），空字符串 = 未配置更新源。
public final class UpdateConfig {
    public static final String UPDATE_URL = "$ESCAPED_URL";
    private UpdateConfig() {}
}
EOF

# 3) 编译资源
"$BT/aapt2" compile --dir "$SHELL_DIR/res" -o "$BUILD/compiled.zip" >/dev/null

# 4) 链接（manifest + 资源 + 资产）
"$BT/aapt2" link -o "$BUILD/unsigned.apk" \
  --manifest "$SHELL_DIR/AndroidManifest.xml" \
  -I "$ANDROID_JAR" \
  --version-code "$VERSION_CODE" --version-name "$VERSION" \
  -R "$BUILD/compiled.zip" \
  -A "$ROOT/dist-pwa" \
  --auto-add-overlay >/dev/null

# 5) 编译 Java
find "$SHELL_DIR/java" "$GEN" -name '*.java' >"$BUILD/sources.txt"
"$JAVA_HOME/bin/javac" -encoding UTF-8 -source 11 -target 11 -nowarn -Xlint:-options \
  -classpath "$ANDROID_JAR" -d "$BUILD/classes" @"$BUILD/sources.txt"

# 6) DEX（d8 吃 jar，不吃目录）
(cd "$BUILD/classes" && "$JAVA_HOME/bin/jar" cf "$BUILD/app.jar" .)
"$BT/d8" --release --lib "$ANDROID_JAR" --output "$BUILD/dex" "$BUILD/app.jar" >/dev/null

# 7) DEX 入包
python3 - "$BUILD/unsigned.apk" "$BUILD/dex/classes.dex" <<'EOF'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_STORED) as z:
    z.write(dex, 'classes.dex')
EOF

# 8) 对齐
"$BT/zipalign" -f 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk" >/dev/null

# 9) 密钥（首建生成，之后复用）
KS="$SHELL_DIR/itg-release.keystore"
KSPROP="$SHELL_DIR/keystore.properties"
if [ ! -f "$KS" ]; then
  echo "生成发布密钥（首建一次，之后复用）…"
  STOREPASS="$(openssl rand -hex 16)"
  KEYPASS="$(openssl rand -hex 16)"
  printf 'storepass=%s\nkeypass=%s\nalias=itg-release\n' "$STOREPASS" "$KEYPASS" >"$KSPROP"
  chmod 600 "$KSPROP"
  "$JAVA_HOME/bin/keytool" -genkeypair -storetype JKS -alias itg-release -keyalg RSA -keysize 2048 \
    -validity 9125 -keystore "$KS" -storepass "$STOREPASS" -keypass "$KEYPASS" \
    -dname "CN=InfoTable, O=InfoTable" -noprompt >/dev/null
fi
STOREPASS="$(grep '^storepass=' "$KSPROP" | cut -d= -f2)"
KEYPASS="$(grep '^keypass=' "$KSPROP" | cut -d= -f2)"
ALIAS="$(grep '^alias=' "$KSPROP" | cut -d= -f2)"

# 10) 签名
APK="$OUT/info-table-generator-v$VERSION.apk"
ITG_KS_PASS="$STOREPASS" ITG_KEY_PASS="$KEYPASS" "$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias "$ALIAS" \
  --ks-pass env:ITG_KS_PASS --key-pass env:ITG_KEY_PASS \
  --out "$APK" "$BUILD/aligned.apk"

# 11) 验证
"$BT/apksigner" verify --verbose "$APK" | grep -E "Verified|WARNING" || true
"$BT/zipalign" -c 4 "$APK" && echo "zipalign: OK"
"$BT/aapt2" dump badging "$APK" | head -3 || true
echo "APK: $APK ($(du -h "$APK" | cut -f1), sha256 $(sha256sum "$APK" | cut -c1-16)…)"
