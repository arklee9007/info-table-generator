// validate.js —— 出包前校验：把解析器会拒绝的错在工具端先拦住。
// 规则与商城素材包解析器逐条对齐；校验只报错/警告，不改数据。

import { comboKey } from './fields.js';
import { probeImage } from './images.js';

// 轴显示名：用各轴字段的 names[0]，不用写死的“颜色/尺码/图案”。
export function axisDisplayNames(tpl) {
  return tpl.specAxes.map((k) => {
    const f = tpl.fields.find((x) => x.key === k);
    return f ? f.names[0] : k;
  });
}

// 笛卡尔积：轴序 = 模板 specAxes 顺序（颜色外层、尺码、图案内层），与样表行序一致。
export function buildCombos(fields, tpl) {
  const axes = tpl.specAxes.map((k) => fields[k] || []);
  let combos = [[]];
  for (const axis of axes) {
    const next = [];
    for (const prefix of combos) {
      for (const v of axis) next.push([...prefix, v]);
    }
    combos = next;
  }
  return combos;
}

// fields: normalizeRecord 的产物；images: [{bytes, category, colorKey, order, sourceName}]
// 返回 { errors: [中文], warnings: [中文], combos, comboStocks: Map }
export function validateStyle(fields, images, tpl) {
  const errors = [];
  const warnings = [];
  const label = fields.name ? `「${fields.name}」` : '本款';

  // ---- 字段 ----
  for (const f of tpl.fields) {
    const v = fields[f.key];
    // 未进规格轴的 list 字段（如 2 维模板里的第 3 轴）不强制必填：它不参与组合，填了也无用
    const isUnusedAxis = f.type === 'list' && !tpl.specAxes.includes(f.key);
    if (isUnusedAxis) continue;
    if (f.required && (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))) {
      errors.push(`${label}：缺「${f.names[0]}」，请补上`);
      continue;
    }
    if (v === undefined || v === null) continue;
    if (f.maxLen && typeof v === 'string' && v.length > f.maxLen) {
      errors.push(`${label}：${f.names[0]}超长（${v.length} 字，上限 ${f.maxLen} 字）`);
    }
    if (f.type === 'list') {
      for (const item of v) {
        if (f.itemMaxLen && item.length > f.itemMaxLen) {
          errors.push(`${label}：${f.names[0]}「${item}」超长（${item.length} 字，上限 ${f.itemMaxLen} 字）`);
        }
      }
    }
    if (f.type === 'stock') {
      // 统一数缺失不直接报错：只要每个组合都有覆盖值就放行（见组合段复核）
      if (v.default !== null && v.default !== undefined && (!Number.isInteger(v.default) || v.default < 0)) {
        errors.push(`${label}：库存统一数须为非负整数`);
      }
    }
  }
  if (fields.price !== undefined && (typeof fields.price !== 'number' || !Number.isFinite(fields.price) || fields.price < 0 || fields.price > tpl.limits.maxPrice)) {
    errors.push(`${label}：价格无效`);
  }
  if (fields.code !== undefined && (fields.code.length === 0 || fields.code.length > 80 || /[/\\]/.test(fields.code))) {
    errors.push(`${label}：款号无效（须 1–80 字，不能含斜杠）`);
  }
  // 扩展字段袋
  for (const ef of tpl.extraFields || []) {
    const v = fields.extra ? fields.extra[ef.key] : undefined;
    if (ef.required && (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0))) {
      errors.push(`${label}：缺「${ef.names[0]}」，请补上`);
      continue;
    }
    if (v === undefined || v === null) continue;
    if (ef.maxLen && typeof v === 'string' && v.length > ef.maxLen) {
      errors.push(`${label}：${ef.names[0]}超长（${v.length} 字，上限 ${ef.maxLen} 字）`);
    }
    if (ef.type === 'enum' && !ef.options.includes(v)) {
      errors.push(`${label}：${ef.names[0]}只认 ${ef.options.join('、')}`);
    }
    if (ef.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) {
      errors.push(`${label}：${ef.names[0]}须为数字`);
    }
  }
  // 描述里出现“字段词 + 冒号”很可能是被误切：只警告，不拦截
  if (typeof fields.desc === 'string' && fields.desc) {
    for (const w of tpl._wordIndex || []) {
      if (fields.desc.includes(w.word + ':') || fields.desc.includes(w.word + '：')) {
        warnings.push(`${label}：描述里出现「${w.word}：」，可能被当成字段切分了；请改写描述或把这句移到对应字段`);
        break;
      }
    }
  }

  // ---- 规格组合 ----
  const combos = buildCombos(fields, tpl);
  const axisNames = axisDisplayNames(tpl);
  if (tpl.specAxes.length === 0) {
    if (!(combos.length === 1 && combos[0].length === 0)) {
      errors.push(`${label}：无规格款的组合异常`);
    }
  } else if (combos.length === 0 || combos.some((c) => c.length !== tpl.specAxes.length)) {
    errors.push(`${label}：规格不完整，${axisNames.join('/')}缺一不可`);
  }
  if (combos.length > tpl.limits.maxCombos) {
    errors.push(`${label}：规格组合 ${combos.length} 个，超出上限 ${tpl.limits.maxCombos} 个，请减少颜色/尺码/图案`);
  }
  const seen = new Set();
  for (const c of combos) {
    const k = comboKey(c);
    if (seen.has(k)) errors.push(`${label}：规格组合重复：${c.join('/')}`);
    seen.add(k);
  }
  // 库存覆盖须指向真实存在的组合；缺统一数时每个组合都须有覆盖
  const comboStocks = new Map();
  const stock = fields.stock;
  if (stock) {
    for (const c of combos) {
      const k = comboKey(c);
      comboStocks.set(k, stock.overrides.has(k) ? stock.overrides.get(k) : stock.default);
    }
    if (stock.default === null || stock.default === undefined) {
      const missing = combos.filter((c) => !stock.overrides.has(comboKey(c)));
      if (missing.length) {
        const shown = missing.slice(0, 3).map((c) => c.join('/') || '(无规格)').join('、');
        errors.push(`${label}：库存缺统一数，且以下组合没有覆盖库存：${shown}${missing.length > 3 ? ` 等 ${missing.length} 个` : ''}；请写统一数或补齐覆盖`);
      }
    }
    for (const k of stock.overrides.keys()) {
      if (!seen.has(k)) {
        errors.push(`${label}：库存覆盖指向不存在的组合：${k.split('\u001f').join('/')}，请核对${axisNames.join('/')} `);
      }
    }
  }

  // ---- 图片 ----
  const imgs = images || [];
  const byCategory = {};
  for (const im of imgs) {
    if (!byCategory[im.category]) byCategory[im.category] = [];
    byCategory[im.category].push(im);
  }
  const cats = Object.fromEntries(tpl.images.categories.map((c) => [c.key, c]));
  for (const c of tpl.images.categories) {
    const list = byCategory[c.key] || [];
    if (c.required && list.length === 0) {
      errors.push(`${label}：缺${c.label}，请至少指定一张`);
    }
    if (c.maxCount && list.length > c.maxCount) {
      errors.push(`${label}：${c.label}最多 ${c.maxCount} 张，现有 ${list.length} 张`);
    }
  }
  if (imgs.length > tpl.images.maxImages) {
    errors.push(`${label}：图片共 ${imgs.length} 张，超出上限 ${tpl.images.maxImages} 张`);
  }
  // 带 keyFrom 的图片类别（如颜色图/口味图/款式图）：须对应真实轴值、同值一张
  // keyFrom 指向哪个轴字段就按哪个轴校验，不写死 colors
  for (const c of tpl.images.categories) {
    if (!c.keyFrom) continue;
    const axisValues = fields[c.keyFrom] || [];
    const keyedImgs = (byCategory[c.key] || []);
    const usedKeys = new Set();
    for (const im of keyedImgs) {
      const axisLabel = (tpl.fields.find((x) => x.key === c.keyFrom) || {}).names?.[0] || c.keyFrom;
      if (!im.colorKey) { errors.push(`${label}：有张${c.label}没指明对应哪个${axisLabel}`); continue; }
      if (!axisValues.includes(im.colorKey)) {
        errors.push(`${label}：${c.label}对应「${im.colorKey}」，但${axisLabel}列表里没有这个值`);
      }
      if (usedKeys.has(im.colorKey)) errors.push(`${label}：「${im.colorKey}」有两张${c.label}，只能一张`);
      usedKeys.add(im.colorKey);
    }
    const missingKeyed = axisValues.filter((v) => !usedKeys.has(v));
    if (missingKeyed.length > 0) warnings.push(`${label}：${missingKeyed.join('、')} 没有${c.label}，后台会警告但不拒绝`);
  }
  // 每张图：格式与像素
  for (const im of imgs) {
    const probe = probeImage(im.bytes);
    const disp = im.sourceName || '图片';
    if (!probe.format) {
      errors.push(`${label}：${disp} 无法识别（${probe.reason}）`);
      continue;
    }
    if (!tpl.images.accept.includes(probe.format)) {
      errors.push(`${label}：${disp} 是 ${probe.format.toUpperCase()} 格式，只接受 ${tpl.images.accept.join('/').toUpperCase()}`);
      continue;
    }
    if (probe.width === null) {
      errors.push(`${label}：${disp} 读不出像素尺寸（${probe.reason}）`);
      continue;
    }
    const pixels = probe.width * probe.height;
    if (pixels > tpl.images.maxPixels) {
      errors.push(`${label}：${disp} ${probe.width}×${probe.height}（${(pixels / 1e6).toFixed(1)} 百万像素），超出 400 万像素上限，请压缩`);
    }
    if (im.bytes.length > 2 * 1024 * 1024) {
      warnings.push(`${label}：${disp} 单张 ${(im.bytes.length / 1024 / 1024).toFixed(1)} MB，整包限 2 MB，出包后若超限需压缩图片`);
    }
  }
  // 警告（后台只警告不拒绝的项）
  if ((byCategory.detail || []).length === 0) warnings.push(`${label}：没有详情图，后台会警告但不拒绝`);

  return { errors, warnings, combos, comboStocks };
}
