// test/pwa.mjs —— 阶段 2 验收：真浏览器跑 PWA 全流程。
// 运行：NODE_PATH=$PWD/node_modules node test/pwa.mjs
// 覆盖：加载无错、粘贴解析、图片归类与排序、出包下载（真解析器验收）、webp 转换、
// 字段编辑、文件导入、离线可用、更新提示与确认更新、移动端视图。

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-pwa');
const SAMPLES = join(ROOT, 'test/samples');
const OUT = join(ROOT, 'test/out');
const DL = join(OUT, 'pwa-downloads');
mkdirSync(DL, { recursive: true });
for (const f of readdirSync(DL)) rmSync(join(DL, f));

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

function serve(root, port) {
  const server = createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = join(root, p);
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

const requireCjs = createRequire(import.meta.url);
const parser = requireCjs('/home/hatch/workspace/miniprogram-mall/work-042/modules/material-import/parser.cjs');

// 期望版本从 app/version.json 读，不写死（发版后测试不用改数字）
const APP_VERSION = JSON.parse(readFileSync(join(ROOT, 'app/version.json'), 'utf-8')).version;
const NEXT_VERSION = APP_VERSION.replace(/(\d+)$/, (m) => String(Number(m) + 1));

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
async function waitForNewFile(dir, before, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const fresh = readdirSync(dir).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
    if (fresh.length) return join(dir, fresh[0]);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('下载超时：无新文件出现在 ' + dir);
}
async function waitFile(dir, name, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (existsSync(join(dir, name)) && !existsSync(join(dir, name + '.crdownload'))) return join(dir, name);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`下载超时：${name} 未出现在 ${dir}（现有：${readdirSync(dir).join(', ')}）`);
}

const server = await serve(DIST, 18791);
const CHROME_PATH = process.env.ITG_CHROME || '/home/hatch/workspace/.chrome-test/chrome/linux-157.0.8103.78/chrome-linux64/chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const consoleErrors = [];
const failedReqs = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
page.on('requestfailed', (r) => failedReqs.push(r.url() + ' ' + (r.failure()?.errorText || '')));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });

const fieldblock1 = readFileSync(join(SAMPLES, 'fieldblock-1.txt'), 'utf-8');

async function setSelectByThumbName(sourceName, selectTestId, value) {
  await page.evaluate((sn, tid, val) => {
    const thumbs = [...document.querySelectorAll('[data-testid="thumb"]')];
    const thumb = thumbs.find((t) => t.querySelector('.meta').textContent.includes(sn));
    if (!thumb) throw new Error('找不到图片卡：' + sn);
    const sel = thumb.querySelector(`[data-testid="${tid}"]`);
    if (!sel) throw new Error('找不到选择框：' + tid + '（' + sn + '）');
    sel.value = val;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, sourceName, selectTestId, value);
  await new Promise((r) => setTimeout(r, 200));
}

await test('P1', '加载无错、模板就绪', async () => {
  await page.goto('http://127.0.0.1:18791/', { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
  eq(await page.title(), '信息表生成器', '标题');
  eq(await page.$eval('#versionLabel', (e) => e.textContent), 'v' + APP_VERSION, '版本号');
  const opt = await page.$eval('#templateSelect', (e) => e.options[e.selectedIndex].text);
  eq(opt, '服装 v1.0.0', '模板');
  const bannerVisible = await page.$eval('#updateBanner', (e) => getComputedStyle(e).display !== 'none');
  eq(bannerVisible, false, '无新版时横幅不可见');
  if (consoleErrors.length) throw new Error('控制台错误：' + consoleErrors.join(' | '));
  if (failedReqs.length) throw new Error('失败请求：' + failedReqs.join(' | '));
  const swReady = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'no-sw';
    await navigator.serviceWorker.ready;
    return navigator.serviceWorker.controller ? 'controlled' : 'registered';
  });
  return `SW: ${swReady}`;
});

await test('P2', '粘贴解析：规格预览与缺图拦截', async () => {
  await page.type('#pasteArea', fieldblock1);
  await page.click('#parsePasteBtn');
  await page.waitForSelector('[data-testid="style-card"]', { timeout: 10000 });
  const name = await page.$eval('[data-testid="style-card"] h3', (e) => e.textContent);
  eq(name, '重磅素色短袖', '款名');
  const rows = await page.$$eval('[data-testid="spec-table"] tbody tr', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)));
  eq(rows, [['本白', 'M', '素色', '50'], ['本白', 'L', '素色', '100'], ['克莱因蓝', 'M', '素色', '100'], ['克莱因蓝', 'L', '素色', '100']], '规格行');
  const errs = await page.$eval('[data-testid="style-errors"]', (e) => e.textContent);
  includes(errs, '缺主图', '缺图拦截');
  return 'ok';
});

