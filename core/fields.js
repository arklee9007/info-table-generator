// fields.js —— 字段块解析与字段值归一化。
//
// 字段块格式（死规则，不猜）：
// · 字段由「字段词」认出。字段词出现即字段边界，两种情形：
//   (1) 行首（前面只有空白或 •·-* 这类项目符号）+ 字段词 + 冒号或空白；
//   (2) 任意位置 + 字段词 + 紧跟的冒号（半角 : 或全角 ：）。
//   同一位置最长字段词优先。字段词 + 冒号出现在描述文字里也会切分，使用时避免。
// · 字段值 = 两个字段边界之间的文字；无字段词的散句归入上一字段。
// · 款名类字段（模板 styleAnchor）每次出现即新开一款；第一款之前的字段归入第一款。
// · 列表字段（颜色/尺码/图案）用 顿号、逗号、斜杠、分号、空格、换行 任一分隔。
// · 库存：裸数字 = 全款统一数；「颜色/尺码/图案=数字」= 单个组合覆盖；两者可用顿号/逗号并列。
// · 标量字段重复出现取最后一次并记警告；列表字段重复出现合并去重并记警告。

import { getAnchorKey } from './template.js';

// 规格组合的规范键：各轴值用 \u001f 连接，值内空格不会撞键。
export function comboKey(parts) {
  return parts.join('\u001f');
}

export class FieldError extends Error {
  constructor(message, fieldKey, rawValue) {
    super(message);
    this.name = 'FieldError';
    this.fieldKey = fieldKey;
    this.rawValue = rawValue;
  }
}

const LINE_START_BULLETS = new Set(['•', '·', '-', '*', '—', '–', '◆', '◇', '■', '□', '●', '○', '、']);
const VALUE_EDGE_TRIM = /^[：:\s，,、；;]+|[，,、；;\s]+$/g;

function isLineStart(text, pos) {
  // pos 之前到行首只有空白或项目符号
  let i = pos - 1;
  while (i >= 0 && text[i] !== '\n') {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || LINE_START_BULLETS.has(ch)) { i--; continue; }
    return false;
  }
  return true;
}

// 扫描全部字段边界。返回 [{pos, end, key, word}]，按位置升序。
export function scanFieldMarkers(text, tpl) {
  const markers = [];
  const words = tpl._wordIndex; // 已按词长倒序
  let i = 0;
  while (i < text.length) {
    let matched = null;
    for (const w of words) {
      if (text.startsWith(w.word, i)) {
        const after = text[i + w.word.length];
        const hasColon = after === ':' || after === '：';
        const atLineStart = isLineStart(text, i);
        const afterIsSpace = after === ' ' || after === '\t' || after === '\n' || after === undefined;
        if (hasColon || (atLineStart && afterIsSpace)) {
          matched = { word: w.word, key: w.key, afterColon: hasColon };
          break; // 最长优先：wordIndex 已按长度倒序
        }
      }
    }
    if (matched) {
      let end = i + matched.word.length;
      if (matched.afterColon) end += 1;
      // 跳过冒号后的空白
      while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
      markers.push({ pos: i, end, key: matched.key, word: matched.word, atLineStart: isLineStart(text, i) });
      i = end;
    } else {
      i++;
    }
  }
  return markers;
}

// 把字段块文本切成原始记录：[{ key: [原始值字符串, ...] }]
// 同时记录每款起始行号（排错定位用），放在返回值的 lines 里。
export function parseFieldBlock(text, tpl) {
  const anchorKey = getAnchorKey(tpl);
  const markers = scanFieldMarkers(text, tpl);
  const records = [];
  const lines = [];
  let current = null;
  let currentLine = 0;
  const warnings = [];

  const lineOf = (pos) => text.slice(0, pos).split('\n').length;
  const newRecord = () => ({});
  let prevKey = null;
  for (let m = 0; m < markers.length; m++) {
    const mk = markers[m];
    // 描述（多行字段）里的“字段词 + 冒号”不在行首：很可能是在描述里被误切了，记警告不断解析
    if (!mk.atLineStart && prevKey) {
      const prevField = tpl.fields.find((x) => x.key === prevKey);
      if (prevField && prevField.multiline) {
        warnings.push(`第 ${lineOf(mk.pos)} 行：「${mk.word}：」不在行首，可能是在描述里被误切了；请改写描述或把这句移到「${mk.word}」字段`);
      }
    }
    prevKey = mk.key;
    const nextPos = m + 1 < markers.length ? markers[m + 1].pos : text.length;
    let raw = text.slice(mk.end, nextPos);
    raw = raw.replace(VALUE_EDGE_TRIM, '');
    if (!current) { current = newRecord(); currentLine = lineOf(mk.pos); }
    // 锚字段再次出现且当前记录已有锚值 -> 新开一款
    if (mk.key === anchorKey && current[anchorKey] && current[anchorKey].length > 0) {
      records.push(current);
      lines.push(currentLine);
      current = newRecord();
      currentLine = lineOf(mk.pos);
    }
    if (!current[mk.key]) current[mk.key] = [];
    current[mk.key].push(raw);
  }
  if (current && Object.keys(current).length > 0) { records.push(current); lines.push(currentLine); }

  // 无任何字段词：整体无法识别
  if (records.length === 0) {
    throw new FieldError(
      '没有认出任何字段词。请用字段块格式，例如：\n款名：重磅素色短袖\n价格：129\n颜色：本白、克莱因蓝',
      null,
      text.slice(0, 60)
    );
  }
  return { records, warnings, lines };
}

