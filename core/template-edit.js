// template-edit.js —— 模板编辑器用的纯函数（不碰 DOM、不碰 localStorage，方便 Node 测试）。
// 编辑器在“草稿 JSON”上改，改完调 validateTemplate 即时校验，保存时再经 loadTemplate。
// 约束（与引擎语义对齐，编辑器不许绕过）：
// · 锚字段（styleAnchor，即款名）与价格/运费/库存/款号这 5 个引擎字段不可删除，类型不可改；
// · 规格轴字段须先从轴里移除才能删除；图片类别“主图”不可删除；
// · 字段身份是 key，改名只改 names[0]（首个字段词），同义词保留；轴改名同步改
//   specHeaders 与 keyFrom 指向该轴的图片类别 label/naming；
// · 内置模板不可原地改：编辑器保存时，内置模板自动存为副本（新 id、版本 1.0.0）。
// 新建品类骨架（上一轮在 app.js 里的逻辑）也收进这里：createCategoryTemplate，
// 行为与上一轮一致（从服装模板复制骨架，只改轴字段首名、规格表头、图片类别）。

import { validateTemplate } from './template.js';

// 去掉 loadTemplate 附加的 _wordIndex，还原成可保存的原始 JSON（深拷贝）。
export function stripLoaded(tpl) {
  const { _wordIndex, ...raw } = tpl;
  return JSON.parse(JSON.stringify(raw));
}

export function cloneRaw(raw) {
  return JSON.parse(JSON.stringify(raw));
}

// 即时校验：返回错误字符串数组（空 = 通过），供编辑器逐条展示。
export function validateDraft(raw) {
  return validateTemplate(raw);
}

function findField(raw, key) {
  return (raw.fields || []).find((f) => f.key === key)
    || (raw.extraFields || []).find((f) => f.key === key);
}

function allKeys(raw) {
  return new Set([...(raw.fields || []).map((f) => f.key), ...(raw.extraFields || []).map((f) => f.key)]);
}

// ---------- 改名 ----------
// 改字段首名（主字段或扩展字段）。是规格轴时同步 specHeaders；图片类别 keyFrom
// 指向该轴的，label/naming 按新轴名同步（label 形如“口味图”才改，自定义名不动）。
export function renameFieldFirstName(raw, key, newName) {
  const name = String(newName || '').trim();
  if (!name) throw new Error('字段名不能为空');
  const f = findField(raw, key);
  if (!f) throw new Error(`找不到字段：${key}`);
  const oldName = f.names[0];
  f.names = [name, ...f.names.slice(1).filter((n) => n !== name)];
  const axisIdx = (raw.specAxes || []).indexOf(key);
  if (axisIdx >= 0) {
    raw.specHeaders[axisIdx] = name;
    for (const c of raw.images.categories || []) {
      if (c.keyFrom !== key) continue;
      if (c.label === oldName + '图') c.label = name + '图';
      if (c.naming === oldName + '图-{key}') c.naming = name + '图-{key}';
    }
  }
  return raw;
}

// 轴改名 = 字段改名（同一件事，单列一个名字供界面调用）。
export function renameAxis(raw, axisKey, newName) {
  if (!(raw.specAxes || []).includes(axisKey)) throw new Error(`不是规格轴：${axisKey}`);
  return renameFieldFirstName(raw, axisKey, newName);
}

// ---------- 规格轴增减 ----------
// 改轴清单：axisKeys 为新的轴 key 列表（须是 list 类型字段，0-3 个）。
// specHeaders 按各轴首名 + “库存”重建；脱离轴的字段必填不动（引擎本来就不强制未用轴）。
export function setAxisList(raw, axisKeys) {
  const keys = [...axisKeys];
  if (keys.length > 3) throw new Error('规格轴最多 3 个');
  if (new Set(keys).size !== keys.length) throw new Error('规格轴有重复');
  for (const k of keys) {
    const f = (raw.fields || []).find((x) => x.key === k);
    if (!f) throw new Error(`规格轴引用了不存在的字段：${k}`);
    if (f.type !== 'list') throw new Error(`规格轴 ${k} 须为 list 类型字段`);
  }
  raw.specAxes = keys;
  raw.specHeaders = [...keys.map((k) => {
    const f = raw.fields.find((x) => x.key === k);
    return f.names[0];
  }), '库存'];
  return raw;
}

// ---------- 字段增删 ----------
// 引擎字段（锚/价格/运费/库存/款号）不可删；规格轴字段须先移出轴。
const PROTECTED_KEYS = new Set(['price', 'freight', 'stock', 'code']);

