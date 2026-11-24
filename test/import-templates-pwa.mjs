// test/import-templates-pwa.mjs —— 导入路径实测：真浏览器跑未改动的 dist-pwa。
// 运行：NODE_PATH=$PWD/node_modules node test/import-templates-pwa.mjs
// 每模板：导入模板文件 -> 模板切换生效 -> 粘贴示例输入 -> 上传配图归类 -> 出包下载 -> 真解析器验收。
// dist-pwa 不动；只读 templates/*.json 与 testpacks/*。

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-pwa');
const OUT = join(ROOT, 'test/out');
const DL = join(OUT, 'import-downloads');
const STAGE = join(OUT, 'import-stage');
mkdirSync(DL, { recursive: true });
for (const f of readdirSync(DL)) rmSync(join(DL, f));
rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
// 注意：无头 Chrome 的 CDP 文件上传对中文路径静默失败（实测），故上传前把图片拷为 ASCII 临时名；
// 工具只读文件字节、源文件名仅作显示，包内命名走模板规则，不受影响。

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
async function waitForNewFile(dir, before, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const fresh = readdirSync(dir).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
    if (fresh.length) return join(dir, fresh[0]);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('下载超时：无新文件出现在 ' + dir);
}

const CASES = [
  {
    id: 'clothing', tplFile: 'templates/clothing-v1.json', packDir: 'testpacks/clothing',
    tplLabel: '服装 v1.0.0', code: 'HOODIE-001', colors: ['藏青', '米白'],
    colorFiles: [['颜色图-藏青.png', '藏青'], ['颜色图-米白.jpg', '米白']],
    files: ['HOODIE-001/信息表.xlsx', 'HOODIE-001/主图1.jpg', 'HOODIE-001/详情图1.png', 'HOODIE-001/详情图2.jpg', 'HOODIE-001/颜色图-藏青.png', 'HOODIE-001/颜色图-米白.jpg', 'HOODIE-001/尺码图.png'],
  },
  {
    id: 'shoes', tplFile: 'templates/shoes-v1.json', packDir: 'testpacks/shoes',
    tplLabel: '鞋类 v1.0.0', code: 'SHOES-001', colors: ['黑色', '白色'],
    colorFiles: [['颜色图-黑色.png', '黑色'], ['颜色图-白色.jpg', '白色']],
    files: ['SHOES-001/信息表.xlsx', 'SHOES-001/主图1.jpg', 'SHOES-001/详情图1.png', 'SHOES-001/详情图2.jpg', 'SHOES-001/颜色图-黑色.png', 'SHOES-001/颜色图-白色.jpg', 'SHOES-001/尺码图.png'],
  },
  {
    id: 'cosmetics', tplFile: 'templates/cosmetics-v1.json', packDir: 'testpacks/cosmetics',
    tplLabel: '美妆 v1.0.0', code: 'LIP-001', colors: ['正红', '豆沙'],
    colorFiles: [['颜色图-正红.png', '正红'], ['颜色图-豆沙.jpg', '豆沙']],
    files: ['LIP-001/信息表.xlsx', 'LIP-001/主图1.jpg', 'LIP-001/详情图1.png', 'LIP-001/详情图2.jpg', 'LIP-001/颜色图-正红.png', 'LIP-001/颜色图-豆沙.jpg', 'LIP-001/尺码图.png'],
  },
];

const server = await serve(DIST, 18793);
const CHROME_PATH = process.env.ITG_CHROME || '/home/hatch/workspace/.chrome-test/chrome/linux-157.0.8103.78/chrome-linux64/chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

