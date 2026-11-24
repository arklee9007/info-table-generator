// test/formats-roundtrip.mjs —— 第二轮：导入导出全覆盖往返测试。
// 运行：NODE_PATH=$PWD/node_modules node test/formats-roundtrip.mjs
// 覆盖：CSV 分隔符自探测（逗号/分号/制表符）与引号字段；XLSX 多表选择
// （表名/下标/默认首表/越界报错）；XLSX 导出再读回往返一致（服装 + 食品扩展字段）；
// CSV 导出再导入往返一致；JSON 导出再导入往返一致。
// 退出码：0 全部通过；1 任一失败。证据写 test/out/formats-roundtrip-evidence.json。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test/out');
mkdirSync(OUT, { recursive: true });

const requireCjs = createRequire(import.meta.url);
const XLSX = requireCjs('xlsx');

const {
  loadTemplate, parseFieldText, parseFileInput, parseCsv, detectCsvDelimiter,
  listXlsxSheets, validateStyle, buildCombos, buildInfoTableXlsx,
  buildRecordsJson, buildRecordsCsv, comboKey,
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
function eq(a, b, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}：期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}
function includes(hay, needle, what) {
  if (!String(hay).includes(needle)) throw new Error(`${what}：期望包含「${needle}」，实际「${hay}」`);
}
async function throwsWith(fn, needle, what) {
  try { await fn(); } catch (e) { includes(e.message, needle, what); return e.message; }
  throw new Error(`${what}：期望抛错（含「${needle}」），实际未抛错`);
}

const clothingTpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/clothing-v1.json'), 'utf-8')));
const foodTpl = loadTemplate(JSON.parse(readFileSync(join(ROOT, 'templates/food-v1.json'), 'utf-8')));

function styleFromText(text, tpl) {
  const { records } = parseFieldText(text, tpl);
  const fields = records[0].fields;
  const v = validateStyle(fields, [], tpl);
  return { fields, combos: v.combos, comboStocks: v.comboStocks };
}

const CLOTHING_TEXT = readFileSync(join(ROOT, 'test/samples/fieldblock-1.txt'), 'utf-8');
const FOOD_TEXT = `款名：牛肉干
分类：零食
价格：59
运费方式：包邮
描述：草原牛肉干。
口味：原味、麻辣
规格：100g
包装：袋装
库存：50
保质期：12个月
成分：牛肉、盐
产地：内蒙古`;

await test('R1', 'CSV 分隔符自探测：逗号/分号/制表符', async () => {
  eq(detectCsvDelimiter('款名,分类,价格'), ',', '逗号');
  eq(detectCsvDelimiter('款名;分类;价格'), ';', '分号');
  eq(detectCsvDelimiter('款名\t分类\t价格'), '\t', '制表符');
  const semi = `款名;分类;价格;运费方式;颜色;尺码;图案;库存\nA款;短袖;89;包邮;白色;M;素色;10\nB款;短袖;99;包邮;黑色;L;素色;20`;
  const r1 = await parseFileInput({ name: 's.csv', bytes: new TextEncoder().encode(semi) }, clothingTpl);
  eq(r1.records.map((r) => r.fields.name), ['A款', 'B款'], '分号导入款名');
  eq(r1.records[0].fields.price, 89, '分号导入价格');
  const tab = '款名\t分类\t价格\t运费方式\t颜色\t尺码\t图案\t库存\nC款\t短袖\t79\t包邮\t米白\tM\t素色\t5';
  const r2 = await parseFileInput({ name: 't.csv', bytes: new TextEncoder().encode(tab) }, clothingTpl);
  eq(r2.records[0].fields.name, 'C款', '制表符导入款名');
  eq(r2.records[0].fields.price, 79, '制表符导入价格');
  return 'ok';
});

await test('R2', 'CSV 引号字段：描述里的逗号不切列', async () => {
  const csv = `款名,分类,价格,运费方式,颜色,尺码,图案,库存,描述\nA款,短袖,89,包邮,白色,M,素色,10,"柔软, 透气, 不起球"`;
  const r = await parseFileInput({ name: 'q.csv', bytes: new TextEncoder().encode(csv) }, clothingTpl);
  eq(r.records[0].fields.desc, '柔软, 透气, 不起球', '引号内逗号保留');
  const rows = parseCsv(csv);
  eq(rows[1].length, 9, '引号字段不切列');
  return 'ok';
});

await test('R3', 'XLSX 多表：列出表名，按表名/下标选表，默认首表', async () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['款名', '分类', '价格', '运费方式', '颜色', '尺码', '图案', '库存', '描述'],
    ['简约T恤', '短袖', 89, '包邮', '白色、黑色', 'M、L', '素色', 200, '日常基础款'],
  ]), '服装表');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['款名', '分类', '价格', '运费方式', '颜色', '尺码', '图案', '库存'],
    ['宽松衬衫', '衬衫', 159, '套模板', '米白', 'M、L、XL', '素色', 120],
  ]), '第二张');
  const bytes = new Uint8Array(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  eq(await listXlsxSheets(bytes), ['服装表', '第二张'], '表名清单');
  const def = await parseFileInput({ name: 'm.xlsx', bytes }, clothingTpl);
  eq(def.records[0].fields.name, '简约T恤', '默认读首表');
  eq(def.sheets, ['服装表', '第二张'], '返回带表名清单');
  eq(def.sheet, '服装表', '返回用了哪张表');
  const byIndex = await parseFileInput({ name: 'm.xlsx', bytes }, clothingTpl, { sheet: 1 });
  eq(byIndex.records[0].fields.name, '宽松衬衫', '下标选第二张');
  eq(byIndex.sheet, '第二张', '下标选表名');
  const byName = await parseFileInput({ name: 'm.xlsx', bytes }, clothingTpl, { sheet: '第二张' });
  eq(byName.records[0].fields.name, '宽松衬衫', '表名选第二张');
  await throwsWith(() => parseFileInput({ name: 'm.xlsx', bytes }, clothingTpl, { sheet: 5 }), '第 6 张表', '下标越界报错');
  await throwsWith(() => parseFileInput({ name: 'm.xlsx', bytes }, clothingTpl, { sheet: '没有这张' }), '没有', '表名不存在报错');
  return 'ok';
});

