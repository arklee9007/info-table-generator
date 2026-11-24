// test/accept-templates.mjs —— 新模板验收（服装/鞋类/美妆）：与第一阶段同一标准。
// 运行：NODE_PATH=$PWD/node_modules node test/accept-templates.mjs
// 覆盖：模板校验、行业字段词解析、出包、真解析器验收、信息表往返读回、包内文件名。
// webp 转换器用 PIL 真解码（与浏览器 canvas 路径同义；canvas 真路径由 PWA 导入测试覆盖）。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test/out');
mkdirSync(OUT, { recursive: true });

const {
  loadTemplate, validateTemplate, parsePastedText, parseFileInput, generatePack,
} = await import('../core/index.js');

const requireCjs = createRequire(import.meta.url);
const parser = requireCjs('/home/hatch/workspace/miniprogram-mall/work-042/modules/material-import/parser.cjs');

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

// webp -> JPEG：PIL 真解码，像素与源文件一致
function webpToJpeg(webpBytes) {
  const out = execFileSync('python3', ['-c',
    'import sys; from PIL import Image; import io; ' +
    'im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert("RGB"); ' +
    'im.save(sys.stdout.buffer, "JPEG", quality=92)'],
    { input: Buffer.from(webpBytes), maxBuffer: 64 * 1024 * 1024 });
  return new Uint8Array(out);
}

const CASES = [
  {
    id: 'clothing', tplFile: 'templates/clothing-v1.json', packDir: 'testpacks/clothing',
    expect: {
      name: '简约圆领卫衣', category: '卫衣', price: 159, freight: '套模板', code: 'HOODIE-001',
      axis1: ['藏青', '米白'], axis2: ['M', 'L'], axis3: ['素色', '条纹'],
      defaultStock: 90, overrideKey: '藏青\u001fM\u001f素色', overrideStock: 40,
      freightMode: 'template', priceCents: 15900,
      files: ['HOODIE-001/信息表.xlsx', 'HOODIE-001/主图1.jpg', 'HOODIE-001/详情图1.png', 'HOODIE-001/详情图2.jpg', 'HOODIE-001/颜色图-藏青.png', 'HOODIE-001/颜色图-米白.jpg', 'HOODIE-001/尺码图.png'],
    },
    images: [
      ['主图.jpg', 'main', 1, null], ['详情图1.png', 'detail', 2, null], ['详情图2.webp', 'detail', 3, null],
      ['颜色图-藏青.png', 'color', 4, '藏青'], ['颜色图-米白.jpg', 'color', 5, '米白'], ['尺码图.png', 'size', 6, null],
    ],
  },
  {
    id: 'shoes', tplFile: 'templates/shoes-v1.json', packDir: 'testpacks/shoes',
    expect: {
      name: '轻跑运动鞋', category: '运动鞋', price: 299, freight: '包邮', code: 'SHOES-001',
      axis1: ['黑色', '白色'], axis2: ['39', '40'], axis3: ['低帮', '高帮'],
      defaultStock: 80, overrideKey: '黑色\u001f39\u001f低帮', overrideStock: 30,
      freightMode: 'free', priceCents: 29900,
      files: ['SHOES-001/信息表.xlsx', 'SHOES-001/主图1.jpg', 'SHOES-001/详情图1.png', 'SHOES-001/详情图2.jpg', 'SHOES-001/颜色图-黑色.png', 'SHOES-001/颜色图-白色.jpg', 'SHOES-001/尺码图.png'],
    },
    images: [
      ['主图.jpg', 'main', 1, null], ['详情图1.png', 'detail', 2, null], ['详情图2.webp', 'detail', 3, null],
      ['颜色图-黑色.png', 'color', 4, '黑色'], ['颜色图-白色.jpg', 'color', 5, '白色'], ['尺码图.png', 'size', 6, null],
    ],
  },
  {
    id: 'cosmetics', tplFile: 'templates/cosmetics-v1.json', packDir: 'testpacks/cosmetics',
    expect: {
      name: '丝绒哑光口红', category: '口红', price: 89, freight: '套模板', code: 'LIP-001',
      axis1: ['正红', '豆沙'], axis2: ['3.5g', '4.5g'], axis3: ['哑光', '滋润'],
      defaultStock: 120, overrideKey: '正红\u001f3.5g\u001f哑光', overrideStock: 60,
      freightMode: 'template', priceCents: 8900,
      files: ['LIP-001/信息表.xlsx', 'LIP-001/主图1.jpg', 'LIP-001/详情图1.png', 'LIP-001/详情图2.jpg', 'LIP-001/颜色图-正红.png', 'LIP-001/颜色图-豆沙.jpg', 'LIP-001/尺码图.png'],
    },
    images: [
      ['主图.jpg', 'main', 1, null], ['详情图1.png', 'detail', 2, null], ['详情图2.webp', 'detail', 3, null],
      ['颜色图-正红.png', 'color', 4, '正红'], ['颜色图-豆沙.jpg', 'color', 5, '豆沙'], ['尺码图.png', 'size', 6, null],
    ],
  },
];