export function addField(raw, { key, name, type = 'text', required = false, maxLen = 120 } = {}) {
  const k = String(key || '').trim();
  const n = String(name || '').trim();
  if (!k) throw new Error('新字段须填 key（英文字母，如 brand）');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) throw new Error('字段 key 须以字母开头，只含字母、数字、下划线');
  if (!n) throw new Error('新字段须填显示名');
  if (allKeys(raw).has(k)) throw new Error(`字段 key 已存在：${k}`);
  const fieldType = type === 'list' ? 'list' : undefined; // 主字段只认 文本/列表；价格等类型不开放新建
  const f = { key: k, names: [n], required: !!required };
  if (fieldType) { f.type = 'list'; f.itemMaxLen = 60; }
  else if (maxLen) f.maxLen = Number(maxLen) || 120;
  raw.fields.push(f);
  return raw;
}

export function removeField(raw, key) {
  const f = (raw.fields || []).find((x) => x.key === key);
  if (!f) throw new Error(`找不到主字段：${key}`);
  if (f.styleAnchor) throw new Error(`「${f.names[0]}」是锚字段（款名），不可删除`);
  if (PROTECTED_KEYS.has(key)) throw new Error(`「${f.names[0]}」是引擎字段，不可删除（出包与读回都要用它）`);
  if ((raw.specAxes || []).includes(key)) throw new Error(`「${f.names[0]}」还是规格轴，请先在规格轴里移除它再删除`);
  if ((raw.images.categories || []).some((c) => c.keyFrom === key)) {
    throw new Error(`「${f.names[0]}」还被图片类别引用（keyFrom），请先改掉图片类别的对应字段再删除`);
  }
  raw.fields = raw.fields.filter((x) => x.key !== key);
  return raw;
}

export function setFieldRequired(raw, key, required) {
  const f = findField(raw, key);
  if (!f) throw new Error(`找不到字段：${key}`);
  f.required = !!required;
  return raw;
}

// ---------- 扩展字段增删 ----------
export function addExtraField(raw, { key, name, type = 'text', required = false, options = [] } = {}) {
  const k = String(key || '').trim();
  const n = String(name || '').trim();
  if (!k) throw new Error('扩展字段须填 key（英文字母，如 warranty）');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) throw new Error('字段 key 须以字母开头，只含字母、数字、下划线');
  if (!n) throw new Error('扩展字段须填显示名');
  if (allKeys(raw).has(k)) throw new Error(`字段 key 已存在：${k}`);
  const t = ['text', 'number', 'date', 'enum', 'list'].includes(type) ? type : 'text';
  const ef = { key: k, names: [n], required: !!required, type: t };
  if (t === 'enum') {
    const opts = (Array.isArray(options) ? options : String(options).split(/[、，,]+/)).map((s) => String(s).trim()).filter(Boolean);
    if (!opts.length) throw new Error('enum 类型须填至少一个可选值（顿号分隔）');
    ef.options = opts;
  }
  if (!raw.extraFields) raw.extraFields = [];
  raw.extraFields.push(ef);
  return raw;
}

export function removeExtraField(raw, key) {
  if (!(raw.extraFields || []).some((x) => x.key === key)) throw new Error(`找不到扩展字段：${key}`);
  raw.extraFields = raw.extraFields.filter((x) => x.key !== key);
  return raw;
}

export function setExtraOptions(raw, key, options) {
  const ef = (raw.extraFields || []).find((x) => x.key === key);
  if (!ef) throw new Error(`找不到扩展字段：${key}`);
  if (ef.type !== 'enum') throw new Error(`「${ef.names[0]}」不是 enum 类型，不用填可选值`);
  const opts = (Array.isArray(options) ? options : String(options).split(/[、，,]+/)).map((s) => String(s).trim()).filter(Boolean);
  if (!opts.length) throw new Error('enum 类型须填至少一个可选值（顿号分隔）');
  ef.options = opts;
  return raw;
}

// ---------- 图片类别增删改 ----------
export function addImageCategory(raw, { key, label, naming, keyFrom = null, required = false, maxCount = null } = {}) {
  const k = String(key || '').trim();
  const l = String(label || '').trim();
  const nm = String(naming || '').trim();
  if (!k) throw new Error('图片类别须填 key（英文字母，如 cert）');
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(k)) throw new Error('类别 key 须以字母开头，只含字母、数字、下划线');
  if (!l) throw new Error('图片类别须填显示名');
  if (!nm) throw new Error('图片类别须填命名规则（如 证书图{index}，按轴取值时用 {key}）');
  if ((raw.images.categories || []).some((c) => c.key === k)) throw new Error(`图片类别 key 已存在：${k}`);
  if (keyFrom) {
    const f = (raw.fields || []).find((x) => x.key === keyFrom);
    if (!f) throw new Error(`对应字段不存在：${keyFrom}`);
    if (f.type !== 'list') throw new Error(`对应字段 ${keyFrom} 须为 list 类型`);
    if (!nm.includes('{key}')) throw new Error('按轴取值的类别，命名规则里须含 {key} 占位');
  }
  const c = { key: k, label: l, naming: nm, required: !!required };
  if (keyFrom) c.keyFrom = keyFrom;
  if (maxCount) c.maxCount = Number(maxCount);
  raw.images.categories.push(c);
  return raw;
}