await test('R4', 'XLSX 导出再读回：服装 4 组合 + 库存覆盖一致', async () => {
  const s = styleFromText(CLOTHING_TEXT, clothingTpl);
  eq(s.combos.length, 4, '原组合 4 个');
  const bytes = await buildInfoTableXlsx(s.fields, s.combos, s.comboStocks, clothingTpl);
  const back = await parseFileInput({ name: 'back.xlsx', bytes }, clothingTpl);
  eq(back.kind, 'info-table', '读回认出信息表格式');
  const f = back.records[0].fields;
  eq(f.name, s.fields.name, '款名一致');
  eq(f.price, s.fields.price, '价格一致');
  eq(f.code, s.fields.code, '款号一致');
  const v = validateStyle(f, [], clothingTpl);
  eq(v.combos, s.combos, '组合一致');
  eq([...v.comboStocks.entries()], [...s.comboStocks.entries()], '逐组合库存一致');
  return 'ok';
});

await test('R5', 'XLSX 导出再读回：食品扩展字段一致', async () => {
  const s = styleFromText(FOOD_TEXT, foodTpl);
  eq(s.combos.length, 2, '食品组合 2 个');
  const bytes = await buildInfoTableXlsx(s.fields, s.combos, s.comboStocks, foodTpl);
  const back = await parseFileInput({ name: 'food-back.xlsx', bytes }, foodTpl);
  const f = back.records[0].fields;
  eq(f.extra.shelfLife, '12个月', '保质期读回');
  eq(f.extra.ingredients, '牛肉、盐', '成分读回');
  eq(f.extra.origin, '内蒙古', '产地读回');
  const v = validateStyle(f, [], foodTpl);
  eq(v.combos, s.combos, '食品组合一致');
  return 'ok';
});

await test('R6', 'CSV 导出再导入：逐组合行数与库存一致', async () => {
  const s = styleFromText(CLOTHING_TEXT, clothingTpl);
  const csv = buildRecordsCsv(s.fields, s.combos, s.comboStocks, clothingTpl);
  const rows = parseCsv(csv);
  eq(rows.length, 1 + s.combos.length, 'CSV 行数 = 表头 + 组合数');
  const back = await parseFileInput({ name: 'back.csv', bytes: new TextEncoder().encode(csv) }, clothingTpl);
  eq(back.records.length, s.combos.length, '读回款数 = 组合数（每行一款）');
  const got = back.records.map((r) => {
    const v = validateStyle(r.fields, [], clothingTpl);
    return [v.combos[0].join('/'), v.comboStocks.get(comboKey(v.combos[0]))];
  }).sort();
  const want = s.combos.map((c) => [c.join('/'), s.comboStocks.get(comboKey(c))]).sort();
  eq(got, want, '逐组合库存一致');
  return 'ok';
});

await test('R7', 'JSON 导出再导入：逐组合行数与库存一致', async () => {
  const s = styleFromText(CLOTHING_TEXT, clothingTpl);
  const json = buildRecordsJson(s.fields, s.combos, s.comboStocks, clothingTpl);
  const back = await parseFileInput({ name: 'back.json', bytes: new TextEncoder().encode(json) }, clothingTpl);
  eq(back.kind, 'json', 'JSON 导入');
  eq(back.records.length, s.combos.length, '读回款数 = 组合数');
  const got = back.records.map((r) => {
    const v = validateStyle(r.fields, [], clothingTpl);
    return [v.combos[0].join('/'), v.comboStocks.get(comboKey(v.combos[0]))];
  }).sort();
  const want = s.combos.map((c) => [c.join('/'), s.comboStocks.get(comboKey(c))]).sort();
  eq(got, want, '逐组合库存一致');
  eq(back.records[0].fields.name, s.fields.name, '款名一致');
  return 'ok';
});

await test('R8', '三格式导出幂等：同一输入两次结果字节一致', async () => {
  const s = styleFromText(CLOTHING_TEXT, clothingTpl);
  const x1 = await buildInfoTableXlsx(s.fields, s.combos, s.comboStocks, clothingTpl);
  const x2 = await buildInfoTableXlsx(s.fields, s.combos, s.comboStocks, clothingTpl);
  eq(Buffer.from(x1).toString('base64'), Buffer.from(x2).toString('base64'), 'XLSX 两次一致');
  eq(buildRecordsCsv(s.fields, s.combos, s.comboStocks, clothingTpl),
    buildRecordsCsv(s.fields, s.combos, s.comboStocks, clothingTpl), 'CSV 两次一致');
  eq(buildRecordsJson(s.fields, s.combos, s.comboStocks, clothingTpl),
    buildRecordsJson(s.fields, s.combos, s.comboStocks, clothingTpl), 'JSON 两次一致');
  return 'ok';
});

const evidence = {
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
writeFileSync(join(OUT, 'formats-roundtrip-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} 通过，证据：test/out/formats-roundtrip-evidence.json`);
process.exit(failures ? 1 : 0);