for (const c of CASES) {
  const tplJson = JSON.parse(readFileSync(join(ROOT, c.tplFile), 'utf-8'));
  const tpl = loadTemplate(tplJson);
  const e = c.expect;
  const imgDir = join(ROOT, c.packDir, '图片');

  await test(`${c.id}-T1`, `${tpl.name}模板校验通过`, () => {
    eq(validateTemplate(tplJson), [], '模板校验');
    eq(tpl.specAxes, ['colors', 'sizes', 'patterns'], '规格轴');
    eq(tpl.specHeaders, ['颜色', '尺码', '图案', '库存'], '规格表头（解析器写死要求）');
    eq(tpl.headerRow1, ['商品名', '分类', '价格', '运费方式', '描述'], '首行表头（解析器写死要求）');
    return `id=${tpl.id} v${tpl.version}`;
  });

  let fields;
  await test(`${c.id}-T2`, `${tpl.name}示例输入解析（行业字段词）`, async () => {
    const text = readFileSync(join(ROOT, c.packDir, '示例输入.txt'), 'utf-8');
    const { records } = await parsePastedText(text, tpl);
    eq(records.length, 1, '款数');
    fields = records[0].fields;
    eq(fields.name, e.name, '款名'); eq(fields.category, e.category, '分类');
    eq(fields.price, e.price, '价格'); eq(fields.freight, e.freight, '运费');
    eq(fields.colors, e.axis1, '轴1'); eq(fields.sizes, e.axis2, '轴2'); eq(fields.patterns, e.axis3, '轴3');
    eq(fields.code, e.code, '款号'); eq(fields.stock.default, e.defaultStock, '统一库存');
    eq(fields.stock.overrides.get(e.overrideKey), e.overrideStock, '库存覆盖');
    return 'ok';
  });

  let pack;
  await test(`${c.id}-T3`, `${tpl.name}出包 + 真解析器验收`, async () => {
    const images = c.images.map(([name, category, order, colorKey]) => ({
      bytes: new Uint8Array(readFileSync(join(imgDir, name))), category, order, colorKey, sourceName: name,
    }));
    pack = await generatePack(fields, images, tpl, { convertWebp: async (b) => webpToJpeg(b) });
    eq(pack.zipName, `${e.code}.zip`, '包名即款号');
    eq(pack.files.map((f) => f.name).sort(), [...e.files].sort(), '包内文件名');
    if (pack.zipBytes.length > 2 * 1024 * 1024) throw new Error('包超 2MB');
    const r = await parser.parsePackage(Buffer.from(pack.zipBytes), pack.zipName);
    eq(r.ok, true, '解析器 ok');
    eq(r.report.errors, [], '解析器 errors');
    eq(r.report.warnings, [], '解析器 warnings');
    eq(r.product.name, e.name, '商品名'); eq(r.product.price, e.priceCents, '价格(分)');
    eq(r.product.freightMode, e.freightMode, '运费模式');
    eq(r.product.colors, e.axis1, '颜色'); eq(r.product.sizes, e.axis2, '尺码'); eq(r.product.patterns, e.axis3, '图案');
    eq(r.product.skus.length, 8, 'SKU 数');
    const skuMap = new Map(r.product.skus.map((s) => [`${s.color}/${s.size}/${s.pattern}`, s.stock]));
    eq(skuMap.get(e.overrideKey.split('\u001f').join('/')), e.overrideStock, '覆盖库存');
    eq(r.assets.length, 6, 'assets 数');
    eq(r.report.code, e.code, '款号取文件夹名');
    writeFileSync(join(OUT, `accept-${e.code}.zip`), pack.zipBytes);
    return `zip ${pack.zipBytes.length} bytes, parser validated`;
  });

  await test(`${c.id}-T4`, `${tpl.name}出包的表可被本工具再读回`, async () => {
    const back = await parseFileInput({ name: '信息表.xlsx', bytes: pack.xlsxBytes }, tpl);
    eq(back.kind, 'info-table', '识别为信息表');
    const f = back.records[0].fields;
    eq(f.name, e.name, '款名'); eq(f.price, e.price, '价格');
    eq(f.stock.default, e.defaultStock, '默认库存');
    eq(f.stock.overrides.get(e.overrideKey), e.overrideStock, '覆盖库存');
    eq(f.colors, e.axis1, '轴1'); eq(f.sizes, e.axis2, '轴2'); eq(f.patterns, e.axis3, '轴3');
    return 'ok';
  });
}

// 模板文件可被 JSON.parse + loadTemplate 直接导入（与 PWA 导入路径同一入口）
await test('IMP', '三个模板文件均可直接导入', async () => {
  for (const c of CASES) {
    const raw = readFileSync(join(ROOT, c.tplFile), 'utf-8');
    const t = loadTemplate(JSON.parse(raw));
    if (!t._wordIndex) throw new Error(c.id + ' 字段词索引未建');
  }
  return CASES.map((c) => c.id).join(', ');
});

const evidence = {
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
writeFileSync(join(OUT, 'templates-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} 通过，证据：test/out/templates-evidence.json`);
process.exit(failures ? 1 : 0);