// ---------- 值归一化（字段块 / CSV / 表格行共用） ----------

function toText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function splitList(raw) {
  return toText(raw)
    .split(/[、，,／/；;\n]+/)
    .flatMap((tok) => tok.split(/\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizePrice(raw, fieldKey) {
  let s = toText(raw).trim();
  s = s.replace(/[\s¥￥元]/g, '').replace(/RMB/gi, '');
  // 千分位逗号：1,299 -> 1299
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new FieldError(`价格无法识别：「${toText(raw)}」。请写数字，如 129 或 129.50`, fieldKey, raw);
  }
  const n = Number(s);
  if (n > 1000000) throw new FieldError(`价格超出上限 1,000,000：${s}`, fieldKey, raw);
  return n;
}

export function normalizeFreight(raw, field, fieldKey) {
  const s = toText(raw).trim();
  const map = field.map;
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === s.toLowerCase()) return v;
  }
  const accepted = [...new Set(Object.keys(map))].join('、');
  throw new FieldError(`运费方式无法识别：「${s}」。只认：${accepted}`, fieldKey, raw);
}

export function normalizeStock(raw, tpl, fieldKey) {
  const s = toText(raw).trim();
  if (s === '') throw new FieldError('库存为空，请写数字，如 库存：100', fieldKey, raw);
  let def = null;
  const overrides = new Map();
  const axes = tpl.specAxes.length;
  for (const seg of s.split(/[、，,；;\n]+/).map((x) => x.trim()).filter(Boolean)) {
    if (/^\d+$/.test(seg)) {
      def = Number(seg);
      continue;
    }
    const m = seg.match(/^(.+?)[=＝](\d+)$/);
    if (!m) {
      throw new FieldError(
        `库存写法无法识别：「${seg}」。统一库存写数字；单个组合覆盖写「颜色/尺码/图案=数字」，如 本白/M/素色=50`,
        fieldKey,
        raw
      );
    }
    const parts = m[1].split(/[／/]/).map((x) => x.trim());
    if (parts.length !== axes || parts.some((p) => !p)) {
      throw new FieldError(`库存覆盖须写满 ${axes} 个规格，用 / 分隔：「${seg}」`, fieldKey, raw);
    }
    overrides.set(comboKey(parts), Number(m[2]));
  }
  if (def === null && overrides.size === 0) {
    throw new FieldError('库存为空，请写数字，如 库存：100', fieldKey, raw);
  }
  return { default: def, overrides };
}

