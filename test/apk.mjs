// test/apk.mjs —— 阶段 3 验收：APK 结构/签名/资产一致性 + JS 桥路径（真浏览器注入桩）。
// 运行：NODE_PATH=$PWD/node_modules node test/apk.mjs
// 说明：本机无 KVM，无法跑 Android 模拟器；WebView 真机运行须 Sam 首次安装时亲验
// （首装清单见 reports/stage3.md）。此处验：构建产物正确 + 桥的 JS 侧正确 + 原生侧可编译。

import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'shells/android');
const DIST = join(ROOT, 'dist-pwa');
const OUT = join(ROOT, 'test/out');
const BT = join(process.env.HOME, 'workspace/.toolchains/android-sdk/build-tools/34.0.0');
// 期望版本从 app/version.json 读，不写死（发版后测试不用改数字）
const APP_VERSION = JSON.parse(readFileSync(join(ROOT, 'app/version.json'), 'utf-8')).version;
const [MAJOR, MINOR, PATCH] = APP_VERSION.split('.').map(Number);
const VERSION_CODE = MAJOR * 10000 + MINOR * 100 + PATCH; // 与 tools/build-apk.sh 口径一致
const APK = join(SHELL, `out/info-table-generator-v${APP_VERSION}.apk`);

const requireCjs = createRequire(import.meta.url);
const parser = requireCjs('/home/hatch/workspace/miniprogram-mall/work-042/modules/material-import/parser.cjs');

const results = [];
let failures = 0;
async function test(id, name, fn) {
  try {
    const detail = await fn();
    results.push({ id, name, ok: true, detail: detail ?? '' });
    console.log(`PASS ${id} ${name}`);
  } catch (e) {
    failures++;
    results.push({ id, name, ok: false, detail: String(e?.message || e) });
    console.log(`FAIL ${id} ${name}\n     ${String(e?.message || e).split('\n').join('\n     ')}`);
  }
}
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function includes(hay, needle, what) {
  if (!String(hay).includes(needle)) throw new Error(`${what}：期望包含「${needle}」，实际「${hay}」`);
}
const JDK_BIN = join(process.env.HOME, 'workspace/.toolchains/jdk17/bin');
function run(cmd, what) {
  const r = spawnSync('bash', ['-c', cmd], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: JDK_BIN + ':' + process.env.PATH, JAVA_HOME: join(process.env.HOME, 'workspace/.toolchains/jdk17') },
  });
  if (r.status !== 0) throw new Error(`${what} 失败（exit ${r.status}）：\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}`);
  return r.stdout;
}
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
function walkFiles(dir, base = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkFiles(join(dir, e.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

let certDigest = '';
await test('K1', 'APK 存在且签名验证通过（v2/v3）', () => {
  if (!existsSync(APK)) throw new Error('APK 不存在：' + APK);
  const out = run(`"${BT}/apksigner" verify --verbose --print-certs "${APK}"`, 'apksigner verify');
  includes(out, 'Verified using v2 scheme (APK Signature Scheme v2): true', 'v2 签名');
  includes(out, 'Verified using v3 scheme (APK Signature Scheme v3): true', 'v3 签名');
  const m = out.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f]+)/);
  if (!m) throw new Error('读不到签名证书摘要');
  certDigest = m[1];
  return `size ${(statSync(APK).size / 1024).toFixed(0)} KB, cert ${certDigest.slice(0, 16)}…`;
});

await test('K2', 'zipalign 4 字节对齐', () => {
  run(`"${BT}/zipalign" -c 4 "${APK}"`, 'zipalign check');
  return 'ok';
});

await test('K3', '包名/版本/权限/Activity 正确', () => {
  const out = run(`"${BT}/aapt2" dump badging "${APK}"`, 'aapt2 dump');
  includes(out, `name='top.infotable.generator' versionCode='${VERSION_CODE}' versionName='${APP_VERSION}'`, '包与版本');
  includes(out, 'sdkVersion:', 'sdkVersion');
  includes(out, "targetSdkVersion:'34'", 'targetSdk');
  includes(out, 'launchable-activity:', '启动 Activity');
  includes(out, 'android.permission.INTERNET', 'INTERNET 权限');
  includes(out, 'android.permission.REQUEST_INSTALL_PACKAGES', '安装权限');
  includes(out, "application-label:'信息表生成器'", '应用名');
  return 'ok';
});

await test('K4', '包内资产与 dist-pwa 逐字节一致', () => {
  const entries = unzipSync(new Uint8Array(readFileSync(APK)));
  const distFiles = walkFiles(DIST);
  const missing = [];
  const diff = [];
  for (const rel of distFiles) {
    const key = 'assets/' + rel;
    if (!entries[key]) { missing.push(rel); continue; }
    if (sha256(Buffer.from(entries[key])) !== sha256(readFileSync(join(DIST, rel)))) diff.push(rel);
  }
  if (missing.length) throw new Error('资产缺失：' + missing.join(', '));
  if (diff.length) throw new Error('资产不一致：' + diff.join(', '));
  return `${distFiles.length} 个资产文件一致`;
});

