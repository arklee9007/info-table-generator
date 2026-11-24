// test/run.mjs —— 阶段 1 验收：真实样本 + 真解析器。
// 运行：NODE_PATH=$PWD/node_modules node test/run.mjs
// （NODE_PATH 让商城解析器的 require 找到 fflate/xlsx/pngjs/jpeg-js；解析器文件本身直接取生产路径，不复制。）
// 退出码：0 全部通过；1 任一失败。证据写 test/out/evidence.json，生成的包留 test/out/。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = join(ROOT, 'test/samples');
const OUT = join(ROOT, 'test/out');
mkdirSync(OUT, { recursive: true });

const {
  loadTemplate, validateTemplate, parseFieldText, parseFileInput, parsePastedText,
  probeImage, generatePack, generatePacks, decodeText, FieldError,
} = await import('../core/index.js');

// ---- 真解析器（生产路径，双份比对哈希） ----
const PARSER_A = '/home/hatch/workspace/miniprogram-mall/work-042/modules/material-import/parser.cjs';
const PARSER_B = '/home/hatch/workspace/miniprogram-mall/work-042/cloudfunctions/admin/modules/material-import/parser.cjs';
const hashA = createHash('sha256').update(readFileSync(PARSER_A)).digest('hex');
const hashB = createHash('sha256').update(readFileSync(PARSER_B)).digest('hex');
const requireCjs = createRequire(import.meta.url);
const parser = requireCjs(PARSER_A);

