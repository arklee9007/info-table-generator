// test/template-editor.mjs —— 第二轮：模板编辑器核心（core/template-edit.js）Node 测试。
// 运行：NODE_PATH=$PWD/node_modules node test/template-editor.mjs
// 覆盖：轴改名同步（规格表头 + 图片类别）、字段/扩展字段/图片类别增删、
// 轴增减、删除保护、元信息校验、新建品类骨架、即时校验逐条报错。
// 退出码：0 全部通过；1 任一失败。证据写 test/out/template-editor-evidence.json。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test/out');
mkdirSync(OUT, { recursive: true });

const {
  loadTemplate, validateTemplate,
  stripLoaded, cloneRaw, validateDraft, renameFieldFirstName, renameAxis, setAxisList,
  addField, removeField, setFieldRequired, addExtraField, removeExtraField, setExtraOptions,
  addImageCategory, removeImageCategory, setImageCategory, setMeta, createCategoryTemplate,
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
function throwsWith(fn, needle, what) {
  try { fn(); } catch (e) { includes(e.message, needle, what); return e.message; }
  throw new Error(`${what}：期望抛错（含「${needle}」），实际未抛错`);
}

const clothingRaw = () => JSON.parse(readFileSync(join(ROOT, 'templates/clothing-v1.json'), 'utf-8'));
const foodRaw = () => JSON.parse(readFileSync(join(ROOT, 'templates/food-v1.json'), 'utf-8'));

await test('E1', '轴改名同步改规格表头与图片类别', async () => {
  const raw = clothingRaw();
  renameAxis(raw, 'colors', '色系');
  eq(raw.specHeaders[0], '色系', 'specHeaders 首列');
  const colorCat = raw.images.categories.find((c) => c.key === 'color');
  eq(colorCat.label, '色系图', '颜色图 label');
  eq(colorCat.naming, '色系图-{key}', '颜色图 naming');
  eq(validateDraft(raw), [], '校验通过');
  const tpl = loadTemplate(raw);
  eq(tpl.specHeaders, ['色系', '尺码', '图案', '库存'], '加载后表头');
  return 'ok';
});

await test('E2', '字段改名只改首名，同义词保留', async () => {
  const raw = clothingRaw();
  renameFieldFirstName(raw, 'sizes', '鞋码');
  const f = raw.fields.find((x) => x.key === 'sizes');
  eq(f.names[0], '鞋码', '首名');
  includes(f.names.join(','), '尺寸', '旧同义词保留');
  eq(validateDraft(raw), [], '校验通过');
  return 'ok';
});

await test('E3', '扩展字段改名与增删', async () => {
  const raw = foodRaw();
  renameFieldFirstName(raw, 'shelfLife', '有效期');
  eq(raw.extraFields.find((x) => x.key === 'shelfLife').names[0], '有效期', '扩展字段改名');
  eq(validateDraft(raw), [], '改名后校验通过');
  removeExtraField(raw, 'origin');
  eq(raw.extraFields.some((x) => x.key === 'origin'), false, '产地已删');
  addExtraField(raw, { key: 'warranty', name: '保修期', type: 'text' });
  eq(raw.extraFields.some((x) => x.key === 'warranty'), true, '保修期已加');
  eq(validateDraft(raw), [], '增删后校验通过');
  loadTemplate(raw);
  return 'ok';
});

await test('E4', '扩展字段 enum 缺 options 报错，有 options 才通过', async () => {
  const raw = foodRaw();
  throwsWith(() => addExtraField(raw, { key: 'grade', name: '等级', type: 'enum' }), '可选值', '缺 options');
  addExtraField(raw, { key: 'grade', name: '等级', type: 'enum', options: 'A、B、C' });
  eq(raw.extraFields.find((x) => x.key === 'grade').options, ['A', 'B', 'C'], 'options 解析');
  setExtraOptions(raw, 'grade', '优、良');
  eq(raw.extraFields.find((x) => x.key === 'grade').options, ['优', '良'], '改 options');
  eq(validateDraft(raw), [], '校验通过');
  return 'ok';
});

await test('E5', '规格轴增减：3 维减到 2 维再加回', async () => {
  const raw = clothingRaw();
  setAxisList(raw, ['colors', 'sizes']);
  eq(raw.specAxes, ['colors', 'sizes'], '轴剩 2 个');
  eq(raw.specHeaders, ['颜色', '尺码', '库存'], '表头剩 3 列');
  eq(validateDraft(raw), [], '2 维校验通过');
  setAxisList(raw, ['colors', 'sizes', 'patterns']);
  eq(raw.specHeaders, ['颜色', '尺码', '图案', '库存'], '加回 3 维');
  throwsWith(() => setAxisList(raw, ['colors', 'sizes', 'patterns', 'code']), '最多 3 个', '4 轴拒绝');
  throwsWith(() => setAxisList(raw, ['colors', 'price']), 'list 类型', '非 list 轴拒绝');
  return 'ok';
});

await test('E6', '删除保护：锚字段、引擎字段、在轴字段都删不掉', async () => {
  const raw = clothingRaw();
  throwsWith(() => removeField(raw, 'name'), '锚字段', '删锚字段');
  throwsWith(() => removeField(raw, 'price'), '引擎字段', '删价格');
  throwsWith(() => removeField(raw, 'stock'), '引擎字段', '删库存');
  throwsWith(() => removeField(raw, 'colors'), '规格轴', '删在轴字段');
  setAxisList(raw, ['colors', 'sizes']);
  removeField(raw, 'patterns');
  eq(raw.fields.some((x) => x.key === 'patterns'), false, '移出轴后图案字段可删');
  // keyFrom 保护：食品的口味字段移出轴后，仍被“口味图”类别引用，删不掉
  const food = foodRaw();
  setAxisList(food, ['specs', 'packs']);
  throwsWith(() => removeField(food, 'flavors'), 'keyFrom', '删被图片类别引用的字段');
  return 'ok';
});

await test('E7', '新字段：文本与列表可加，key 重复与非法 key 拒绝', async () => {
  const raw = clothingRaw();
  addField(raw, { key: 'brand', name: '品牌', type: 'text' });
  eq(raw.fields.find((x) => x.key === 'brand').names[0], '品牌', '品牌字段');
  addField(raw, { key: 'season', name: '季节', type: 'list' });
  eq(raw.fields.find((x) => x.key === 'season').type, 'list', '列表字段');
  setAxisList(raw, ['colors', 'sizes', 'season']);
  eq(raw.specHeaders, ['颜色', '尺码', '季节', '库存'], '新列表字段可进轴');
  eq(validateDraft(raw), [], '校验通过');
  throwsWith(() => addField(raw, { key: 'brand', name: '品牌2' }), '已存在', 'key 重复');
  throwsWith(() => addField(raw, { key: '1abc', name: '错' }), '字母开头', '非法 key');
  removeField(raw, 'brand');
  eq(raw.fields.some((x) => x.key === 'brand'), false, '新字段可删');
  return 'ok';
});

await test('E8', '必填开关与图片类别增删改', async () => {
  const raw = clothingRaw();
  setFieldRequired(raw, 'desc', true);
  eq(raw.fields.find((x) => x.key === 'desc').required, true, '描述变必填');
  throwsWith(() => removeImageCategory(raw, 'main'), '主图', '删主图');
  addImageCategory(raw, { key: 'cert', label: '证书图', naming: '证书图{index}' });
  eq(raw.images.categories.some((c) => c.key === 'cert'), true, '证书图已加');
  setImageCategory(raw, 'cert', { label: '质检图' });
  eq(raw.images.categories.find((c) => c.key === 'cert').label, '质检图', '改名');
  throwsWith(() => addImageCategory(raw, { key: 'bad', label: '错', naming: '错{index}', keyFrom: 'price' }), 'list 类型', 'keyFrom 非 list 拒绝');
  throwsWith(() => addImageCategory(raw, { key: 'bad2', label: '错', naming: '错图', keyFrom: 'colors' }), '{key}', 'keyFrom 缺占位拒绝');
  removeImageCategory(raw, 'cert');
  eq(raw.images.categories.some((c) => c.key === 'cert'), false, '证书图已删');
  eq(validateDraft(raw), [], '校验通过');
  return 'ok';
});

await test('E9', '元信息：版本号格式校验', async () => {
  const raw = clothingRaw();
  throwsWith(() => setMeta(raw, { version: '1.0' }), 'x.y.z', '坏版本号');
  setMeta(raw, { name: '服装-改', version: '1.2.0', description: '改版' });
  eq(raw.name, '服装-改', '改名');
  eq(raw.version, '1.2.0', '改版本');
  eq(validateDraft(raw), [], '校验通过');
  return 'ok';
});

await test('E10', '新建品类骨架：2 轴与 0 轴', async () => {
  const base = clothingRaw();
  const two = createCategoryTemplate(base, '测试食品', ['口味', '规格']);
  eq(two.specAxes, ['colors', 'sizes'], '2 轴');
  eq(two.specHeaders, ['口味', '规格', '库存'], '2 轴表头');
  eq(two.extraFields, [], '扩展字段清空');
  eq(validateDraft(two), [], '2 轴校验通过');
  loadTemplate(two);
  const zero = createCategoryTemplate(base, '单品', []);
  eq(zero.specAxes, [], '0 轴');
  eq(zero.specHeaders, ['库存'], '0 轴表头');
  eq(validateDraft(zero), [], '0 轴校验通过');
  throwsWith(() => createCategoryTemplate(base, '', ['口味']), '品类名', '空品类名拒绝');
  return 'ok';
});

await test('E11', '即时校验逐条报错：字段词重复能定位', async () => {
  const raw = clothingRaw();
  renameFieldFirstName(raw, 'sizes', '颜色');
  const errors = validateDraft(raw);
  if (!errors.length) throw new Error('期望校验报错，实际通过');
  includes(errors.join('\n'), '颜色', '报错提到重复的字段词');
  return errors.join('；');
});

await test('E12', '改来改去幂等：同一草稿改两遍结果一致', async () => {
  const raw = clothingRaw();
  renameAxis(raw, 'colors', '色系');
  const once = JSON.stringify(raw);
  const raw2 = clothingRaw();
  renameAxis(raw2, 'colors', '色系');
  eq(JSON.stringify(raw2), once, '两次改名结果一致');
  const stripped = stripLoaded(loadTemplate(raw));
  eq('_wordIndex' in stripped, false, 'stripLoaded 去掉索引');
  eq(cloneRaw(raw).specHeaders, raw.specHeaders, 'cloneRaw 深拷贝内容一致');
  return 'ok';
});

const evidence = {
  ranAt: new Date().toISOString(),
  total: results.length,
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
writeFileSync(join(OUT, 'template-editor-evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`\n${evidence.passed}/${evidence.total} 通过，证据：test/out/template-editor-evidence.json`);
process.exit(failures ? 1 : 0);