export function removeImageCategory(raw, key) {
  if (key === 'main') throw new Error('「主图」类别不可删除（出包必填）');
  if (!(raw.images.categories || []).some((c) => c.key === key)) throw new Error(`找不到图片类别：${key}`);
  raw.images.categories = raw.images.categories.filter((c) => c.key !== key);
  return raw;
}

export function setImageCategory(raw, key, patch) {
  const c = (raw.images.categories || []).find((x) => x.key === key);
  if (!c) throw new Error(`找不到图片类别：${key}`);
  if (patch.label !== undefined) {
    const l = String(patch.label).trim();
    if (!l) throw new Error('图片类别显示名不能为空');
    c.label = l;
  }
  if (patch.naming !== undefined) {
    const nm = String(patch.naming).trim();
    if (!nm) throw new Error('图片类别命名规则不能为空');
    c.naming = nm;
  }
  if (patch.keyFrom !== undefined) {
    if (patch.keyFrom) {
      const f = (raw.fields || []).find((x) => x.key === patch.keyFrom);
      if (!f) throw new Error(`对应字段不存在：${patch.keyFrom}`);
      if (f.type !== 'list') throw new Error(`对应字段 ${patch.keyFrom} 须为 list 类型`);
      if (!String(c.naming).includes('{key}')) throw new Error('按轴取值的类别，命名规则里须含 {key} 占位');
      c.keyFrom = patch.keyFrom;
    } else {
      delete c.keyFrom;
    }
  }
  if (patch.required !== undefined) c.required = !!patch.required;
  return raw;
}

// ---------- 元信息 ----------
export function setMeta(raw, { name, version, description } = {}) {
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) throw new Error('模板名不能为空');
    raw.name = n;
  }
  if (version !== undefined) {
    const v = String(version).trim();
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error('版本号须为 x.y.z 格式，如 1.0.0');
    raw.version = v;
  }
  if (description !== undefined) raw.description = String(description);
  return raw;
}

// ---------- 新建品类骨架（上一轮逻辑原样收编） ----------
// baseRaw：服装模板原始 JSON；name：新品类名；axisNames：1-3 个轴显示名（可为空 = 0 轴）。
// 返回新模板原始 JSON（未校验，调用方调 loadTemplate 校验后保存）。
export function createCategoryTemplate(baseRaw, name, axisNames) {
  const nm = String(name || '').trim();
  if (!nm) throw new Error('请先填新品类名（如：食品）');
  const axes = (axisNames || []).map((a) => String(a).trim()).filter(Boolean);
  if (axes.length > 3) throw new Error('规格轴最多 3 个');
  const copy = JSON.parse(JSON.stringify(baseRaw));
  const axisKeys = ['colors', 'sizes', 'patterns'];
  const usedKeys = axisKeys.slice(0, axes.length);
  copy.id = 'custom-' + Date.now().toString(36);
  copy.name = nm;
  copy.version = '1.0.0';
  copy.description = `${nm}类商品信息表模板：${axes.length ? axes.join(' × ') + '规格' : '无规格'}。出包为标准信息表，暂不能直接导入现有商城后台解析器。`;
  copy.specAxes = usedKeys;
  copy.specHeaders = [...axes, '库存'];
  copy.parserCompatible = false;
  copy.targetParser = 'none';
  copy.fields.forEach((f) => {
    const idx = usedKeys.indexOf(f.key);
    if (idx >= 0) f.names = [axes[idx], ...f.names.filter((n) => n !== axes[idx])];
  });
  copy.fields.forEach((f) => {
    if (axisKeys.includes(f.key) && !usedKeys.includes(f.key)) f.required = false;
  });
  copy.extraFields = [];
  copy.images.categories.forEach((c) => {
    if (!c.keyFrom) return;
    if (usedKeys.length === 0) { delete c.keyFrom; c.label = '配图'; c.naming = '配图{index}'; return; }
    c.keyFrom = usedKeys[0]; c.label = axes[0] + '图'; c.naming = axes[0] + '图-{key}';
  });
  return copy;
}