await test('K5', 'DEX 含三个壳类', () => {
  const entries = unzipSync(new Uint8Array(readFileSync(APK)));
  const dexPath = join(OUT, 'apk-classes.dex');
  writeFileSync(dexPath, Buffer.from(entries['classes.dex']));
  const dump = run(`"${BT}/dexdump" "${dexPath}"`, 'dexdump');
  for (const cls of ['top/infotable/generator/MainActivity', 'top/infotable/generator/NativeBridge', 'top/infotable/generator/UpdateConfig']) {
    includes(dump, 'Class descriptor', cls); // 占位，真正断言在下
    if (!dump.includes(cls)) throw new Error('DEX 缺类：' + cls);
  }
  return 'ok';
});

await test('K6', '重复构建复用同一把密钥（证书不变）', () => {
  run(`bash "${join(ROOT, 'tools/build-apk.sh')}"`, '二次构建');
  const out = run(`"${BT}/apksigner" verify --verbose --print-certs "${APK}"`, 'apksigner verify');
  const m = out.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f]+)/);
  eq(m && m[1], certDigest, '证书摘要');
  return 'same cert, upgrades will work';
});

await test('K7', '更新地址注入 DEX（构建期配置生效）', () => {
  const urlFile = join(SHELL, 'update-url.txt');
  const prev = readFileSync(urlFile, 'utf-8');
  try {
    writeFileSync(urlFile, 'https://example.invalid/itg/version.json\n');
    run(`bash "${join(ROOT, 'tools/build-apk.sh')}"`, '带地址构建');
    const entries = unzipSync(new Uint8Array(readFileSync(APK)));
    const dex = Buffer.from(entries['classes.dex']).toString('latin1');
    includes(dex, 'https://example.invalid/itg/version.json', 'DEX 内更新地址');
    return 'url embedded';
  } finally {
    writeFileSync(urlFile, prev);
    run(`bash "${join(ROOT, 'tools/build-apk.sh')}"`, '恢复空地址构建');
  }
});

await test('K8', 'JS 桥路径：桩桥收到 base64，出包可被真解析器验收', async () => {
  // 静态服务器 + CfT，页面加载后注入桩 ItgNative，跑解析→配图→出包
  const { createServer } = await import('node:http');
  const { extname } = await import('node:path');
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  const server = createServer((req, res) => {
    let p = req.url === '/' ? '/index.html' : req.url;
    const f = join(DIST, decodeURIComponent(p));
    if (!f.startsWith(DIST) || !existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  await new Promise((r) => server.listen(18794, '127.0.0.1', r));
  const browser = await puppeteer.launch({
    executablePath: '/home/hatch/workspace/.chrome-test/chrome/linux-157.0.8103.78/chrome-linux64/chrome',
    headless: true, args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__bridgeCalls = [];
      window.ItgNative = {
        saveFile: (b64, name, mime) => {
          window.__bridgeCalls.push({ b64, name, mime });
          return 'OK:' + name;
        },
        getUpdateUrl: () => '',
        downloadApk: () => {},
      };
    });
    await page.goto('http://127.0.0.1:18794/', { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
    await page.type('#pasteArea', '款名：桥测试款\n分类：短袖\n价格：129\n运费：包邮\n颜色：黑色\n尺码：M\n图案：素色\n库存：10');
    await page.click('#parsePasteBtn');
    await page.waitForSelector('[data-testid="style-card"]', { timeout: 10000 });
    const input = await page.$('[data-testid="image-input"]');
    await input.uploadFile(join(ROOT, 'test/samples/main-1080.png'));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="thumb"]').length === 1, { timeout: 10000 });
    await page.click('[data-testid="pack-btn"]');
    await page.waitForFunction(() => window.__bridgeCalls.length > 0, { timeout: 10000 });
    const call = await page.evaluate(() => window.__bridgeCalls[0]);
    eq(call.name, '桥测试款.zip', '桥收到的文件名');
    eq(call.mime, 'application/zip', '桥收到的 MIME');
    const zipBuf = Buffer.from(call.b64, 'base64');
    const r = await parser.parsePackage(zipBuf, call.name);
    eq(r.ok, true, '桥收到的包真解析器通过');
    eq(r.report.code, '桥测试款', '款号');
    const msg = await page.$eval('.msg.ok', (e) => e.textContent);
    includes(msg, '已保存到下载文件夹', '界面提示走桥');
    return 'bridge path ok';
  } finally {
    await browser.close();
    server.close();
  }
});

const evidence = {
  ranAt: new Date().toISOString(),
  apk: APK,
  apkSha256: existsSync(APK) ? sha256(readFileSync(APK)) : null,
  certSha256: certDigest,
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'apk-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} 通过，证据：test/out/apk-evidence.json`);
process.exit(failures ? 1 : 0);
