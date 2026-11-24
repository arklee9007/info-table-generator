// xlsx-write.js —— 最小 OOXML 工作簿生成器：只产解析器要求的单工作表结构。
// 不用 SheetJS 写出：手写 XML 保证确定性（无公式、无 DOCTYPE、无共享字符串表），
// 静态部件（styles/theme）直接取样表原样。输出经真解析器验收。

import { getFflate } from './deps.js';
import { STYLES_XML, THEME_XML } from './ooxml-parts.js';
import { comboKey } from './fields.js';

function escapeXml(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '') // XML 1.0 非法控制字符
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function colName(idx) {
  // 1-based -> A, B, ... Z, AA...
  let n = idx;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function strCell(ref, value) {
  return `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function numCell(ref, value) {
  return `<c r="${ref}" t="n"><v>${value}</v></c>`;
}

// rows: [{row: 行号, cells: [{col, type: 's'|'n', value}]}]
function buildSheetXml({ sheetName, rows, lastRow, lastCol }) {
  const cols = [];
  for (let i = 1; i <= lastCol; i++) {
    cols.push(`<col width="20" customWidth="1" min="${i}" max="${i}"/>`);
  }
  const rowXml = rows.map(({ row, cells }) => {
    const inner = cells.map((c) => {
      const ref = colName(c.col) + row;
      return c.type === 'n' ? numCell(ref, c.value) : strCell(ref, c.value);
    }).join('');
    return `<row r="${row}">${inner}</row>`;
  }).join('');
  return `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/><pageSetUpPr/></sheetPr><dimension ref="A1:${colName(lastCol)}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews><sheetFormatPr baseColWidth="8" defaultRowHeight="15"/><cols>${cols.join('')}</cols><sheetData>${rowXml}</sheetData><pageMargins left="0.75" right="0.75" top="1" bottom="1" header="0.5" footer="0.5"/></worksheet>`;
}

const CONTENT_TYPES = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;

const RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml" Id="rId1"/></Relationships>`;

const WORKBOOK_RELS = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet1.xml" Id="rId1"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml" Id="rId2"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml" Id="rId3"/></Relationships>`;

function buildWorkbookXml(sheetName) {
  return `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><workbookPr/><workbookProtection/><bookViews><workbookView visibility="visible" minimized="0" showHorizontalScroll="1" showVerticalScroll="1" showSheetTabs="1" tabRatio="600" firstSheet="0" activeTab="0" autoFilterDateGrouping="1"/></bookViews><sheets><sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="${escapeXml(sheetName)}" sheetId="1" state="visible" r:id="rId1"/></sheets><definedNames/><calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>`;
}

// 生成信息表 xlsx：fields 为归一化记录，combos 为规格组合数组，comboStocks 为组合键->库存。
// 商品行按 headerRow1 的表头名找字段（不按列位置，G18）；扩展字段写进同名扩展列。
// 返回 Uint8Array。
export async function buildInfoTableXlsx(fields, combos, comboStocks, tpl) {
  const fflate = await getFflate();
  const enc = new TextEncoder();
  const headerRow = tpl.headerRow1;
  const specRow = tpl.specHeaderRow;
  const lastRow = specRow + combos.length;
  // 表头名 -> 取值：主字段按 names 匹配，扩展字段按 extraFields 的 names 匹配
  const valueForHeader = (h) => {
    for (const f of tpl.fields) {
      if (f.names.includes(h)) {
        if (f.key === 'price') return { type: 'n', value: fields.price };
        const v = fields[f.key];
        if (v === undefined || v === null) return { type: 's', value: '' };
        if (Array.isArray(v)) return { type: 's', value: v.join('、') };
        return { type: 's', value: String(v) };
      }
    }
    for (const ef of tpl.extraFields || []) {
      if (ef.names.includes(h)) {
        const v = fields.extra ? fields.extra[ef.key] : undefined;
        if (v === undefined || v === null) return { type: 's', value: '' };
        if (Array.isArray(v)) return { type: 's', value: v.join('、') };
        if (typeof v === 'number') return { type: 'n', value: v };
        return { type: 's', value: String(v) };
      }
    }
    return { type: 's', value: '' };
  };

  const rows = [];
  // 第 1 行：表头。扩展字段里没进 headerRow1 的，自动追加一列（否则出包即丢，读回也丢）。
  // 同理：款号与买家自加的标量字段不在 headerRow1 时也追加一列——生产解析器只读 A–E 列，
  // 追加列不影响解析器验收（A1 已复验），但本工具读回时能找回显式款号（R4）。
  // 轴字段与库存不进商品行（它们走规格区）。
  const effectiveHeader = [...headerRow];
  for (const f of tpl.fields) {
    if (f.type === 'list' || f.type === 'stock') continue;
    if (tpl.specAxes.includes(f.key)) continue;
    if (effectiveHeader.some((h) => f.names.includes(h))) continue;
    effectiveHeader.push(f.names[0]);
  }
  for (const ef of tpl.extraFields || []) {
    if (!effectiveHeader.some((h) => ef.names.includes(h))) effectiveHeader.push(ef.names[0]);
  }
  const effLastCol = Math.max(effectiveHeader.length, tpl.specHeaders.length);
  rows.push({ row: 1, cells: effectiveHeader.map((h, i) => ({ col: i + 1, type: 's', value: h })) });
  // 第 2 行：商品行（列序与表头对应）
  const prodCells = effectiveHeader.map((h, i) => ({ col: i + 1, ...valueForHeader(h) }));
  rows.push({ row: 2, cells: prodCells });
  // 第 3 行留空（与样表一致，直接省略）
  // 第 4 行：规格表头
  rows.push({ row: specRow, cells: tpl.specHeaders.map((h, i) => ({ col: i + 1, type: 's', value: h })) });
  // 第 5 行起：组合行
  combos.forEach((combo, i) => {
    const cells = combo.map((v, j) => ({ col: j + 1, type: 's', value: v }));
    const stockVal = comboStocks.get(comboKey(combo));
    if (stockVal === undefined || stockVal === null) cells.push({ col: combo.length + 1, type: 's', value: '' });
    else cells.push({ col: combo.length + 1, type: 'n', value: stockVal });
    rows.push({ row: specRow + 1 + i, cells });
  });

  const sheetXml = buildSheetXml({ sheetName: tpl.sheetName, rows, lastRow, lastCol: effLastCol });
  const files = {
    '[Content_Types].xml': enc.encode(CONTENT_TYPES),
    '_rels/.rels': enc.encode(RELS),
    'xl/workbook.xml': enc.encode(buildWorkbookXml(tpl.sheetName)),
    'xl/_rels/workbook.xml.rels': enc.encode(WORKBOOK_RELS),
    'xl/worksheets/sheet1.xml': enc.encode(sheetXml),
    'xl/styles.xml': enc.encode(STYLES_XML),
    'xl/theme/theme1.xml': enc.encode(THEME_XML),
  };
  return fflate.zipSync(files, { level: 6 });
}