await test('P3', '上传图片并归类，错误清零', async () => {
  const input = await page.$('[data-testid="image-input"]');
  await input.uploadFile(
    join(SAMPLES, 'main-1080.png'), join(SAMPLES, 'detail-1.png'), join(SAMPLES, 'detail-2.jpg'),
    join(SAMPLES, 'color-white.png'), join(SAMPLES, 'color-blue.jpg'), join(SAMPLES, 'size-chart.png')
  );
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="thumb"]').length === 6, { timeout: 10000 });
  await setSelectByThumbName('color-white.png', 'category-select', 'color');
  await setSelectByThumbName('color-white.png', 'color-select', '本白');
  await setSelectByThumbName('color-blue.jpg', 'category-select', 'color');
  await setSelectByThumbName('color-blue.jpg', 'color-select', '克莱因蓝');
  await setSelectByThumbName('size-chart.png', 'category-select', 'size');
  const state = await page.evaluate(() => {
    const s = window.__itg.styles[0];
    return { errors: s.errors, cats: s.images.map((i) => i.category + (i.colorKey ? ':' + i.colorKey : '')) };
  });
  eq(state.errors, [], '错误清零');
  eq(state.cats, ['main', 'detail', 'detail', 'color:本白', 'color:克莱因蓝', 'size'], '归类');
  return 'ok';
});

await test('P4', '详情图排序影响出包命名，真解析器验收', async () => {
  // 把 detail-1.png 往下移一位，详情墙顺序变为 detail-2, detail-1
  await page.evaluate(() => {
    const thumbs = [...document.querySelectorAll('[data-testid="thumb"]')];
    const thumb = thumbs.find((t) => t.querySelector('.meta').textContent.includes('detail-1.png'));
    const btns = thumb.querySelectorAll('.ops button');
    btns[1].click(); // ↓
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.click('[data-testid="pack-btn"]');
  const zipPath = await waitFile(DL, 'ZB-DX-001.zip');
  const buf = readFileSync(zipPath);
  // 包内文件名：详情图1 应为 jpg（原 detail-2.jpg 排首位）
  const { unzipSync } = await import('fflate');
  const names = Object.keys(unzipSync(new Uint8Array(buf))).sort();
  eq(names, ['ZB-DX-001/信息表.xlsx', 'ZB-DX-001/主图1.png', 'ZB-DX-001/详情图1.jpg', 'ZB-DX-001/详情图2.png', 'ZB-DX-001/颜色图-克莱因蓝.jpg', 'ZB-DX-001/颜色图-本白.png', 'ZB-DX-001/尺码图.png'].sort(), '包内文件名');
  const r = await parser.parsePackage(buf, 'ZB-DX-001.zip');
  eq(r.ok, true, '真解析器 ok');
  eq(r.report.errors, [], '解析器 errors');
  eq(r.product.skus.length, 4, 'SKU 数');
  return `zip ${buf.length} bytes, parser validated`;
});

await test('P5', 'webp 主图自动转 JPEG 出包', async () => {
  await page.evaluate(() => { document.querySelector('#pasteArea').value = ''; });
  await page.type('#pasteArea', '款名：webp测试款\n分类：短袖\n价格：99\n运费：包邮\n颜色：黑色\n尺码：M\n图案：素色\n库存：10');
  await page.click('#parsePasteBtn');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="style-card"]').length === 2, { timeout: 10000 });
  const inputs = await page.$$('[data-testid="image-input"]');
  await inputs[1].uploadFile(join(SAMPLES, 'photo.webp'));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="thumb"]').length === 7, { timeout: 10000 });
  const packBtns = await page.$$('[data-testid="pack-btn"]');
  await packBtns[1].click();
  // headless 下载路径会丢中文文件名（实测存为 download）：接受任一新文件，款号须取自包内文件夹名
  const before = new Set(readdirSync(DL));
  const zipPath = await waitForNewFile(DL, before);
  const { unzipSync } = await import('fflate');
  const names = Object.keys(unzipSync(new Uint8Array(readFileSync(zipPath)))).sort();
  eq(names, ['webp测试款/信息表.xlsx', 'webp测试款/主图1.jpg'].sort(), 'webp 转后命名');
  const r = await parser.parsePackage(readFileSync(zipPath), zipPath.split('/').pop());
  eq(r.ok, true, '真解析器 ok');
  eq(r.report.code, 'webp测试款', '款号取文件夹名（文件名被改写也不影响）');
  return 'ok';
});

