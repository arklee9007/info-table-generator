// index.js —— 流水线总装：输入（文本/文件）-> 记录 -> 校验 -> 出包。
// 核心不碰 DOM、不碰网络、不含 AI；图片归类与排序由调用方（界面层）完成。

export { loadTemplate, validateTemplate, getField, getAnchorKey } from './template.js';
export { parseFieldText, parseFieldBlock, normalizeRecord, normalizeNumber, normalizeDate, FieldError, comboKey } from './fields.js';
export { parseFileInput, parsePastedText, parseCsv, detectCsvDelimiter, normalizeHeader, stripMarkdown, extractDocxText, listXlsxSheets } from './readers.js';
export { probeImage, sniffImageFormat } from './images.js';
export { validateStyle, buildCombos, axisDisplayNames } from './validate.js';
export { buildInfoTableXlsx } from './xlsx-write.js';
export { nameImages, generatePack } from './generate.js';
export { decodeText, normalizeNewlines } from './decode.js';
export { getXLSX, getFflate, setDeps } from './deps.js';
export { buildRecordsJson, buildRecordsCsv } from './export.js';
export { serializeTemplates, deserializeTemplates, serializeQuarantine, deserializeQuarantine } from './template-store.js';
export {
  stripLoaded, cloneRaw, validateDraft, renameFieldFirstName, renameAxis, setAxisList,
  addField, removeField, setFieldRequired, addExtraField, removeExtraField, setExtraOptions,
  addImageCategory, removeImageCategory, setImageCategory, setMeta, createCategoryTemplate,
} from './template-edit.js';

import { loadTemplate } from './template.js';
import { generatePack } from './generate.js';

// 批量出包：styles = [{fields, images}]，每款独立校验出包，某款失败不影响其他款。
// 返回 [{ok, code, pack?, error?, warnings?}]
export async function generatePacks(styles, tplInput, opts = {}) {
  const tpl = tplInput._wordIndex ? tplInput : loadTemplate(tplInput);
  const results = [];
  for (const s of styles) {
    try {
      const pack = await generatePack(s.fields, s.images || [], tpl, opts);
      results.push({ ok: true, code: s.fields.code, pack, warnings: pack.warnings });
    } catch (e) {
      results.push({ ok: false, code: s.fields?.code || s.fields?.name || '(未知款)', error: e.message, warnings: [] });
    }
  }
  return results;
}