async function setSelectByThumbName(page, sourceName, selectTestId, value) {
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

for (const c of CASES) {
  await test(`${c.id}-P1`, `${c.tplLabel}：导入模板文件后切换生效`, async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    // 导入同名内置模板会弹原生 confirm（覆盖确认）：无头 Chrome 下无人点击会堵死页面 JS，
    // 测试里一律自动确认；这正是应用预期的覆盖确认流程，不是绕过。
    page.on('dialog', (d) => d.accept());
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('http://127.0.0.1:18793/', { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction(() => document.querySelector('#templateSelect')?.options.length > 0, { timeout: 10000 });
    // 模板导入在“设置模板”界面：先切过去再上传
    await page.click('[data-testid="nav-settings"]');
    await page.waitForFunction(() => window.__itg.view === 'settings', { timeout: 5000 });
    const fi = await page.$('#templateFileInput');
    await fi.uploadFile(join(ROOT, c.tplFile));
    await page.waitForFunction((label) => {
      const sel = document.querySelector('#templateSelect');
      return sel.options[sel.selectedIndex].text === label;
    }, { timeout: 10000 }, c.tplLabel);
    const notice = await page.$eval('#parseNotice', (e) => e.textContent);
    includes(notice, `已导入模板：${c.tplLabel}`, '导入提示');
    const info = await page.$eval('#templateInfo', (e) => e.textContent);
    includes(info, c.tplLabel, '模板信息行');
    if (errs.length) throw new Error('页面错误：' + errs.join(' | '));
    // 回直接生成界面，后面粘贴解析与出包都在生成界面做
    await page.click('[data-testid="nav-generate"]');
    await page.waitForFunction(() => window.__itg.view === 'generate', { timeout: 5000 });
    c._page = page;
    return 'ok';
  });

  await test(`${c.id}-P2`, `${c.tplLabel}：粘贴示例输入解析出 8 个规格组合`, async () => {
    const page = c._page;
    const text = readFileSync(join(ROOT, c.packDir, '示例输入.txt'), 'utf-8');
    await page.evaluate((t) => { document.querySelector('#pasteArea').value = t; }, text);
    await page.click('#parsePasteBtn');
    await page.waitForSelector('[data-testid="style-card"]', { timeout: 10000 });
    const rows = await page.$$eval('[data-testid="spec-table"] tbody tr', (trs) =>
      trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)));
    eq(rows.length, 8, '规格行数');
    return rows.map((r) => r.join('/')).join('; ');
  });

  await test(`${c.id}-P3`, `${c.tplLabel}：上传配图归类，错误清零，出包过真解析器`, async () => {
    const page = c._page;
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, eventsEnabled: true });
    const imgDir = join(ROOT, c.packDir, '图片');
    // 中文文件名先拷为 ASCII 临时名再上传（CDP 限制，见文件头注释）
    const stage = (name, ascii) => {
      const dst = join(STAGE, `${c.id}-${ascii}`);
      copyFileSync(join(imgDir, name), dst);
      return { path: dst, shown: `${c.id}-${ascii}` };
    };
    const staged = [
      stage('主图.jpg', 'main.jpg'),
      stage('详情图1.png', 'detail1.png'),
      stage('详情图2.webp', 'detail2.webp'),
      ...c.colorFiles.map(([f], i) => stage(f, `color${i + 1}${extname(f)}`)),
      stage('尺码图.png', 'size.png'),
    ];
    const input = await page.$('[data-testid="image-input"]');
    await input.uploadFile(...staged.map((s) => s.path));
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="thumb"]').length === 6, { timeout: 10000 });
    for (let i = 0; i < c.colorFiles.length; i++) {
      const [, color] = c.colorFiles[i];
      await setSelectByThumbName(page, staged[3 + i].shown, 'category-select', 'color');
      await setSelectByThumbName(page, staged[3 + i].shown, 'color-select', color);
    }
    await setSelectByThumbName(page, staged[5].shown, 'category-select', 'size');
    const state = await page.evaluate(() => {
      const s = window.__itg.styles[0];
      return { errors: s.errors, tpl: window.__itg.template.id };
    });
    eq(state.errors, [], '错误清零');
    eq(state.tpl, c.id, '当前模板');
    const before = new Set(readdirSync(DL));
    await page.click('[data-testid="pack-btn"]');
    const zipPath = await waitForNewFile(DL, before);
    const buf = readFileSync(zipPath);
    const { unzipSync } = await import('fflate');
    const names = Object.keys(unzipSync(new Uint8Array(buf))).sort();
    eq(names, [...c.files].sort(), '包内文件名');
    const r = await parser.parsePackage(buf, zipPath.split('/').pop());
    eq(r.ok, true, '真解析器 ok');
    eq(r.report.errors, [], '解析器 errors');
    eq(r.report.warnings, [], '解析器 warnings');
    eq(r.product.skus.length, 8, 'SKU 数');
    eq(r.report.code, c.code, '款号取文件夹名');
    const packMsg = await page.evaluate(() => window.__itg.styles[0].packMsg?.text || '');
    includes(packMsg, '8 个规格组合', '出包成功提示');
    await page.close();
    return `zip ${buf.length} bytes, parser validated`;
  });
}

await browser.close();
server.close();

const evidence = {
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
writeFileSync(join(OUT, 'import-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} 通过，证据：test/out/import-evidence.json`);
process.exit(failures ? 1 : 0);
