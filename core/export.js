// export.js —— 记录导出：JSON 与 CSV（按规格组合展开，每行一个组合 + 库存）。
// 与出包互补：买家想把解析结果拿去别的工具用，不用再导 xlsx 转。

import { comboKey } from './fields.js';

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// fields: 归一化记录；combos/comboStocks 来自 validateStyle。
export function buildRecordsJson(fields, combos, comboStocks, tpl) {
  const axisNames = tpl.specAxes.map((k) => {
    const f = tpl.fields.find((x) => x.key === k);
    return f ? f.names[0] : k;
  });
  const rows = combos.map((combo) => {
    const row = {
      name: fields.name, category: fields.category, price: fields.price,
      freight: fields.freight, desc: fields.desc || '', code: fields.code,
    };
    combo.forEach((v, i) => { row[axisNames[i]] = v; });
    row.stock = comboStocks.get(comboKey(combo));
    if (fields.extra) {
      for (const ef of tpl.extraFields || []) {
        const v = fields.extra[ef.key];
        if (v !== undefined) row[ef.names[0]] = Array.isArray(v) ? v.join('、') : v;
      }
    }
    return row;
  });
  return JSON.stringify({ template: `${tpl.id}@${tpl.version}`, count: rows.length, records: rows }, null, 2);
}

export function buildRecordsCsv(fields, combos, comboStocks, tpl) {
  const axisNames = tpl.specAxes.map((k) => {
    const f = tpl.fields.find((x) => x.key === k);
    return f ? f.names[0] : k;
  });
  const extraNames = (tpl.extraFields || []).map((ef) => ef.names[0]);
  const header = ['商品名', '分类', '价格', '运费方式', '描述', '款号', ...axisNames, '库存', ...extraNames];
  const lines = [header.map(csvCell).join(',')];
  for (const combo of combos) {
    const vals = [
      fields.name, fields.category, fields.price, fields.freight, fields.desc || '', fields.code,
      ...combo, comboStocks.get(comboKey(combo)),
      ...(tpl.extraFields || []).map((ef) => {
        const v = fields.extra ? fields.extra[ef.key] : undefined;
        return v === undefined ? '' : (Array.isArray(v) ? v.join('、') : v);
      }),
    ];
    lines.push(vals.map(csvCell).join(','));
  }
  return lines.join('\n');
}