const results = [];
let failures = 0;
function test(id, name, fn) {
  return Promise.resolve()
    .then(fn)
    .then((detail) => { results.push({ id, name, ok: true, detail: detail ?? '' }); console.log(`PASS ${id} ${name}`); })
    .catch((e) => {
      failures++;
      results.push({ id, name, ok: false, detail: String(e?.message || e) });
      console.log(`FAIL ${id} ${name}\n     ${String(e?.message || e).split('\n').join('\n     ')}`);
    });
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}：期望 ${b}，实际 ${a}`);
}
function includes(hay, needle, what) {
  if (!String(hay).includes(needle)) throw new Error(`${what}：期望包含「${needle}」，实际「${hay}」`);
}
async function throwsWith(fn, needle, what) {
  try { await fn(); } catch (e) { includes(e.message, needle, what); return e.message; }
  throw new Error(`${what}：期望抛错（含「${needle}」），实际未抛错`);
}

const tplJson = JSON.parse(readFileSync(join(ROOT, 'templates/clothing-v1.json'), 'utf-8'));
const tpl = loadTemplate(tplJson);

function img(name, category, order, colorKey) {
  return { bytes: new Uint8Array(readFileSync(join(SAMPLES, name))), category, order, colorKey, sourceName: name };
}
function fileInput(name) {
  return { name, bytes: new Uint8Array(readFileSync(join(SAMPLES, name))) };
}
async function parseWithRealParser(pack) {
  return parser.parsePackage(Buffer.from(pack.zipBytes), pack.zipName);
}

// ================= A. 模板 =================
await test('A1', '服装模板加载有效', () => {
  eq(validateTemplate(tplJson), [], '模板校验');
  eq(tpl.fields.length, 10, '字段数');
  if (!tpl._wordIndex || tpl._wordIndex.length < 10) throw new Error('字段词索引未建');
  return `id=${tpl.id} v${tpl.version}`;
});
await test('A2', '缺字段的模板被拒绝', () => {
  const bad = { ...tplJson }; delete bad.fields;
  if (validateTemplate(bad).length === 0) throw new Error('应报错');
  return validateTemplate(bad).join(';');
});
await test('A3', '字段词跨字段重复被拒绝', () => {
  const bad = JSON.parse(JSON.stringify(tplJson));
  bad.fields[1].names.push('款名'); // 分类字段也认「款名」
  includes(validateTemplate(bad).join(';'), '款名', '重复字段词');
  return 'ok';
});
await test('A4', '两版本模板可并存', () => {
  const v2 = JSON.parse(JSON.stringify(tplJson));
  v2.version = '1.0.1';
  const t2 = loadTemplate(v2);
  const registry = new Map([[`${tpl.id}@${tpl.version}`, tpl], [`${t2.id}@${t2.version}`, t2]]);
  eq(registry.size, 2, '注册表大小');
  return [...registry.keys()].join(', ');
});
await test('A0', '真解析器双份一致', () => {
  eq(hashA, hashB, '解析器双份哈希');
  return `sha256 ${hashA.slice(0, 16)}…`;
});

// ================= B. 字段块 =================
await test('B1', '字段块单款全字段 + 库存覆盖', async () => {
  const { records } = await parseFileInput(fileInput('fieldblock-1.txt'), tpl);
  eq(records.length, 1, '款数');
  const f = records[0].fields;
  eq(f.name, '重磅素色短袖', '款名'); eq(f.price, 129, '价格'); eq(f.freight, '套模板', '运费');
  eq(f.colors, ['本白', '克莱因蓝'], '颜色'); eq(f.sizes, ['M', 'L'], '尺码'); eq(f.patterns, ['素色'], '图案');
  eq(f.code, 'ZB-DX-001', '款号'); eq(f.stock.default, 100, '统一库存');
  eq(f.stock.overrides.get('本白\u001fM\u001f素色'), 50, '库存覆盖');
  return 'ok';
});
await test('B2', 'GBK 编码 + 两款 + 别名 + 行内逗号 + 免邮', async () => {
  const { records } = await parseFileInput(fileInput('fieldblock-2.txt'), tpl);
  eq(records.length, 2, '款数');
  const [a, b] = records.map((r) => r.fields);
  eq(a.name, '做旧宽松长袖', '第一款名'); eq(a.price, 159, '￥剥离'); eq(a.freight, '包邮', '免邮别名');
  eq(a.colors, ['做旧黑', '米白'], '斜杠分隔'); eq(a.sizes, ['M', 'L', 'XL'], '空格分隔');
  eq(a.code, '做旧宽松长袖', '款号取款名');
  eq(b.name, '简约纯色卫衣', '第二款名'); eq(b.price, 199, '无冒号行首'); eq(b.freight, '套模板', '第二款运费');
  eq(b.desc, '加绒款，秋冬穿。', '描述');
  return 'ok';
});
await test('B3', 'Markdown 去标记解析', async () => {
  const { records } = await parseFileInput(fileInput('fieldblock-3.md'), tpl);
  eq(records.length, 1, '款数');
  eq(records[0].fields.price, 139.5, '价格'); eq(records[0].fields.colors, ['藏青', '白色'], '颜色');
  return 'ok';
});
await test('B4', 'UTF-16LE BOM 解析', async () => {
  const { records } = await parseFileInput(fileInput('fieldblock-4.txt'), tpl);
  eq(records[0].fields.name, 'UTF16测试款', '款名');
  return 'ok';
});
await test('B5', '无字段词的散文报错', async () => {
  await throwsWith(() => parsePastedText('今天天气不错，适合上新。', tpl), '没有认出任何字段词', '散文');
  return 'ok';
});
await test('B6', '描述里的字段词（无冒号）不切分', async () => {
  const { records } = await parsePastedText(
    '款名：测试款\n价格：99\n运费：包邮\n分类：短袖\n描述：这款颜色很正，价格实惠，值得一试。\n颜色：黑色\n尺码：M\n图案：素色\n库存：10', tpl);
  eq(records.length, 1, '款数');
  eq(records[0].fields.desc, '这款颜色很正，价格实惠，值得一试。', '描述完整');
  return 'ok';
});
await test('B7', '库存覆盖语法错误给指引', async () => {
  await throwsWith(() => parsePastedText('款名：X\n价格：1\n运费：包邮\n分类：短袖\n颜色：黑\n尺码：M\n图案：素色\n库存：黑/M=5', tpl), '须写满 3 个规格', '库存覆盖');
  return 'ok';
});
await test('B8', '运费无法识别列出可接受写法', async () => {
  await throwsWith(() => parsePastedText('款名：X\n价格：1\n运费：到付\n分类：短袖\n颜色：黑\n尺码：M\n图案：素色\n库存：1', tpl), '只认', '运费');
  return 'ok';
});
await test('B9', '千分位价格与非法价格', async () => {
  const { records } = await parsePastedText('款名：X\n价格：1,299\n运费：包邮\n分类：短袖\n颜色：黑\n尺码：M\n图案：素色\n库存：1', tpl);
  eq(records[0].fields.price, 1299, '千分位');
  await throwsWith(() => parsePastedText('款名：X\n价格：贵\n运费：包邮\n分类：短袖\n颜色：黑\n尺码：M\n图案：素色\n库存：1', tpl), '价格无法识别', '非法价格');
  return 'ok';
});

// ================= C. 表格/文档 =================
await test('C1', 'CSV 表头行 + 两款', async () => {
  const { records } = await parseFileInput(fileInput('supplier.csv'), tpl);
  eq(records.length, 2, '款数');
  eq(records[0].fields.name, '简约T恤', '第一款'); eq(records[0].fields.price, 89, '价格');
  eq(records[1].fields.sizes, ['M', 'L', 'XL'], '尺码');
  return 'ok';
});
await test('C2', 'XLSX 供应商表', async () => {
  const { records } = await parseFileInput(fileInput('supplier.xlsx'), tpl);
  eq(records.length, 2, '款数');
  eq(records[0].fields.name, '条纹针织衫', '第一款'); eq(records[0].fields.price, 219, '价格');
  return 'ok';
});
await test('C3', '商城样表（信息表格式）直接解析', async () => {
  const { records, kind } = await parseFileInput(fileInput('info-table.xlsx'), tpl);
  eq(kind, 'info-table', '识别为信息表');
  const f = records[0].fields;
  eq(f.name, '测试款-基础短袖T恤', '款名'); eq(f.price, 99, '价格'); eq(f.freight, '套模板', '运费');
  eq(f.colors, ['本白', '黑色'], '颜色'); eq(f.stock.default, 5, '默认库存');
  eq(f.stock.overrides.get('黑色\u001fM\u001f素色'), 3, '覆盖库存');
  return 'ok';
});
await test('C4', 'DOCX 段落文本解析', async () => {
  const { records } = await parseFileInput(fileInput('supplier.docx'), tpl);
  eq(records[0].fields.name, '灯芯绒衬衫', '款名'); eq(records[0].fields.colors, ['驼色', '墨绿'], '颜色');
  return 'ok';
});
await test('C5', '表头无法识别报错并指引', async () => {
  await throwsWith(() => parseFileInput({ name: 'x.csv', bytes: new TextEncoder().encode('A,B,C\n1,2,3\n') }, tpl), '首行没有认出字段词', 'CSV表头');
  return 'ok';
});
await test('C6', '不支持的文件类型报错', async () => {
  await throwsWith(() => parseFileInput({ name: 'x.pdf', bytes: new Uint8Array([1, 2, 3]) }, tpl), '不支持的文件类型', 'PDF');
  return 'ok';
});

// ================= D. 图片探查 =================
await test('D1', 'PNG/JPEG/WebP 尺寸读取与超限图', () => {
  const p = probeImage(new Uint8Array(readFileSync(join(SAMPLES, 'main-1080.png'))));
  eq([p.format, p.width, p.height], ['png', 1080, 1080], 'PNG');
  const j = probeImage(new Uint8Array(readFileSync(join(SAMPLES, 'detail-2.jpg'))));
  eq([j.format, j.width, j.height], ['jpeg', 1080, 800], 'JPEG');
  const w = probeImage(new Uint8Array(readFileSync(join(SAMPLES, 'photo.webp'))));
  eq([w.format, w.width, w.height], ['webp', 900, 900], 'WebP');
  const o = probeImage(new Uint8Array(readFileSync(join(SAMPLES, 'oversize.png'))));
  eq([o.format, o.width, o.height], ['png', 3000, 2000], '超限图尺寸');
  const t = probeImage(new TextEncoder().encode('hello'));
  eq(t.format, null, '非图片');
  return 'ok';
});
await test('D2', '格式按魔数不认扩展名', () => {
  const bytes = new Uint8Array(readFileSync(join(SAMPLES, 'main-1080.png')));
  eq(probeImage(bytes).format, 'png', 'PNG 字节');
  return 'ok';
});

// ================= E. 校验负向 =================
const baseFields = (await parsePastedText(
  '款名：校验款\n价格：129\n运费：包邮\n分类：短袖\n颜色：本白、克莱因蓝\n尺码：M、L\n图案：素色\n库存：100', tpl)).records[0].fields;
const fullImages = [
  img('main-1080.png', 'main', 1),
  img('detail-1.png', 'detail', 2),
  img('detail-2.jpg', 'detail', 3),
  img('color-white.png', 'color', 4, '本白'),
  img('color-blue.jpg', 'color', 5, '克莱因蓝'),
  img('size-chart.png', 'size', 6),
];

await test('E1', '缺主图被拦', async () => {
  await throwsWith(() => generatePack(baseFields, fullImages.slice(1), tpl), '缺主图', '缺主图');
  return 'ok';
});
await test('E2', '颜色图对应不存在的颜色被拦', async () => {
  const bad = [...fullImages, img('color-white.png', 'color', 7, '粉色')];
  await throwsWith(() => generatePack(baseFields, bad, tpl), '颜色列表里没有', '颜色图');
  return 'ok';
});
await test('E3', '同色两张颜色图被拦', async () => {
  const bad = [...fullImages, img('color-white.png', 'color', 7, '本白')];
  await throwsWith(() => generatePack(baseFields, bad, tpl), '只能一张', '重复颜色图');
  return 'ok';
});
await test('E4', '超 400 万像素被拦', async () => {
  const bad = [img('oversize.png', 'main', 1)];
  await throwsWith(() => generatePack(baseFields, bad, tpl), '400 万像素', '超限像素');
  return 'ok';
});
await test('E5', '超 400 组合被拦', async () => {
  const many = JSON.parse(JSON.stringify(baseFields));
  many.stock = { default: 100, overrides: new Map() };
  many.colors = Array.from({ length: 21 }, (_, i) => `色${i}`);
  many.sizes = Array.from({ length: 21 }, (_, i) => `码${i}`);
  many.patterns = ['素色'];
  await throwsWith(() => generatePack(many, fullImages.slice(0, 1), tpl), '超出上限 400', '组合超限');
  return 'ok';
});
await test('E6', '库存覆盖指向不存在的组合被拦', async () => {
  const bad = JSON.parse(JSON.stringify(baseFields));
  bad.stock = { default: 100, overrides: new Map([['粉色\u001fM\u001f素色', 5]]) };
  await throwsWith(() => generatePack(bad, fullImages.slice(0, 1), tpl), '不存在的组合', '库存覆盖');
  return 'ok';
});
await test('E7', '缺价格被拦', async () => {
  const bad = { ...baseFields }; delete bad.price;
  await throwsWith(() => generatePack(bad, fullImages.slice(0, 1), tpl), '缺「价格」', '缺价格');
  return 'ok';
});
await test('E8', '超 12 张图被拦', async () => {
  const many = Array.from({ length: 13 }, (_, i) => img('detail-1.png', 'detail', i + 1));
  many[0] = img('main-1080.png', 'main', 1);
  await throwsWith(() => generatePack(baseFields, many, tpl), '超出上限 12 张', '图片超限');
  return 'ok';
});
await test('E9', 'webp 无转换器被拦；有转换器可出包', async () => {
  const webpOnly = [img('photo.webp', 'main', 1)];
  await throwsWith(() => generatePack(baseFields, webpOnly, tpl), 'webp', 'webp无转换器');
  const fakeConvert = async () => new Uint8Array(readFileSync(join(SAMPLES, 'detail-2.jpg')));
  const pack = await generatePack(baseFields, webpOnly, tpl, { convertWebp: fakeConvert });
  eq(pack.files.map((f) => f.name).sort(), ['校验款/主图1.jpg', '校验款/信息表.xlsx'].sort(), '转换后命名');
  return 'ok';
});

// ================= F. 出包 + 真解析器 =================
await test('F1', '全套图片出包，真解析器验收通过', async () => {
  const { records } = await parseFileInput(fileInput('fieldblock-1.txt'), tpl);
  const pack = await generatePack(records[0].fields, fullImages, tpl);
  eq(pack.zipName, 'ZB-DX-001.zip', '包名即款号');
  eq(pack.files.map((f) => f.name).sort(), ['ZB-DX-001/信息表.xlsx', 'ZB-DX-001/主图1.png', 'ZB-DX-001/详情图1.png', 'ZB-DX-001/详情图2.jpg', 'ZB-DX-001/颜色图-克莱因蓝.jpg', 'ZB-DX-001/颜色图-本白.png', 'ZB-DX-001/尺码图.png'].sort(), '包内文件名');
  if (pack.zipBytes.length > 2 * 1024 * 1024) throw new Error('包超 2MB');
  writeFileSync(join(OUT, pack.zipName), pack.zipBytes);
  const r = await parseWithRealParser(pack);
  eq(r.ok, true, '解析器 ok');
  eq(r.report.errors, [], '解析器 errors');
  eq(r.report.warnings, [], '解析器 warnings');
  eq(r.product.name, '重磅素色短袖', '商品名');
  eq(r.product.price, 12900, '价格(分)');
  eq(r.product.freightMode, 'template', '运费模式');
  eq(r.product.colors, ['本白', '克莱因蓝'], '颜色');
  eq(r.product.sizes, ['M', 'L'], '尺码');
  eq(r.product.skus.length, 4, 'SKU 数');
  const skuMap = new Map(r.product.skus.map((s) => [`${s.color}/${s.size}/${s.pattern}`, s.stock]));
  eq(skuMap.get('本白/M/素色'), 50, '覆盖库存');
  eq(skuMap.get('本白/L/素色'), 100, '默认库存');
  eq(skuMap.get('克莱因蓝/M/素色'), 100, '默认库存2');
  eq(r.assets.length, 6, 'assets 数');
  eq(r.report.code, 'ZB-DX-001', '款号取文件夹名');
  return `zip ${pack.zipBytes.length} bytes, parser validated`;
});
await test('F2', '仅主图出包，真解析器通过并带警告', async () => {
  const { records } = await parseFileInput(fileInput('fieldblock-2.txt'), tpl);
  const pack = await generatePack(records[0].fields, [img('main-1080.png', 'main', 1)], tpl);
  writeFileSync(join(OUT, pack.zipName), pack.zipBytes);
  const r = await parseWithRealParser(pack);
  eq(r.ok, true, '解析器 ok');
  if (r.report.warnings.length === 0) throw new Error('期望解析器给出缺图警告');
  eq(r.product.freightMode, 'free', '免邮->free');
  return `warnings: ${r.report.warnings.join('; ')}`;
});
await test('F3', '批量出包：一款失败不影响另一款', async () => {
  const good = (await parseFileInput(fileInput('fieldblock-1.txt'), tpl)).records[0].fields;
  const bad = { ...good }; delete bad.price;
  const res = await generatePacks(
    [{ fields: good, images: fullImages }, { fields: bad, images: fullImages }], tpl);
  eq(res[0].ok, true, '第一款成功');
  eq(res[1].ok, false, '第二款失败');
  includes(res[1].error, '缺「价格」', '失败原因');
  return 'ok';
});
await test('F4', '出包的表可被本工具再读回（往返一致）', async () => {
  const { records } = await parseFileInput(fileInput('fieldblock-1.txt'), tpl);
  const pack = await generatePack(records[0].fields, fullImages, tpl);
  const back = await parseFileInput({ name: '信息表.xlsx', bytes: pack.xlsxBytes }, tpl);
  eq(back.kind, 'info-table', '识别为信息表');
  const f = back.records[0].fields;
  eq(f.name, '重磅素色短袖', '款名'); eq(f.price, 129, '价格');
  eq(f.stock.default, 100, '默认库存'); eq(f.stock.overrides.get('本白\u001fM\u001f素色'), 50, '覆盖库存');
  return 'ok';
});
await test('F5', '出包确定性（同输入两次字节一致）', async () => {
  const { records } = await parseFileInput(fileInput('fieldblock-1.txt'), tpl);
  const a = await generatePack(records[0].fields, fullImages, tpl);
  const b = await generatePack(records[0].fields, fullImages, tpl);
  const same = Buffer.from(a.zipBytes).equals(Buffer.from(b.zipBytes));
  return same ? 'deterministic' : 'non-deterministic（不影响使用，仅记录）';
});

// ================= G. 编码 =================
await test('G1', 'UTF-8 BOM / GBK / UTF-16LE 解码', () => {
  const utf8bom = decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('款名：A')]));
  eq(utf8bom.text, '款名：A', 'UTF-8 BOM');
  const gbkBytes = new Uint8Array(readFileSync(join(SAMPLES, 'fieldblock-2.txt')));
  const gbk = decodeText(gbkBytes);
  eq(gbk.encoding, 'GBK', 'GBK 识别');
  includes(gbk.text, '做旧宽松长袖', 'GBK 内容');
  const u16 = decodeText(new Uint8Array(readFileSync(join(SAMPLES, 'fieldblock-4.txt'))));
  eq(u16.encoding, 'UTF-16LE', 'UTF-16 识别');
  includes(u16.text, 'UTF16测试款', 'UTF-16 内容');
  return 'ok';
});

// ---- 证据 ----
const evidence = {
  ranAt: new Date().toISOString(),
  parserSha256: hashA,
  parserPaths: [PARSER_A, PARSER_B],
  template: `${tpl.id}@${tpl.version}`,
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
writeFileSync(join(OUT, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} 通过，证据：test/out/evidence.json`);
process.exit(failures ? 1 : 0);
