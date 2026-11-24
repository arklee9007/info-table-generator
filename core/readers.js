// readers.js —— 各类输入文件的读取：txt/md/csv/xlsx/xls/docx。
// 输出统一为「原始记录」({key: 值})，再由 fields.normalizeRecord 归一化。
// 识别规则全部写死，不猜：
// · txt/md：当字段块文本解析（md 先去标记）。
// · csv：首行为表头（须含字段词），每行一款。
// · xlsx/xls：首表；先判是否信息表格式（第 1 行=表头，第 4 行=规格表头），是则按信息表解析；
//   否则按表头行解析。两种都不像 -> 报错，指引走字段块或 AI 拆解前门。
// · docx：抽段落文本，按字段块解析。

import { getXLSX, getFflate } from './deps.js';
import { FieldError, normalizeRecord, parseFieldText } from './fields.js';
import { decodeText, normalizeNewlines } from './decode.js';

// ---------- CSV ----------
// 分隔符自探测：首行里逗号/分号/制表符哪个多用哪个（供应商表常用分号）
export function detectCsvDelimiter(firstLine) {
  const counts = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}
export function parseCsv(text, delimiter) {
  const delim = delimiter || detectCsvDelimiter(normalizeNewlines(text).split('\n')[0] || '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = normalizeNewlines(text);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      if (field === '') inQuotes = true;
      else field += ch;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- Markdown ----------
export function stripMarkdown(text) {
  const out = [];
  let inFence = false;
  for (const line of normalizeNewlines(text).split('\n')) {
    const t = line.trim();
    if (/^```/.test(t)) { inFence = !inFence; continue; }
    if (inFence) { out.push(line); continue; }
    let l = line;
    l = l.replace(/^#{1,6}\s+/, '');           // 标题
    l = l.replace(/^\s*([-*+]|\d+[.)、])\s+/, ''); // 列表符
    l = l.replace(/^\s*>\s?/, '');              // 引用
    if (/^\s*\|/.test(l)) l = l.replace(/\|/g, ' '); // 表格行：竖线当分隔
    l = l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');   // 链接取文字
    l = l.replace(/(\*\*|__)(.*?)\1/g, '$2');   // 粗体
    l = l.replace(/(\*|_)(.*?)\1/g, '$2');      // 斜体
    l = l.replace(/`([^`]*)`/g, '$1');          // 行内代码
    l = l.replace(/^[-:|\s]+$/, '');            // 表格分隔行
    out.push(l);
  }
  return out.join('\n');
}

// ---------- DOCX ----------
export function extractDocxText(zipBytes, fflate) {
  const unzipped = fflate.unzipSync(zipBytes);
  const names = Object.keys(unzipped);
  const docName = names.find((n) => n === 'word/document.xml');
  if (!docName) throw new FieldError('docx 里没有 word/document.xml，文件可能已损坏', null, null);
  const xml = new TextDecoder('utf-8').decode(unzipped[docName]);
  // 段落：按 </w:p> 切；段内取全部 <w:t> 文本；单元格边界当分隔
  const paras = [];
  for (const chunk of xml.split('</w:p>')) {
    const withCells = chunk.replace(/<\/w:tc>/g, '\t');
    const texts = [];
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let m;
    while ((m = re.exec(withCells)) !== null) texts.push(m[1]);
    const line = texts.join('').replace(/<w:tab\/>/g, ' ').trim();
    if (line) paras.push(line);
  }
  return paras.join('\n');
}

// ---------- 表格行（CSV / XLSX 共用） ----------

// 表头归一化：去空白、全角转半角、英文大小写不敏感（G5：供应商表头叫法不一也能认）
export function normalizeHeader(s) {
  return String(s ?? '')
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// 表头映射：表头单元格与字段词归一化后匹配；key 本身也认。返回 {colIndex: key}。
function mapHeaders(headerRow, tpl) {
  const map = new Map();
  const allFields = [...tpl.fields, ...(tpl.extraFields || [])];
  headerRow.forEach((cell, idx) => {
    const h = normalizeHeader(cell);
    if (!h) return;
    for (const f of allFields) {
      if (f.key === h || f.names.some((n) => normalizeHeader(n) === h)) { map.set(idx, f.key); return; }
    }
  });
  return map;
}

function rowsToRecords(rows, tpl, label) {
  if (rows.length < 2) {
    throw new FieldError(`${label}：只有表头没有数据行`, null, null);
  }
  const headerMap = mapHeaders(rows[0], tpl);
  if (headerMap.size === 0) {
    throw new FieldError(
      `${label}：首行没有认出字段词。请确认首行是字段名（如 款名、价格、颜色），或改用字段块文本；供应商货单请走 AI 拆解前门。`,
      null, null
    );
  }
  const records = [];
  const warnings = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.every((c) => c === null || c === undefined || String(c).trim() === '')) continue;
    const raw = {};
    for (const [idx, key] of headerMap) {
      const v = row[idx];
      if (v === null || v === undefined || String(v).trim() === '') continue;
      raw[key] = v;
    }
    if (Object.keys(raw).length === 0) continue;
    try {
      const { fields, warnings: ws } = normalizeRecord(raw, tpl, `第 ${r} 行`);
      records.push({ fields, warnings: ws, sourceIndex: r });
      warnings.push(...ws);
    } catch (e) {
      if (e instanceof FieldError) throw new FieldError(`${label}第 ${r} 行：${e.message}`, e.fieldKey, e.rawValue);
      throw e;
    }
  }
  if (records.length === 0) throw new FieldError(`${label}：没有读到有效数据行`, null, null);
  return { records, warnings };
}

// 信息表格式判定：行1 == headerRow1 且行4 == specHeaders（表头归一化后比对）
function looksLikeInfoTable(rows, tpl) {
  const rowText = (row) => (row || []).map((c) => normalizeHeader(c));
  const r1 = rowText(rows[0]);
  const r4 = rowText(rows[tpl.specHeaderRow - 1]);
  const eq = (a, b) => a.length >= b.length && b.every((v, i) => a[i] === normalizeHeader(v));
  return eq(r1, tpl.headerRow1) && eq(r4, tpl.specHeaders);
}

function infoTableToRecord(rows, tpl) {
  // 行2：商品行——按行1表头名找列（不按固定位置，G18）；行5起：规格组合行，按轴数取列
  const headerRow = rows[0] || [];
  const prod = rows[1] || [];
  const cellStr = (row, i) => {
    const v = row[i];
    return v === null || v === undefined ? '' : String(v).trim();
  };
  const raw = {};
  // 主字段 + 扩展字段：按行1全部表头名取商品行（不只 headerRow1，追加的扩展列也读回）
  const allFields = [...tpl.fields, ...(tpl.extraFields || [])];
  headerRow.forEach((hCell, idx) => {
    const f = allFields.find((x) => x.names.some((n) => normalizeHeader(n) === normalizeHeader(hCell)));
    if (!f) return;
    const v = prod[idx];
    if (v === null || v === undefined || String(v).trim() === '') return;
    raw[f.key] = v;
  });
  const nAxes = tpl.specAxes.length;
  const axisVals = tpl.specAxes.map(() => []);
  const stocks = [];
  for (let r = tpl.specHeaderRow; r < rows.length; r++) {
    const row = rows[r] || [];
    const combo = tpl.specAxes.map((_, j) => cellStr(row, j));
    // 0 维：规格区每行只有库存数，空行跳过；有轴时全空行跳过
    if (nAxes === 0) {
      if (row[0] === null || row[0] === undefined || String(row[0]).trim() === '') continue;
    } else if (combo.every((v) => !v)) continue;
    combo.forEach((v, j) => axisVals[j].push(v));
    stocks.push({ combo, stock: row[nAxes] });
  }
  tpl.specAxes.forEach((ax, j) => {
    raw[ax] = [...new Set(axisVals[j])].join('、');
  });
  // 库存：出现次数最多的值作统一默认数（用户当初写的统一数必占多数），其余作覆盖；
  // 次数相同取先出现的。如此往返读写不翻转默认/覆盖。
  const stockNums = stocks.map((x) => Number(x.stock));
  if (stockNums.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new FieldError('信息表：规格区库存须为非负整数', 'stock', null);
  }
  if (stockNums.length === 0) {
    throw new FieldError('信息表：规格区没有数据行', 'stock', null);
  }
  const freq = new Map();
  for (const n of stockNums) freq.set(n, (freq.get(n) || 0) + 1);
  let def = stockNums[0];
  for (const n of stockNums) {
    if (freq.get(n) > freq.get(def)) def = n;
  }
  const segs = [String(def)];
  stocks.forEach((x) => {
    if (x.stock !== def) segs.push(`${x.combo.join('/')}=${x.stock}`);
  });
  raw.stock = segs.join('、');
  const { fields, warnings } = normalizeRecord(raw, tpl, '信息表');
  return { records: [{ fields, warnings, sourceIndex: 0 }], warnings };
}

// ---------- 统一入口 ----------
// file: { name, bytes: Uint8Array }。返回 { records, warnings, kind }。
// opts.sheet：xlsx 多表选择——表名（字符串）或下标（数字，0 起）；不填默认首表。
// 多表文件不指定时仍读首表（老行为不变），界面层用 listXlsxSheets 另行取表名供买家选。
export function listXlsxSheets(bytes) {
  return getXLSX().then((XLSX) => {
    const wb = XLSX.read(bytes, { type: 'array', dense: true });
    return [...wb.SheetNames];
  });
}

export async function parseFileInput(file, tpl, opts = {}) {
  const name = file.name || '';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const bytes = file.bytes;

  if (ext === 'txt') {
    const { text } = decodeText(bytes);
    const r = parseFieldText(normalizeNewlines(text), tpl);
    return { ...r, kind: 'field-block' };
  }
  if (ext === 'md' || ext === 'markdown') {
    const { text } = decodeText(bytes);
    const r = parseFieldText(stripMarkdown(text), tpl);
    return { ...r, kind: 'field-block' };
  }
  if (ext === 'csv') {
    const { text } = decodeText(bytes);
    const rows = parseCsv(text);
    const r = rowsToRecords(rows, tpl, 'CSV');
    return { ...r, kind: 'table' };
  }
  if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = await getXLSX();
    const wb = XLSX.read(bytes, { type: 'array', dense: true });
    let sheetName = wb.SheetNames[0];
    if (opts.sheet !== undefined && opts.sheet !== null) {
      if (typeof opts.sheet === 'number') {
        if (!Number.isInteger(opts.sheet) || opts.sheet < 0 || opts.sheet >= wb.SheetNames.length) {
          throw new FieldError(`表格没有第 ${opts.sheet + 1} 张表（共 ${wb.SheetNames.length} 张：${wb.SheetNames.join('、')}）`, null, name);
        }
        sheetName = wb.SheetNames[opts.sheet];
      } else {
        if (!wb.SheetNames.includes(opts.sheet)) {
          throw new FieldError(`表格里没有「${opts.sheet}」这张表（现有：${wb.SheetNames.join('、')}）`, null, name);
        }
        sheetName = opts.sheet;
      }
    }
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, blankrows: true, raw: true });
    if (looksLikeInfoTable(rows, tpl)) {
      const r = infoTableToRecord(rows, tpl);
      return { ...r, kind: 'info-table', sheets: [...wb.SheetNames], sheet: sheetName };
    }
    const r = rowsToRecords(rows, tpl, '表格');
    return { ...r, kind: 'table', sheets: [...wb.SheetNames], sheet: sheetName };
  }
  if (ext === 'docx') {
    const fflate = await getFflate();
    const text = extractDocxText(bytes, fflate);
    const r = parseFieldText(normalizeNewlines(text), tpl);
    return { ...r, kind: 'field-block' };
  }
  if (ext === 'json') {
    const { text } = decodeText(bytes);
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new FieldError('JSON 解析失败：文件不是合法 JSON', null, name);
    }
    const items = Array.isArray(data) ? data : data.records;
    if (!Array.isArray(items) || items.length === 0) {
      throw new FieldError('JSON 里没有记录：请用数组，或 {records:[...]}，每条一条商品', null, name);
    }
    const allFields = [...tpl.fields, ...(tpl.extraFields || [])];
    const records = [];
    const warnings = [];
    items.forEach((item, i) => {
      if (!item || typeof item !== 'object') throw new FieldError(`JSON 第 ${i + 1} 条不是对象`, null, null);
      const raw = {};
      for (const [k, v] of Object.entries(item)) {
        const f = allFields.find((x) => x.key === k || x.names.includes(k));
        if (f) raw[f.key] = v;
      }
      // 库存覆盖写成对象时转回字段块写法：{default:100, overrides:{"a/b/c":50}}
      if (raw.stock && typeof raw.stock === 'object' && !Array.isArray(raw.stock)) {
        const segs = [];
        if (raw.stock.default !== undefined && raw.stock.default !== null) segs.push(String(raw.stock.default));
        for (const [ck, sv] of Object.entries(raw.stock.overrides || {})) segs.push(`${ck}=${sv}`);
        raw.stock = segs.join('、');
      }
      try {
        const { fields, warnings: ws } = normalizeRecord(raw, tpl, `第 ${i + 1} 条`);
        records.push({ fields, warnings: ws, sourceIndex: i });
        warnings.push(...ws);
      } catch (e) {
        if (e instanceof FieldError) throw new FieldError(`JSON 第 ${i + 1} 条：${e.message}`, e.fieldKey, e.rawValue);
        throw e;
      }
    });
    return { records, warnings, kind: 'json' };
  }
  throw new FieldError(`不支持的文件类型：.${ext || '(无后缀)'}。支持 txt、md、csv、xlsx、xls、docx、json`, null, name);
}

// 粘贴文本入口
export async function parsePastedText(text, tpl) {
  const { parseFieldText } = await import('./fields.js');
  const r = parseFieldText(normalizeNewlines(text), tpl);
  return { ...r, kind: 'field-block' };
}