export function sanitizeCode(raw, fieldKey) {
  // 款号：去掉路径分隔符与控制字符；解析器要求非空、≤80 字符、无斜杠
  let s = toText(raw).replace(/[\\/:*?"<>|]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  s = s.replace(/\s+/g, '-');
  if ([...s].length > 80) s = [...s].slice(0, 80).join('');
  if (!s) throw new FieldError('款号为空，请填写 款号：xxx', fieldKey, raw);
  return s;
}

export function normalizeNumber(raw, fieldKey) {
  const s = toText(raw).trim().replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new FieldError(`数字无法识别：「${toText(raw)}」。请写数字`, fieldKey, raw);
  }
  return Number(s);
}

export function normalizeDate(raw, fieldKey) {
  const s = toText(raw).trim();
  const m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日]?$/);
  if (!m) {
    throw new FieldError(`日期无法识别：「${toText(raw)}」。请写 YYYY-MM-DD，如 2027-06-30`, fieldKey, raw);
  }
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new FieldError(`日期不存在：「${toText(raw)}」`, fieldKey, raw);
  }
  return `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeExtraValue(ef, raw, fieldKey) {
  const type = ef.type || 'text';
  if (type === 'list') return splitList(raw);
  if (type === 'number') return normalizeNumber(raw, fieldKey);
  if (type === 'date') return normalizeDate(raw, fieldKey);
  if (type === 'enum') {
    const s = toText(raw).trim();
    if (!ef.options.includes(s)) {
      throw new FieldError(`「${ef.names[0]}」只认：${ef.options.join('、')}，现在是「${s}」`, fieldKey, raw);
    }
    return s;
  }
  return toText(raw).trim().replace(/\s+/g, ' ');
}

// 归一化一条原始记录。rawRecord: {key: [原始值...]} 或 {key: 单值}（表格行）。
// 返回 {fields, warnings}；字段值非法抛 FieldError。
// fields.extra: 扩展字段袋 {key: 值}，目标后台没有对应字段时照常出包、不整包失败。
export function normalizeRecord(rawRecord, tpl, styleLabel = '') {
  const fields = {};
  const warnings = [];
  const label = styleLabel ? `（${styleLabel}）` : '';

  for (const f of tpl.fields) {
    let raws = rawRecord[f.key];
    if (raws === undefined) continue;
    if (!Array.isArray(raws)) raws = [raws];
    raws = raws.map(toText).filter((s) => s.trim() !== '');
    if (raws.length === 0) continue;

    if (f.type === 'list') {
      const merged = [];
      for (const r of raws) merged.push(...splitList(r));
      const deduped = [...new Set(merged)];
      if (deduped.length < merged.length) warnings.push(`${label}「${f.names[0]}」有重复值，已去重`);
      if (raws.length > 1) warnings.push(`${label}「${f.names[0]}」出现多次，已合并`);
      fields[f.key] = deduped;
      continue;
    }
    if (raws.length > 1) warnings.push(`${label}「${f.names[0]}」出现多次，取最后一次`);
    const raw = raws[raws.length - 1];

    if (f.type === 'price') {
      fields[f.key] = normalizePrice(raw, f.key);
    } else if (f.type === 'freight') {
      fields[f.key] = normalizeFreight(raw, f, f.key);
    } else if (f.type === 'stock') {
      // 库存多行：合并处理（裸数字取最后一次，覆盖累加）
      let merged = { default: null, overrides: new Map() };
      for (const r of raws) {
        const part = normalizeStock(r, tpl, f.key);
        if (part.default !== null) merged.default = part.default;
        for (const [k, v] of part.overrides) merged.overrides.set(k, v);
      }
      fields[f.key] = merged;
    } else if (f.key === 'code') {
      fields[f.key] = sanitizeCode(raw, f.key);
    } else if (f.multiline) {
      fields[f.key] = raw.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
    } else {
      // 标量文本：连续空白压成一个空格再去首尾，不删空格（型号、品牌名带空格是合法值）
      fields[f.key] = raw.trim().replace(/\s+/g, ' ');
    }
  }

  // 扩展字段袋
  for (const ef of tpl.extraFields || []) {
    let raws = rawRecord[ef.key];
    if (raws === undefined) continue;
    if (!Array.isArray(raws)) raws = [raws];
    raws = raws.map(toText).filter((s) => s.trim() !== '');
    if (raws.length === 0) continue;
    if (raws.length > 1) warnings.push(`${label}「${ef.names[0]}」出现多次，取最后一次`);
    if (!fields.extra) fields.extra = {};
    fields.extra[ef.key] = normalizeExtraValue(ef, raws[raws.length - 1], ef.key);
  }

  // 款号默认取清洗后的款名
  if (!fields.code && fields.name) {
    fields.code = sanitizeCode(fields.name, 'code');
  }
  return { fields, warnings };
}

// 字段块文本 -> 归一化记录数组（每款一条）。非法值抛 FieldError（带款名上下文与行号）。
export function parseFieldText(text, tpl) {
  const { records, lines, warnings: blockWarnings } = parseFieldBlock(text, tpl);
  const out = [];
  const warnings = [...(blockWarnings || [])];
  for (let i = 0; i < records.length; i++) {
    const label = `第 ${i + 1} 款${lines && lines[i] ? `（第 ${lines[i]} 行附近）` : ''}`;
    try {
      const { fields, warnings: ws } = normalizeRecord(records[i], tpl, label);
      out.push({ fields, warnings: ws, sourceIndex: i });
      warnings.push(...ws);
    } catch (e) {
      if (e instanceof FieldError) {
        throw new FieldError(`${label}：${e.message}`, e.fieldKey, e.rawValue);
      }
      throw e;
    }
  }
  return { records: out, warnings };
}