await test('P6', '字段编辑生效（改价后出包价格变）', async () => {
  await page.evaluate(() => {
    const card = document.querySelectorAll('[data-testid="style-card"]')[0];
    const inp = card.querySelector('input[data-key="price"]');
    inp.value = '139';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const packBtns = await page.$$('[data-testid="pack-btn"]');
  await packBtns[0].click();
  const zipPath = await waitFile(DL, 'ZB-DX-001.zip');
  const r = await parser.parsePackage(readFileSync(zipPath), 'ZB-DX-001.zip');
  eq(r.product.price, 13900, '改价后价格(分)');
  return 'ok';
});

await test('P7', '文件导入 CSV 追加两款', async () => {
  await page.click('#tabFile');
  const fi = await page.$('#fileInput');
  await fi.uploadFile(join(SAMPLES, 'supplier.csv'));
  await page.click('#parseFileBtn');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="style-card"]').length === 4, { timeout: 10000 });
  const names = await page.$$eval('[data-testid="style-card"] h3', (els) => els.map((e) => e.textContent));
  eq(names.slice(2), ['简约T恤', '宽松衬衫'], '追加款名');
  return 'ok';
});

await test('P8', '离线重载仍可用', async () => {
  await page.evaluate(async () => {
    if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
  });
  await new Promise((r) => setTimeout(r, 800));
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
  const label = await page.$eval('#versionLabel', (e) => e.textContent);
  eq(label, 'v' + APP_VERSION, '离线版本号');
  await page.setOfflineMode(false);
  return 'offline reload ok';
});

await test('P9', '截图：桌面与移动端', async () => {
  await page.screenshot({ path: join(OUT, 'pwa-desktop.png'), fullPage: true });
  const m = await browser.newPage();
  await m.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await m.goto('http://127.0.0.1:18791/', { waitUntil: 'networkidle0', timeout: 30000 });
  await m.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
  const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) throw new Error(`移动端横向溢出 ${overflow}px`);
  await m.screenshot({ path: join(OUT, 'pwa-mobile.png'), fullPage: true });
  await m.close();
  return 'screenshots saved';
});

await test('P10', 'manifest 与图标可达', async () => {
  const res = await fetch('http://127.0.0.1:18791/manifest.webmanifest');
  eq(res.status, 200, 'manifest 状态');
  const manifest = await res.json();
  for (const icon of manifest.icons) {
    const r2 = await fetch('http://127.0.0.1:18791/' + icon.src);
    eq(r2.status, 200, `图标 ${icon.src}`);
  }
  return `${manifest.icons.length} icons ok`;
});

// ---- P11 更新流程（独立目录，模拟一次发版） ----
await test('P11', '发现新版弹窗提示、确认后更新生效', async () => {
  const updRoot = join(OUT, 'pwa-update');
  rmSync(updRoot, { recursive: true, force: true });
  cpSync(DIST, updRoot, { recursive: true });
  const server2 = await serve(updRoot, 18792);
  const p2 = await browser.newPage();
  await p2.setViewport({ width: 1280, height: 800 });
  await p2.goto('http://127.0.0.1:18792/', { waitUntil: 'networkidle0', timeout: 30000 });
  await p2.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
  await p2.evaluate(async () => { await navigator.serviceWorker.ready; });
  await new Promise((r) => setTimeout(r, 800));
  // 模拟发版：原地改 version.json + sw.js 缓存名 + index.html 版本号
  writeFileSync(join(updRoot, 'version.json'), JSON.stringify({ version: NEXT_VERSION, notes: '测试更新：修复一个小问题。' }));
  const swPath = join(updRoot, 'sw.js');
  writeFileSync(swPath, readFileSync(swPath, 'utf-8').replace(`itg-cache-${APP_VERSION}`, `itg-cache-${NEXT_VERSION}`));
  const idxPath = join(updRoot, 'index.html');
  writeFileSync(idxPath, readFileSync(idxPath, 'utf-8').replace(`content="${APP_VERSION}"`, `content="${NEXT_VERSION}"`));
  // 刷新：页面仍是缓存的旧版，但版本检查应发现新版并弹窗
  await p2.reload({ waitUntil: 'networkidle0', timeout: 30000 });
  await p2.waitForFunction(() => !document.querySelector('#updateBanner').hidden, { timeout: 10000 });
  const banner = await p2.$eval('#updateText', (e) => e.textContent);
  includes(banner, NEXT_VERSION, '横幅版本号');
  includes(banner, '测试更新', '横幅更新说明');
  includes(banner, `当前 v${APP_VERSION}`, '横幅当前版本');
  // 未点更新前，版本仍是旧的
  eq(await p2.$eval('#versionLabel', (e) => e.textContent), 'v' + APP_VERSION, '未确认不更新');
  // 点更新 -> 新 SW 接管 -> 刷新后版本号变新版
  await p2.click('#updateNowBtn');
  await p2.waitForFunction((v) => document.querySelector('#versionLabel')?.textContent === 'v' + v, { timeout: 30000 }, NEXT_VERSION);
  await p2.close();
  server2.close();
  return 'update flow ok';
});

