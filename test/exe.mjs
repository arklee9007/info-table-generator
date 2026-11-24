// test/exe.mjs —— 阶段 4 验收：Windows 产物结构 + Electron 壳真跑（Linux 下 Xvfb）。
// 运行：NODE_PATH=$PWD/node_modules node test/exe.mjs
// 说明：Windows 安装包本身无法在本机运行（无 Windows）；验：产物结构正确、asar 内容与
// dist-pwa 一致、壳逻辑在 Linux 版 Electron 内真跑通过（含出包下载落盘 + 更新流程）。
// Windows 真机首装清单见 reports/stage4.md。

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, cpSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'shells/electron');
const DIST = join(ROOT, 'dist-pwa');
const OUT = join(ROOT, 'test/out');
const SAMPLES = join(ROOT, 'test/samples');
mkdirSync(OUT, { recursive: true });

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
function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

const outDir = join(SHELL, 'out');
const version = JSON.parse(readFileSync(join(ROOT, 'app/version.json'), 'utf8')).version;
const zipOut = join(outDir, `信息表生成器-${version}-win64.zip`);
const unpacked = join(OUT, 'win-unpacked-test');

await test('X1', 'Windows 便携版 zip 存在，内含 EXE（PE）与 asar', () => {
  if (!existsSync(zipOut)) throw new Error('无产物：' + zipOut);
  if (statSync(zipOut).size < 30 * 1024 * 1024) throw new Error('zip 小于 30MB，不像完整 Electron 包');
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  const r = spawnSync('unzip', ['-q', '-o', zipOut, '-d', unpacked], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error('解压失败：' + r.stderr);
  const exe = join(unpacked, '信息表生成器', '信息表生成器.exe');
  if (!existsSync(exe)) throw new Error('无 exe：' + readdirSync(join(unpacked, '信息表生成器')).join(', '));
  const head = readFileSync(exe).subarray(0, 2).toString('latin1');
  eq(head, 'MZ', 'EXE PE 头');
  const asarPath = join(unpacked, '信息表生成器', 'resources/app.asar');
  if (!existsSync(asarPath)) throw new Error('无 resources/app.asar');
  if (existsSync(join(unpacked, '信息表生成器', 'resources/default_app.asar'))) throw new Error('不应残留 default_app.asar');
  return `${(statSync(zipOut).size / 1048576).toFixed(1)}MB`;
});

await test('X2', 'asar 内容与 dist-pwa 一致、版本一致', () => {
  const asarPath = join(unpacked, '信息表生成器', 'resources/app.asar');
  const shellRequire = createRequire(join(SHELL, 'package.json'));
  const asar = shellRequire('asar');
  const list = asar.listPackage(asarPath);
  const expect = ['/package.json', '/main.js', '/preload.js', '/update-config.json', '/app/index.html', '/app/app.js', '/app/core/index.js', '/app/core/fields.js', '/app/templates/clothing-v1.json', '/app/vendor/fflate-0.8.3.min.js'];
  for (const e of expect) {
    if (!list.includes(e)) throw new Error('asar 缺：' + e);
  }
  for (const rel of ['index.html', 'core/fields.js', 'templates/clothing-v1.json']) {
    const fromAsar = asar.extractFile(asarPath, 'app/' + rel);
    eq(sha256(fromAsar), sha256(readFileSync(join(DIST, rel))), 'asar 内 app/' + rel);
  }
  const pkg = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'));
  eq(pkg.version, version, '壳内版本号');
  return `${list.length} 个文件在 asar 内`;
});

// ---- Electron 真跑（Linux，Xvfb） ----
async function launchElectron(homeDir, extraArgs = []) {
  // 模拟真实桌面：写 user-dirs.dirs，否则全新 HOME 下 Chromium 的 getPath('downloads')
  // 会回退到 HOME 本身，下载落点与真机不一致。
  mkdirSync(join(homeDir, '.config'), { recursive: true });
  mkdirSync(join(homeDir, 'Downloads'), { recursive: true });
  writeFileSync(join(homeDir, '.config/user-dirs.dirs'), `XDG_DOWNLOAD_DIR="${join(homeDir, 'Downloads')}"\n`);
  const proc = spawn('xvfb-run', ['-a', join(SHELL, 'node_modules/.bin/electron'), '.', '--remote-debugging-port=9223', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', ...extraArgs], {
    cwd: SHELL,
    env: { ...process.env, HOME: homeDir, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d.toString(); });
  // 等调试端口
  const t0 = Date.now();
  let wsUrl = null;
  while (Date.now() - t0 < 45000) {
    try {
      const res = await fetch('http://127.0.0.1:9223/json/version');
      if (res.ok) { wsUrl = (await res.json()).webSocketDebuggerUrl; break; }
    } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error('Electron 调试端口未起，stderr：' + stderr.slice(-500));
  }
  const browser = await puppeteer.connect({ browserWSEndpoint: wsUrl, protocolTimeout: 30000 });
  const pages = await browser.pages();
  const page = pages.find((p) => p.url().startsWith('http://127.0.0.1')) || pages[0];
  // 等 SW 首次接管完成：接管会触发 controllerchange → location.reload()（app.js），
  // 不等它 settle，后续一次性操作（type/click）会撞上重载竞态。
  await page.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 20000 });
  try {
    await page.waitForFunction(() => navigator.serviceWorker?.controller !== null, { timeout: 15000 });
  } catch { /* 无 SW 也继续 */ }
  await page.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 300));
  return { proc, browser, page, stderr: () => stderr };
}

