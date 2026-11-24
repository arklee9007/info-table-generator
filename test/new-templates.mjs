// test/new-templates.mjs —— v1.1 新能力验收：新模板、0-3 维规格、扩展字段、JSON/CSV、模板持久化。
// 运行：NODE_PATH=$PWD/node_modules node test/new-templates.mjs
// 新四模板 parserCompatible=false，出包只验本工具往返，不喂商城解析器（解析器只认三轴表头）。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test/out');
mkdirSync(OUT, { recursive: true });

const {
  loadTemplate, validateTemplate, parsePastedText, parseFileInput, parseCsv,
  generatePack, buildRecordsJson, buildRecordsCsv, axisDisplayNames,
  serializeTemplates, deserializeTemplates, validateStyle, buildCombos,
} = await import('../core/index.js');

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
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}：期望 ${b}，实际 ${a}`);
}
function includes(hay, needle, what) {
  if (!String(hay).includes(needle)) throw new Error(`${what}：期望包含「${needle}」，实际「${hay}」`);
}

function webpToJpeg(webpBytes) {
  const out = execFileSync('python3', ['-c',
    'import sys; from PIL import Image; import io; ' +
    'im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB"); ' +
    'im.save(sys.stdout.buffer, "JPEG", quality=92)'],
    { input: Buffer.from(webpBytes), maxBuffer: 64 * 1024 * 1024 });
  return new Uint8Array(out);
}

const NEW_CASES = [
  {
    id: 'food', tplFile: 'templates/food-v1.json', packDir: 'testpacks/food',
    expect: {
      name: '手工牛轧糖', price: 39, freight: '包邮', code: 'FOOD-001',
      axis1: ['原味', '抹茶'], axis2: ['200g', '500g'], axis3: ['袋装', '礼盒装'],
      defaultStock: 200, overrideKey: '原味\u001f200g\u001f袋装', overrideStock: 80,
      extra: { shelfLife: '90天', ingredients: '麦芽糖、花生、奶粉', origin: '广东潮州', prodDate: '2026-11-10' },
      files: ['FOOD-001/信息表.xlsx', 'FOOD-001/主图1.jpg', 'FOOD-001/详情图1.png', 'FOOD-001/详情图2.jpg', 'FOOD-001/口味图-原味.jpg', 'FOOD-001/口味图-抹茶.png', 'FOOD-001/包装图.png'],
    },
    images: [
      ['主图.jpg', 'main', 1, null], ['详情图1.png', 'detail', 2, null], ['详情图2.webp', 'detail', 3, null],
      ['口味图-原味.jpg', 'flavor', 4, '原味'], ['口味图-抹茶.png', 'flavor', 5, '抹茶'], ['包装图.png', 'pack', 6, null],
    ],
  },
  {
    id: 'digital', tplFile: 'templates/digital-v1.json', packDir: 'testpacks/digital',
    expect: {
      name: '磁吸充电宝', price: 129, freight: '包邮', code: 'DIG-001',
      axis1: ['白色', '黑色'], axis2: ['10000mAh', '20000mAh'], axis3: ['标准版', '快充版'],
      defaultStock: 150, overrideKey: null, overrideStock: null,
      extra: { model: 'PB-10000 Pro', brand: '示例品牌', warranty: '一年' },
      files: ['DIG-001/信息表.xlsx', 'DIG-001/主图1.jpg', 'DIG-001/详情图1.png', 'DIG-001/详情图2.jpg', 'DIG-001/颜色图-白色.jpg', 'DIG-001/颜色图-黑色.png', 'DIG-001/细节图.png'],
    },
    images: [
      ['主图.jpg', 'main', 1, null], ['详情图1.png', 'detail', 2, null], ['详情图2.webp', 'detail', 3, null],
      ['颜色图-白色.jpg', 'color', 4, '白色'], ['颜色图-黑色.png', 'color', 5, '黑色'], ['细节图.png', 'size', 6, null],
    ],
  },
  {
    id: 'home', tplFile: 'templates/home-v1.json', packDir: 'testpacks/home',
    expect: {
      name: '棉麻沙发抱枕', price: 59, freight: '套模板', code: 'HOME-001',
      axis1: ['米白', '浅灰'], axis2: ['45×45cm', '60×60cm'], axis3: ['棉麻', '绒布'],
      defaultStock: 120, overrideKey: null, overrideStock: null,
      extra: { scene: '客厅、卧室', install: '无需安装', weight: 0.8 },
      files: ['HOME-001/信息表.xlsx', 'HOME-001/主图1.jpg', 'HOME-001/详情图1.png', 'HOME-001/详情图2.jpg', 'HOME-001/颜色图-米白.jpg', 'HOME-001/颜色图-浅灰.png', 'HOME-001/尺寸图.png'],
    },
    images: [
      ['主图.jpg', 'main', 1, null], ['详情图1.png', 'detail', 2, null], ['详情图2.webp', 'detail', 3, null],
      ['颜色图-米白.jpg', 'color', 4, '米白'], ['颜色图-浅灰.png', 'color', 5, '浅灰'], ['尺寸图.png', 'size', 6, null],
    ],
  },
  {
    id: 'baby', tplFile: 'templates/baby-v1.json', packDir: 'testpacks/baby',
    expect: {
      name: '纯棉婴儿连体衣', price: 79, freight: '包邮', code: 'BABY-001',
      axis1: ['59', '66'], axis2: ['0-3个月', '3-6个月'], axis3: ['短袖', '长袖'],
      defaultStock: 100, overrideKey: null, overrideStock: null,
      extra: { material: '纯棉', cert: 'A类婴幼儿标准', wash: '30度以下水洗' },
      files: ['BABY-001/信息表.xlsx', 'BABY-001/主图1.jpg', 'BABY-001/详情图1.png', 'BABY-001/详情图2.jpg', 'BABY-001/款式图-短袖.jpg', 'BABY-001/款式图-长袖.png', 'BABY-001/尺码图.png'],
    },
    images: [
      ['主图.jpg', 'main', 1, null], ['详情图1.png', 'detail', 2, null], ['详情图2.webp', 'detail', 3, null],
      ['款式图-短袖.jpg', 'style', 4, '短袖'], ['款式图-长袖.png', 'style', 5, '长袖'], ['尺码图.png', 'size', 6, null],
    ],
  },
];

const axisKeys = ['axis1', 'axis2', 'axis3'];
const tplKeys = ['flavors', 'specs', 'packs'];

for (const c of NEW_CASES) {
  const tplJson = JSON.parse(readFileSync(join(ROOT, c.tplFile), 'utf-8'));
  const tpl = loadTemplate(tplJson);
  const e = c.expect;
  const imgDir = join(ROOT, c.packDir, '图片');

  await test(`${c.id}-T1`, `${tpl.name}模板校验通过（parserCompatible=false）`, () => {
    eq(validateTemplate(tplJson), [], '模板校验');
    eq(tpl.parserCompatible, false, 'parserCompatible');
    eq(axisDisplayNames(tpl).length, 3, '轴数');
    return `id=${tpl.id} v${tpl.version}`;
  });

  let fields;
  await test(`${c.id}-T2`, `${tpl.name}示例解析（含扩展字段）`, async () => {
    const text = readFileSync(join(ROOT, c.packDir, '示例输入.txt'), 'utf-8');
    const { records } = await parsePastedText(text, tpl);
    eq(records.length, 1, '款数');
    fields = records[0].fields;
    eq(fields.name, e.name, '款名'); eq(fields.price, e.price, '价格');
    eq(fields.freight, e.freight, '运费'); eq(fields.code, e.code, '款号');
    const axes = tpl.specAxes;
    axes.forEach((ax, i) => eq(fields[ax], e[axisKeys[i]], `轴${i + 1}`));
    eq(fields.stock.default, e.defaultStock, '统一库存');
    if (e.overrideKey) eq(fields.stock.overrides.get(e.overrideKey), e.overrideStock, '库存覆盖');
    for (const [k, v] of Object.entries(e.extra)) eq(fields.extra[k], v, `扩展字段 ${k}`);
    return 'ok';
  });

  let pack;
  await test(`${c.id}-T3`, `${tpl.name}出包 + 表读回（含扩展列）`, async () => {
    const images = c.images.map(([name, category, order, colorKey]) => ({
      bytes: new Uint8Array(readFileSync(join(imgDir, name))), category, order, colorKey, sourceName: name,
    }));
    pack = await generatePack(fields, images, tpl, { convertWebp: async (b) => webpToJpeg(b) });
    eq(pack.zipName, `${e.code}.zip`, '包名即款号');
    eq(pack.files.map((f) => f.name).sort(), [...e.files].sort(), '包内文件名');
    eq(pack.combos, 8, '组合数');
    const back = await parseFileInput({ name: '信息表.xlsx', bytes: pack.xlsxBytes }, tpl);
    eq(back.kind, 'info-table', '识别为信息表');
    const f = back.records[0].fields;
    eq(f.name, e.name, '读回款名'); eq(f.price, e.price, '读回价格');
    eq(f.stock.default, e.defaultStock, '读回默认库存');
    for (const [k, v] of Object.entries(e.extra)) eq(f.extra[k], v, `读回扩展字段 ${k}`);
    writeFileSync(join(OUT, `new-${e.code}.zip`), pack.zipBytes);
    return `zip ${pack.zipBytes.length} bytes`;
  });

  await test(`${c.id}-T4`, `${tpl.name}出包确定性（两次字节一致）`, async () => {
    const images = c.images.map(([name, category, order, colorKey]) => ({
      bytes: new Uint8Array(readFileSync(join(imgDir, name))), category, order, colorKey, sourceName: name,
    }));
    const pack2 = await generatePack(fields, images, tpl, { convertWebp: async (b) => webpToJpeg(b) });
    eq(Buffer.from(pack2.zipBytes).toString('hex'), Buffer.from(pack.zipBytes).toString('hex'), '两次出包字节');
    return 'ok';
  });

  await test(`${c.id}-T5`, `${tpl.name}导出 JSON/CSV（组合展开）`, async () => {
    const { combos, comboStocks } = validateStyle(fields, [], tpl);
    const json = buildRecordsJson(fields, combos, comboStocks, tpl);
    const data = JSON.parse(json);
    eq(data.count, 8, 'JSON 行数');
    eq(data.records[0].stock, e.overrideStock ?? e.defaultStock, 'JSON 首行库存');
    const csv = buildRecordsCsv(fields, combos, comboStocks, tpl);
    const lines = csv.split('\n');
    eq(lines.length, 9, 'CSV 行数（表头+8）');
    includes(lines[0], '库存', 'CSV 表头含库存');
    for (const k of Object.keys(e.extra)) includes(lines[0], tpl.extraFields.find((x) => x.key === k).names[0], `CSV 表头含扩展字段 ${k}`);
    return 'ok';
  });
}

// ---------- 0/1/2 维 ----------
function cloneClothing() {
  return JSON.parse(readFileSync(join(ROOT, 'templates/clothing-v1.json'), 'utf-8'));
}

await test('DIM-0', '0 维模板出包（无规格单品）', async () => {
  const j = cloneClothing();
  j.id = 'nodim'; j.name = '无规格'; j.specAxes = []; j.specHeaders = ['库存'];
  const tpl = loadTemplate(j);
  const { records } = await parsePastedText('款名：单品\n分类：杂货\n价格：10\n运费方式：包邮\n库存：50', tpl);
  eq(records.length, 1, '款数');
  const images = [{ bytes: new Uint8Array(readFileSync(join(ROOT, 'test/samples/main-1080.png'))), category: 'main', order: 1, sourceName: 'main.png' }];
  const pack = await generatePack(records[0].fields, images, tpl, {});
  eq(pack.combos, 1, '组合数 1');
  const back = await parseFileInput({ name: '信息表.xlsx', bytes: pack.xlsxBytes }, tpl);
  eq(back.records[0].fields.stock.default, 50, '读回库存');
  return 'ok';
});

await test('DIM-1', '1 维模板出包（只有颜色）', async () => {
  const j = cloneClothing();
  j.id = 'onedim'; j.name = '一维'; j.specAxes = ['colors']; j.specHeaders = ['颜色', '库存'];
  const tpl = loadTemplate(j);
  const { records } = await parsePastedText('款名：一维款\n分类：短袖\n价格：20\n运费方式：包邮\n颜色：红、蓝\n库存：30，红=10', tpl);
  const v = validateStyle(records[0].fields, [], tpl);
  eq(v.combos.length, 2, '组合数 2');
  eq(v.comboStocks.get('红'), 10, '覆盖库存');
  eq(v.comboStocks.get('蓝'), 30, '默认库存');
  return 'ok';
});

await test('DIM-2', '2 维模板出包（颜色 × 尺码）', async () => {
  const j = cloneClothing();
  j.id = 'twodim'; j.name = '二维'; j.specAxes = ['colors', 'sizes']; j.specHeaders = ['颜色', '尺码', '库存'];
  const tpl = loadTemplate(j);
  const { records } = await parsePastedText('款名：二维款\n分类：短袖\n价格：20\n运费方式：包邮\n颜色：红、蓝\n尺码：M、L\n库存：40', tpl);
  const images = [{ bytes: new Uint8Array(readFileSync(join(ROOT, 'test/samples/main-1080.png'))), category: 'main', order: 1, sourceName: 'main.png' }];
  const pack = await generatePack(records[0].fields, images, tpl, {});
  eq(pack.combos, 4, '组合数 4');
  const back = await parseFileInput({ name: '信息表.xlsx', bytes: pack.xlsxBytes }, tpl);
  eq(back.records[0].fields.colors, ['红', '蓝'], '读回轴1');
  eq(back.records[0].fields.sizes, ['M', 'L'], '读回轴2');
  return 'ok';
});

// ---------- 库存：缺统一数 ----------
await test('STOCK-1', '缺统一数但全覆盖可出包', async () => {
  const tpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/clothing-v1.json'), 'utf-8')));
  const { records } = await parsePastedText('款名：预售款\n分类：短袖\n价格：99\n运费方式：包邮\n颜色：白\n尺码：M\n图案：素色\n库存：白/M/素色=5', tpl);
  const images = [{ bytes: new Uint8Array(readFileSync(join(ROOT, 'test/samples/main-1080.png'))), category: 'main', order: 1, sourceName: 'main.png' }];
  const pack = await generatePack(records[0].fields, images, tpl, {});
  eq(pack.combos, 1, '组合数 1');
  return 'ok';
});

await test('STOCK-2', '缺统一数且覆盖不全要报错点名', async () => {
  const tpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/clothing-v1.json'), 'utf-8')));
  const { records } = await parsePastedText('款名：缺货款\n分类：短袖\n价格：99\n运费方式：包邮\n颜色：白、黑\n尺码：M\n图案：素色\n库存：白/M/素色=5', tpl);
  const v = validateStyle(records[0].fields, [], tpl);
  if (!v.errors.some((e) => e.includes('黑/M/素色'))) throw new Error('期望报错点名缺覆盖的组合，实际：' + v.errors.join('; '));
  return v.errors.join('; ');
});

// ---------- JSON 导入 / CSV 分隔符 / 空白保留 ----------
await test('IO-1', 'JSON 导入（字段词键 + key 键 + 库存对象）', async () => {
  const tpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/food-v1.json'), 'utf-8')));
  const payload = JSON.stringify([
    { 款名: '手工牛轧糖', 分类: '休闲零食', 价格: 39, 运费方式: '包邮', 口味: '原味、抹茶', 规格: '200g', 包装: '袋装', 保质期: '90天', 成分: '麦芽糖', 库存: { default: 200, overrides: { '原味/200g/袋装': 80 } } },
    { name: '第二款', category: '零食', price: 10, freight: '包邮', flavors: ['原味'], specs: ['200g'], packs: ['袋装'], shelfLife: '60天', ingredients: '糖', stock: 5 },
  ]);
  const r = await parseFileInput({ name: 'goods.json', bytes: new TextEncoder().encode(payload) }, tpl);
  eq(r.kind, 'json', 'kind');
  eq(r.records.length, 2, '款数');
  eq(r.records[0].fields.extra.shelfLife, '90天', '扩展字段');
  eq(r.records[0].fields.stock.overrides.get('原味\u001f200g\u001f袋装'), 80, '库存对象覆盖');
  eq(r.records[1].fields.name, '第二款', 'key 键');
  return 'ok';
});

await test('IO-2', 'CSV 分号分隔导入 + 表头归一化（带空格表头）', async () => {
  const tpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/clothing-v1.json'), 'utf-8')));
  const rows = parseCsv('款 名;价 格;颜色\n短袖 A;129;本白');
  eq(rows[0], ['款 名', '价 格', '颜色'], '分号切分');
  const { text } = { text: '款名;价格;颜色\n短袖 A;129;本白' };
  const r = await parseFileInput({ name: 's.csv', bytes: new TextEncoder().encode(text) }, tpl);
  eq(r.records[0].fields.name, '短袖 A', '表头归一后认出款名');
  eq(r.records[0].fields.price, 129, '价格');
  return 'ok';
});

await test('IO-3', '标量带空格不被吃掉（型号 PB-10000 Pro）', async () => {
  const tpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/digital-v1.json'), 'utf-8')));
  const { records } = await parsePastedText('款名：磁吸充电宝\n分类：手机配件\n价格：129\n运费方式：包邮\n颜色：白色\n内存：10000mAh\n版本：标准版\n型号：PB-10000 Pro\n库存：10', tpl);
  eq(records[0].fields.extra.model, 'PB-10000 Pro', '型号空格保留');
  return 'ok';
});

await test('IO-4', '非法扩展字段值报错：日期/枚举/数字', async () => {
  const food = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/food-v1.json'), 'utf-8')));
  const home = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/home-v1.json'), 'utf-8')));
  const badDate = '款名：X\n分类：零食\n价格：10\n运费方式：包邮\n口味：原味\n规格：200g\n包装：袋装\n保质期：90天\n成分：糖\n生产日期：2026-13-40\n库存：10';
  let threw = false;
  try { await parsePastedText(badDate, food); } catch (e) { threw = true; includes(e.message, '日期', '日期报错'); }
  if (!threw) throw new Error('非法日期应报错');
  const badEnum = '款名：X\n分类：抱枕\n价格：10\n运费方式：包邮\n颜色：白\n尺寸：45cm\n材质：棉\n安装服务：上门安装\n库存：10';
  threw = false;
  try { await parsePastedText(badEnum, home); } catch (e) { threw = true; includes(e.message, '只认', '枚举报错'); }
  if (!threw) throw new Error('非法枚举应报错');
  const badNum = '款名：X\n分类：抱枕\n价格：10\n运费方式：包邮\n颜色：白\n尺寸：45cm\n材质：棉\n重量：很重\n库存：10';
  threw = false;
  try { await parsePastedText(badNum, home); } catch (e) { threw = true; includes(e.message, '数字无法识别', '数字报错'); }
  if (!threw) throw new Error('非法数字应报错');
  return 'ok';
});

await test('IO-5', '描述里含字段词加冒号要出警告', async () => {
  const tpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/clothing-v1.json'), 'utf-8')));
  const { records, warnings } = await parsePastedText('款名：X\n分类：短袖\n价格：10\n运费方式：包邮\n描述：颜色：很正的红，显白。\n颜色：红\n尺码：M\n图案：素色\n库存：10', tpl);
  eq(records.length, 1, '款数');
  if (!warnings.some((w) => w.includes('误切'))) throw new Error('期望描述误切警告，实际：' + warnings.join('; '));
  return warnings.join('; ');
});

await test('IO-6', '错误带款序与行号', async () => {
  const tpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/clothing-v1.json'), 'utf-8')));
  const text = '款名：第一款\n分类：短袖\n价格：10\n运费方式：包邮\n颜色：白\n尺码：M\n图案：素色\n库存：10\n款名：第二款\n分类：短袖\n价格：不是数字\n运费方式：包邮\n颜色：白\n尺码：M\n图案：素色\n库存：10';
  let threw = false;
  try { await parsePastedText(text, tpl); } catch (e) { threw = true; includes(e.message, '第 2 款', '款序'); includes(e.message, '行', '行号'); }
  if (!threw) throw new Error('非法价格应报错');
  return 'ok';
});

// ---------- 模板持久化 ----------
await test('STORE-1', '模板序列化往返 + 非法模板进隔离区', async () => {
  const tpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/food-v1.json'), 'utf-8')));
  const map = new Map([['food@1.0.0', tpl]]);
  const json = serializeTemplates(map);
  const back = deserializeTemplates(json, loadTemplate);
  eq(back.templates.size, 1, ' round-trip 数量');
  eq(back.quarantined.length, 0, '隔离区空');
  const bad = deserializeTemplates(JSON.stringify({ 'bad@1.0.0': { id: 'bad' } }), loadTemplate);
  eq(bad.templates.size, 0, '非法模板不进正表');
  eq(bad.quarantined.length, 1, '非法模板进隔离区');
  return 'ok';
});

const evidence = {
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
writeFileSync(join(OUT, 'new-templates-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} 通过，证据：test/out/new-templates-evidence.json`);
process.exit(failures ? 1 : 0);