// ---- P12 模板持久化与新建品类（v1.1；v1.2 起模板管理在“设置模板”界面） ----
await test('P12', '七模板内置、切换后刷新不变、新建品类可保存', async () => {
  const p3 = await browser.newPage();
  await p3.setViewport({ width: 1280, height: 800 });
  await p3.goto('http://127.0.0.1:18791/', { waitUntil: 'networkidle0', timeout: 30000 });
  await p3.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
  const optCount = await p3.$eval('#templateSelect', (e) => e.options.length);
  eq(optCount, 7, '内置模板 7 个');
  const optTexts = await p3.$eval('#templateSelect', (e) => [...e.options].map((o) => o.text));
  for (const t of ['食品 v1.0.0', '数码 v1.0.0', '家居 v1.0.0', '母婴 v1.0.0']) {
    if (!optTexts.includes(t)) throw new Error('下拉缺模板：' + t);
  }
  // 切到食品，刷新后仍是食品
  await p3.evaluate(() => {
    const sel = document.querySelector('#templateSelect');
    sel.value = 'food@1.0.0';
    sel.dispatchEvent(new Event('change'));
  });
  await new Promise((r) => setTimeout(r, 300));
  const info = await p3.$eval('#templateInfo', (e) => e.textContent);
  includes(info, '食品', '模板信息');
  includes(info, '暂不能直接导入', '非解析器模板提示');
  await p3.reload({ waitUntil: 'networkidle0', timeout: 30000 });
  await p3.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
  eq(await p3.$eval('#templateSelect', (e) => e.options[e.selectedIndex].text), '食品 v1.0.0', '刷新后当前模板不变');
  // 新建品类（设置模板界面里）
  await p3.click('[data-testid="nav-settings"]');
  await p3.waitForFunction(() => !document.querySelector('#viewSettings').hidden, { timeout: 5000 });
  await p3.type('#newCategoryName', '测试品类');
  await p3.type('#newAxis1', '口味');
  await p3.type('#newAxis2', '规格');
  await p3.click('#createCategoryBtn');
  await p3.waitForFunction(() => [...document.querySelector('#templateSelect').options].some((o) => o.text.includes('测试品类')), { timeout: 5000 });
  await p3.reload({ waitUntil: 'networkidle0', timeout: 30000 });
  await p3.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
  const afterReload = await p3.$eval('#templateSelect', (e) => [...e.options].map((o) => o.text));
  if (!afterReload.some((t) => t.includes('测试品类'))) throw new Error('刷新后新建品类丢失');
  await p3.close();
  return 'persistence ok';
});

