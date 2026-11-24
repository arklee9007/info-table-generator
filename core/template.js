// template.js —— 模板定义校验与字段索引。
// 一个模板 = 三件套：①样表结构（表头/规格区位置）②字段规格（字段词/必填/取值规则）③图片规则（类别/命名/上限）。
// v1.1 新增可选件：extraFields（扩展字段袋）、parserCompatible / targetParser（目标解析器标识）。
// 模板以小文件形式进出；版本化，新旧并存不覆盖。校验失败直接报错，不猜。
// 规格轴 0-3 维；字段身份以 key 为准，不以名字为准（同义词只影响显示与识别）。

const REQUIRED_TOP = ['id', 'name', 'version', 'sheetName', 'headerRow1', 'specHeaderRow', 'specHeaders', 'fields', 'specAxes', 'images', 'limits'];

const EXTRA_TYPES = ['text', 'number', 'date', 'enum', 'list'];

export function validateTemplate(tpl) {
  const errors = [];
  if (!tpl || typeof tpl !== 'object' || Array.isArray(tpl)) {
    return ['模板不是一个对象'];
  }
  for (const k of REQUIRED_TOP) {
    if (tpl[k] === undefined) errors.push(`模板缺字段：${k}`);
  }
  if (errors.length) return errors;
  if (typeof tpl.id !== 'string' || !tpl.id.trim()) errors.push('模板 id 须为非空字符串');
  if (typeof tpl.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(tpl.version)) errors.push('模板 version 须为 x.y.z 格式');
  if (!Array.isArray(tpl.headerRow1) || tpl.headerRow1.length < 2) errors.push('headerRow1 须为至少 2 列的数组');
  if (!Array.isArray(tpl.specHeaders) || tpl.specHeaders.length < 1) errors.push('specHeaders 须为至少 1 列的数组');
  if (!Number.isInteger(tpl.specHeaderRow) || tpl.specHeaderRow < 2) errors.push('specHeaderRow 须为 ≥2 的整数');
  if (!Array.isArray(tpl.fields) || !tpl.fields.length) errors.push('fields 须为非空数组');

  const seenKeys = new Set();
  const seenNames = new Map(); // 字段词 -> key，字段词不许跨字段重复
  for (const f of tpl.fields || []) {
    if (!f.key || typeof f.key !== 'string') { errors.push('字段缺 key'); continue; }
    if (seenKeys.has(f.key)) errors.push(`字段 key 重复：${f.key}`);
    seenKeys.add(f.key);
    if (!Array.isArray(f.names) || !f.names.length) { errors.push(`字段 ${f.key} 缺 names`); continue; }
    for (const n of f.names) {
      if (seenNames.has(n) && seenNames.get(n) !== f.key) {
        errors.push(`字段词「${n}」同时属于 ${seenNames.get(n)} 与 ${f.key}，须唯一`);
      }
      seenNames.set(n, f.key);
    }
    if (f.type === 'freight' && (!f.map || typeof f.map !== 'object')) errors.push(`字段 ${f.key} 为 freight 类型但缺 map`);
  }
  const anchors = (tpl.fields || []).filter((f) => f.styleAnchor);
  if (anchors.length !== 1) errors.push('模板须恰好指定一个 styleAnchor 字段（新款的起始字段）');
  if (!Array.isArray(tpl.specAxes) || tpl.specAxes.length > 3) errors.push('specAxes 须为 0-3 个元素的数组');
  for (const ax of tpl.specAxes || []) {
    const f = (tpl.fields || []).find((x) => x.key === ax);
    if (!f) errors.push(`specAxes 引用了不存在的字段：${ax}`);
    else if (f.type !== 'list') errors.push(`规格轴 ${ax} 须为 list 类型字段`);
  }
  if (Array.isArray(tpl.specHeaders) && Array.isArray(tpl.specAxes)
    && tpl.specHeaders.length !== tpl.specAxes.length + 1) {
    errors.push(`specHeaders 须为 ${tpl.specAxes.length + 1} 列（规格轴数 + 库存列），现有 ${tpl.specHeaders.length} 列`);
  }
  // 扩展字段袋：key 不许与主字段重复，字段词全局唯一，类型受限
  if (tpl.extraFields !== undefined) {
    if (!Array.isArray(tpl.extraFields)) errors.push('extraFields 须为数组');
    for (const ef of tpl.extraFields || []) {
      if (!ef.key || typeof ef.key !== 'string') { errors.push('扩展字段缺 key'); continue; }
      if (seenKeys.has(ef.key)) errors.push(`扩展字段 key 与主字段重复：${ef.key}`);
      seenKeys.add(ef.key);
      if (!Array.isArray(ef.names) || !ef.names.length) { errors.push(`扩展字段 ${ef.key} 缺 names`); continue; }
      for (const n of ef.names) {
        if (seenNames.has(n) && seenNames.get(n) !== ef.key) {
          errors.push(`字段词「${n}」同时属于 ${seenNames.get(n)} 与 ${ef.key}，须唯一`);
        }
        seenNames.set(n, ef.key);
      }
      if (!EXTRA_TYPES.includes(ef.type || 'text')) errors.push(`扩展字段 ${ef.key} 的类型须为 ${EXTRA_TYPES.join('/')} 之一`);
      if (ef.type === 'enum' && (!Array.isArray(ef.options) || !ef.options.length)) errors.push(`扩展字段 ${ef.key} 为 enum 类型但缺 options`);
    }
  }
  // 描述长度上限须一致：字段 maxLen 为准，limits.maxDescLen 只作兼容复核
  const descField = (tpl.fields || []).find((f) => f.key === 'desc');
  if (descField && descField.maxLen !== undefined && tpl.limits && tpl.limits.maxDescLen !== undefined
    && descField.maxLen !== tpl.limits.maxDescLen) {
    errors.push(`描述长度上限不一致：字段 maxLen=${descField.maxLen}，limits.maxDescLen=${tpl.limits.maxDescLen}`);
  }
  if (tpl.parserCompatible !== undefined && typeof tpl.parserCompatible !== 'boolean') {
    errors.push('parserCompatible 须为布尔值');
  }
  if (!tpl.images || !Array.isArray(tpl.images.categories) || !tpl.images.categories.length) {
    errors.push('images.categories 须为非空数组');
  } else {
    for (const c of tpl.images.categories) {
      if (!c.key || !c.naming) errors.push('图片类别缺 key 或 naming');
      if (c.keyFrom && !seenKeys.has(c.keyFrom)) errors.push(`图片类别 ${c.key} 的 keyFrom 引用了不存在的字段：${c.keyFrom}`);
      if (c.keyFrom) {
        const kf = (tpl.fields || []).find((x) => x.key === c.keyFrom);
        if (kf && kf.type !== 'list') errors.push(`图片类别 ${c.key} 的 keyFrom 字段 ${c.keyFrom} 须为 list 类型`);
        if (c.keyFrom && !String(c.naming).includes('{key}')) errors.push(`图片类别 ${c.key} 有 keyFrom 但 naming 里没有 {key} 占位`);
      }
    }
  }
  if (!tpl.limits || !Number.isInteger(tpl.limits.maxCombos) || tpl.limits.maxCombos < 1) errors.push('limits.maxCombos 须为正整数');
  if (!tpl.limits || !Number.isInteger(tpl.limits.maxZipBytes) || tpl.limits.maxZipBytes < 1) errors.push('limits.maxZipBytes 须为正整数');
  return errors;
}

// 校验通过返回同一对象（附带构建好的字段词索引）；失败抛错。
export function loadTemplate(tpl) {
  const errors = validateTemplate(tpl);
  if (errors.length) {
    throw new Error('模板无效：\n' + errors.map((e) => '· ' + e).join('\n'));
  }
  // 字段词索引：按词长倒序，识别时最长匹配优先（含扩展字段）
  const wordIndex = [];
  for (const f of [...tpl.fields, ...(tpl.extraFields || [])]) {
    for (const n of f.names) wordIndex.push({ word: n, key: f.key, field: f });
  }
  wordIndex.sort((a, b) => b.word.length - a.word.length);
  return { ...tpl, _wordIndex: wordIndex };
}

export function getField(tpl, key) {
  return tpl.fields.find((f) => f.key === key);
}

export function getAnchorKey(tpl) {
  return tpl.fields.find((f) => f.styleAnchor).key;
}