await test('X3', 'Electron 壳真跑：解析→配图→出包落盘，真解析器验收', async () => {
  const home = join(OUT, 'electron-home');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'Downloads'), { recursive: true });
  // 确保壳内 app/ 与配置最新（build-exe.sh 已拷；此处直接用 electron 源码运行）
  const { proc, browser, page } = await launchElectron(home);
  try {
    await page.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 20000 });
    eq(await page.title(), '信息表生成器', '标题');
    const hasBridge = await page.evaluate(() => typeof window.ItgDesktop?.getUpdateUrl === 'function');
    eq(hasBridge, true, 'ItgDesktop 桥存在');
    const upd = await page.evaluate(() => window.ItgDesktop.getUpdateUrl());
    eq(upd, '', '默认无更新地址');
    await page.type('#pasteArea', readFileSync(join(SAMPLES, 'fieldblock-1.txt'), 'utf-8'));
    await page.click('#parsePasteBtn');
    await page.waitForSelector('[data-testid="style-card"]', { timeout: 10000 });
    const input = await page.$('[data-testid="image-input"]');
    await input.uploadFile(join(SAMPLES, 'main-1080.png'), join(SAMPLES, 'detail-1.png'));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="thumb"]').length === 2, { timeout: 10000 });
    await page.click('[data-testid="pack-btn"]');
    // 等文件落到 Downloads
    const t0 = Date.now();
    let zipPath = null;
    while (Date.now() - t0 < 15000) {
      const dl = join(home, 'Downloads');
      const hit = readdirSync(dl).find((f) => f === 'ZB-DX-001.zip');
      if (hit) { zipPath = join(dl, hit); break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!zipPath) throw new Error('Downloads 内无出包文件，现有：' + readdirSync(join(home, 'Downloads')).join(', '));
    const r = await parser.parsePackage(readFileSync(zipPath), 'ZB-DX-001.zip');
    eq(r.ok, true, '真解析器 ok');
    eq(r.product.skus.length, 4, 'SKU 数');
    return 'download landed + parser validated';
  } finally {
    await browser.close();
    proc.kill();
  }
});

await test('X4', '更新流程：远端新版弹窗、确认后下载安装包', async () => {
  // 本地更新服务器：version.json 9.9.9 + exeUrl 指向一个假安装包
  const fakeExe = Buffer.from('MZ' + 'x'.repeat(1024));
  const updServer = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*'); // 页面 origin 与更新源不同端口，须放行
    if (req.url === '/version.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '9.9.9', notes: '测试更新', exeUrl: 'http://127.0.0.1:18795/fake-setup.exe' }));
    } else if (req.url === '/fake-setup.exe') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(fakeExe);
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => updServer.listen(18795, '127.0.0.1', r));
  // 临时更新配置
  const cfgPath = join(SHELL, 'update-config.json');
  const prevCfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf-8') : null;
  writeFileSync(cfgPath, JSON.stringify({ updateUrl: 'http://127.0.0.1:18795/version.json' }));
  const home = join(OUT, 'electron-home2');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, 'Downloads'), { recursive: true });
  const { proc, browser, page } = await launchElectron(home);
  try {
    await page.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 20000 });
    await page.waitForFunction(() => !document.querySelector('#updateBanner').hidden, { timeout: 10000 });
    const banner = await page.$eval('#updateText', (e) => e.textContent);
    includes(banner, '9.9.9', '横幅新版本');
    await page.click('#updateNowBtn');
    // 等假安装包落盘
    const t0 = Date.now();
    let hit = null;
    while (Date.now() - t0 < 15000) {
      hit = readdirSync(join(home, 'Downloads')).find((f) => f === 'fake-setup.exe');
      if (hit) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!hit) throw new Error('更新包未下载，Downloads：' + readdirSync(join(home, 'Downloads')).join(', '));
    eq(readFileSync(join(home, 'Downloads', hit)).equals(fakeExe), true, '下载内容一致');
    return 'update download ok';
  } finally {
    await browser.close();
    proc.kill();
    updServer.close();
    if (prevCfg === null) rmSync(cfgPath, { force: true });
    else writeFileSync(cfgPath, prevCfg);
  }
});

const evidence = {
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
writeFileSync(join(OUT, 'exe-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} 通过，证据：test/out/exe-evidence.json`);
process.exit(failures ? 1 : 0);
