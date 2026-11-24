// template-store.js —— 模板持久化（纯函数，不碰 localStorage 本身，方便 Node 测试）。
// 调用方（app.js）传进 localStorage 的读写函数；键：itg-templates-v1（模板）、
// itg-current-template（当前模板 key）、itg-quarantine-v1（隔离区）。
// 启动时逐个校验：不合格的进隔离区并提示，不阻塞启动（G16）。

export function serializeTemplates(templates) {
  // templates: Map<key, loadedTpl> 或 {key: tpl}；只存原始 JSON（去掉 _wordIndex）
  const out = {};
  const entries = templates instanceof Map ? [...templates.entries()] : Object.entries(templates);
  for (const [key, tpl] of entries) {
    const { _wordIndex, ...raw } = tpl;
    out[key] = raw;
  }
  return JSON.stringify(out);
}

export function deserializeTemplates(jsonText, loadTemplate) {
  const result = { templates: new Map(), quarantined: [] };
  if (!jsonText) return result;
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { templates: new Map(), quarantined: [{ key: '(整包)', error: '持久化模板不是合法 JSON，已隔离' }] };
  }
  for (const [key, raw] of Object.entries(data || {})) {
    try {
      const tpl = loadTemplate(raw);
      result.templates.set(key, tpl);
    } catch (e) {
      result.quarantined.push({ key, error: String(e?.message || e), raw });
    }
  }
  return result;
}

export function serializeQuarantine(quarantined) {
  return JSON.stringify(quarantined.map(({ key, error, raw }) => ({ key, error, raw })));
}

export function deserializeQuarantine(jsonText) {
  if (!jsonText) return [];
  try {
    const data = JSON.parse(jsonText);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