// ---- P13 模板编辑器（v1.2）：两个界面切换 + 轴改名 + 保存为副本 + 回生成界面可用 ----
await test('P13', '设置模板界面：轴改名即时校验、保存为副本、回生成可用', async () => {
  const p4 = await browser.newPage();
  await p4.setViewport({ width: 1280, height: 800 });
  p4.on('dialog', (d) => d.accept());
  await p4.goto('http://127.0.0.1:18791/', { waitUntil: 'networkidle0', timeout: 30000 });
  await p4.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
  // 默认在直接生成界面；切到设置模板
  eq(await p4.evaluate(() => window.__itg.view), 'generate', '默认直接生成界面');
  await p4.click('[data-testid="nav-settings"]');
  await p4.waitForFunction(() => window.__itg.view === 'settings', { timeout: 5000 });
  // 先明确选服装模板（前面 P12 的“测试品类”可能还留在本机存储里，当前模板未必是服装）
  await p4.evaluate(() => {
    const sel = document.querySelector('#settingsTemplateSelect');
    sel.value = 'clothing@1.0.0';
    sel.dispatchEvent(new Event('change'));
  });
  await p4.waitForFunction(() => document.querySelector('#editorTitle')?.textContent === '服装 v1.0.0', { timeout: 5000 });
  await p4.waitForFunction(() => document.querySelectorAll('[data-testid="editor-field-row"]').length === 10, { timeout: 10000 });
  const fieldCount = await p4.$$eval('[data-testid="editor-field-row"]', (els) => els.length);
  eq(fieldCount, 10, '服装模板 10 个字段行');
  // 轴改名：颜色 -> 色系
  await p4.evaluate(() => {
    const inp = document.querySelector('[data-testid="editor-axis-row"] [data-testid="editor-axis-name"]');
    inp.value = '色系';
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await p4.waitForFunction(() => window.__itg.editDraft.specHeaders[0] === '色系', { timeout: 5000 });
  const errBox = await p4.$eval('[data-testid="editor-errors"]', (e) => e.textContent);
  includes(errBox, '校验通过', '改名后即时校验通过');
  eq(await p4.evaluate(() => window.__itg.editDraft.images.categories.find((c) => c.key === 'color').label), '色系图', '图片类别同步改名');
  // 保存：内置模板另存为副本
  await p4.click('[data-testid="editor-save-btn"]');
  await p4.waitForFunction(() => window.__itg.templates.some((t) => t.startsWith('clothing-edit-')), { timeout: 5000 });
  const tplKeys = await p4.evaluate(() => window.__itg.templates);
  const copyKey = tplKeys.find((t) => t.startsWith('clothing-edit-'));
  // 设为生成模板并开始生成
  await p4.click('[data-testid="use-template-btn"]');
  await p4.waitForFunction(() => window.__itg.view === 'generate', { timeout: 5000 });
  eq(await p4.evaluate(() => window.__itg.template.id.startsWith('clothing-edit-')), true, '生成模板已切到副本');
  // 用新轴名粘贴解析
  await p4.evaluate(() => {
    document.querySelector('#pasteArea').value = '款名：编辑器测试款\n分类：短袖\n价格：99\n运费方式：包邮\n色系：黑色\n尺码：M\n图案：素色\n库存：10';
  });
  await p4.click('#parsePasteBtn');
  await p4.waitForSelector('[data-testid="style-card"]', { timeout: 10000 });
  const specHead = await p4.$$eval('[data-testid="spec-table"] thead th', (els) => els.map((e) => e.textContent));
  eq(specHead, ['色系', '尺码', '图案', '库存'], '规格预览用新轴名');
  await p4.close();
  return `副本：${copyKey}`;
});

// ---- P14 多表选择（v1.2）：xlsx 两张表，选第二张导入 ----
await test('P14', '导入 xlsx 多表：选第二张才解析出第二张的款', async () => {
  const p5 = await browser.newPage();
  await p5.setViewport({ width: 1280, height: 800 });
  await p5.goto('http://127.0.0.1:18791/', { waitUntil: 'networkidle0', timeout: 30000 });
  await p5.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
  await p5.click('#tabFile');
  const fi = await p5.$('#fileInput');
  await fi.uploadFile(join(SAMPLES, 'multi-sheet.xlsx'));
  await p5.waitForFunction(() => !document.querySelector('#sheetRow').hidden, { timeout: 10000 });
  const sheetOpts = await p5.$$eval('#sheetSelect option', (els) => els.map((e) => e.textContent));
  eq(sheetOpts, ['第 1 张：服装表', '第 2 张：第二张'], '表名下拉');
  await p5.select('#sheetSelect', '1');
  await p5.click('#parseFileBtn');
  await p5.waitForSelector('[data-testid="style-card"]', { timeout: 10000 });
  const name = await p5.$eval('[data-testid="style-card"] h3', (e) => e.textContent);
  eq(name, '宽松衬衫', '第二张的款');
  await p5.close();
  return 'multi-sheet ok';
});

await browser.close();
server.close();

const evidence = {
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  consoleErrors,
  failedReqs,
  results,
};
writeFileSync(join(OUT, 'pwa-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} 通过，证据：test/out/pwa-evidence.json`);
process.exit(failures ? 1 : 0);
