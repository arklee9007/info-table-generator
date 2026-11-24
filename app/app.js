// app.js —— 信息表生成器 PWA 界面层。核心逻辑全部在 core/，这里只管界面与文件读写。
import {
  loadTemplate, parseFieldText, parseFileInput, parsePastedText,
  normalizeRecord, validateStyle, buildCombos, generatePack, buildInfoTableXlsx,
  buildRecordsJson, buildRecordsCsv, axisDisplayNames, listXlsxSheets,
  serializeTemplates, deserializeTemplates, serializeQuarantine, deserializeQuarantine,
  stripLoaded, cloneRaw, validateDraft, renameFieldFirstName, setAxisList,
  addField, removeField, setFieldRequired, addExtraField, removeExtraField, setExtraOptions,
  addImageCategory, removeImageCategory, setImageCategory, setMeta, createCategoryTemplate,
  probeImage, FieldError, comboKey,
} from './core/index.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const APP_VERSION = document.querySelector('meta[name="app-version"]').content;
$('#versionLabel').textContent = 'v' + APP_VERSION;

// ---------- 状态 ----------
const templates = new Map(); // key: id@version -> loaded template
let currentTpl = null;
let styles = []; // {id, raw, fields, images, errors, warnings, combos, comboStocks, packMsg}
let styleSeq = 0;
let imgSeq = 0;

// ---------- 两个界面切换 ----------
let currentView = 'generate';
function switchView(which) {
  currentView = which;
  $('#viewGenerate').hidden = which !== 'generate';
  $('#viewSettings').hidden = which !== 'settings';
  $('#navGenerate').classList.toggle('active', which === 'generate');
  $('#navSettings').classList.toggle('active', which === 'settings');
  $('#navGenerate').setAttribute('aria-selected', String(which === 'generate'));
  $('#navSettings').setAttribute('aria-selected', String(which === 'settings'));
  $('#viewHint').textContent = which === 'generate'
    ? '选好模板，填表或导入文件，直接生成信息表。'
    : '先把模板设置好、选好，再回直接生成开始出包。';
  if (which === 'settings' && !editDraft && currentTpl) loadEditor(tplKey(currentTpl));
}
$('#navGenerate').addEventListener('click', () => switchView('generate'));
$('#navSettings').addEventListener('click', () => switchView('settings'));
$('#gotoSettingsBtn').addEventListener('click', () => switchView('settings'));

// ---------- 模板 ----------
function tplKey(t) { return `${t.id}@${t.version}`; }

const BUNDLED_TEMPLATE_IDS = ['clothing', 'cosmetics', 'shoes', 'food', 'digital', 'home', 'baby'];
const LS_TEMPLATES = 'itg-templates-v1';
const LS_CURRENT = 'itg-current-template';
const LS_QUARANTINE = 'itg-quarantine-v1';

function saveTemplates() {
  try {
    localStorage.setItem(LS_TEMPLATES, serializeTemplates(templates));
  } catch { /* 存储满或不可用：本次会话照常用，不阻塞 */ }
}

function saveCurrentTemplateKey() {
  try {
    if (currentTpl) localStorage.setItem(LS_CURRENT, tplKey(currentTpl));
  } catch { /* 同上 */ }
}

// 启动时加载全部内置模板，再把本机保存的导入模板叠加上去；
// 保存的模板逐个校验，不合格的进隔离区并提示，不阻塞启动（G16）。
async function loadBundledTemplates() {
  const loaded = [];
  for (const id of BUNDLED_TEMPLATE_IDS) {
    const res = await fetch(`templates/${id}-v1.json`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`内置模板加载失败：${id}`);
    const tpl = loadTemplate(await res.json());
    templates.set(tplKey(tpl), tpl);
    loaded.push(tpl);
  }
  let stored = null;
  try { stored = localStorage.getItem(LS_TEMPLATES); } catch { stored = null; }
  if (stored) {
    const { templates: saved, quarantined } = deserializeTemplates(stored, loadTemplate);
    for (const [key, tpl] of saved) templates.set(key, tpl);
    if (quarantined.length) {
      try {
        const prev = deserializeQuarantine(localStorage.getItem(LS_QUARANTINE));
        localStorage.setItem(LS_QUARANTINE, serializeQuarantine([...prev, ...quarantined]));
      } catch { /* 隔离区写不进也不阻塞 */ }
      setTimeout(() => showNotice(
        `有 ${quarantined.length} 个保存的模板校验失败，已隔离（不影响使用）：${quarantined.map((q) => q.key).join('、')}。可在“模板管理”里导出备份。`, 'warn'), 0);
    }
  }
  let current = loaded[0];
  try {
    const savedKey = localStorage.getItem(LS_CURRENT);
    if (savedKey && templates.get(savedKey)) current = templates.get(savedKey);
  } catch { /* 无保存的选择就用服装 */ }
  return current;
}

function refreshTemplateSelect() {
  for (const sel of [$('#templateSelect'), $('#settingsTemplateSelect')]) {
    sel.innerHTML = '';
    for (const [key, t] of templates) {
      sel.append(h('option', { value: key, text: `${t.name} v${t.version}` }));
    }
  }
  if (currentTpl) $('#templateSelect').value = tplKey(currentTpl);
  const edKey = editDraft ? editSourceKey : (currentTpl ? tplKey(currentTpl) : null);
  if (edKey && templates.get(edKey)) $('#settingsTemplateSelect').value = edKey;
  updateTemplateInfo();
}

function updateTemplateInfo() {
  if (!currentTpl) return;
  const axisNames = axisDisplayNames(currentTpl);
  const extraCount = (currentTpl.extraFields || []).length;
  const parserNote = currentTpl.parserCompatible === false
    ? '本模板出包是标准信息表，暂不能直接导入现有商城后台解析器（要进商城请走自动化插件适配器）。'
    : '';
  $('#templateInfo').textContent =
    `当前模板：${currentTpl.name} v${currentTpl.version}，字段 ${currentTpl.fields.length} 个` +
    (extraCount ? ` + 扩展字段 ${extraCount} 个` : '') +
    `，规格轴 ${axisNames.length ? axisNames.join(' × ') : '无规格'}，图片上限 ${currentTpl.images.maxImages} 张。${parserNote}`;
  const st = settingsTpl();
  if (st) {
    const sAxes = axisDisplayNames(st);
    const sExtra = (st.extraFields || []).length;
    $('#settingsTemplateInfo').textContent =
      `正在设置：${st.name} v${st.version}，字段 ${st.fields.length} 个` +
      (sExtra ? ` + 扩展字段 ${sExtra} 个` : '') +
      `，规格轴 ${sAxes.length ? sAxes.join(' × ') : '无规格'}` +
      (BUNDLED_TEMPLATE_IDS.includes(st.id) ? '（内置模板，保存时自动存为副本）' : '（本机模板，保存直接覆盖）');
  }
}

// 设置界面当前选中的模板（与生成界面的当前模板分开：先设好、再决定用不用）
function settingsTpl() {
  const sel = $('#settingsTemplateSelect');
  return (sel && sel.value && templates.get(sel.value)) || currentTpl;
}

$('#settingsTemplateSelect').addEventListener('change', (e) => {
  const next = templates.get(e.target.value);
  if (!next) return;
  if (editDraft && editSourceKey !== e.target.value && editorDirty()) {
    if (!confirm('编辑器里有未保存的修改，切换模板会丢掉，确定切换吗？')) {
      e.target.value = editSourceKey;
      return;
    }
  }
  loadEditor(e.target.value);
  updateTemplateInfo();
});

$('#useTemplateBtn').addEventListener('click', () => {
  const next = settingsTpl();
  if (!next) return;
  if (editorDirty()) {
    if (!confirm('编辑器里有未保存的修改，先用旧版模板生成吗？（点取消回去保存）')) return;
  }
  if (next === currentTpl) { switchView('generate'); return; }
  if (styles.length > 0 && !confirm('切换模板会清空已解析的款式，确定切换吗？')) return;
  clearStyles();
  currentTpl = next;
  saveCurrentTemplateKey();
  refreshTemplateSelect();
  switchView('generate');
  showNotice(`已选模板：${currentTpl.name} v${currentTpl.version}，可以开始生成。`, 'ok');
});

$('#templateSelect').addEventListener('change', (e) => {
  const next = templates.get(e.target.value);
  if (!next || next === currentTpl) return;
  if (styles.length > 0 && !confirm('切换模板会清空已解析的款式，确定切换吗？')) {
    e.target.value = tplKey(currentTpl);
    return;
  }
  clearStyles();
  currentTpl = next;
  saveCurrentTemplateKey();
  updateTemplateInfo();
});

$('#templateFileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const tpl = loadTemplate(JSON.parse(await file.text()));
    const key = tplKey(tpl);
    if (templates.has(key)) {
      if (!confirm(`模板 ${tpl.name} v${tpl.version} 已存在，确定覆盖吗？`)) return;
    }
    templates.set(key, tpl);
    currentTpl = tpl;
    refreshTemplateSelect();
    saveTemplates();
    saveCurrentTemplateKey();
    loadEditor(key);
    showNotice(`已导入模板：${tpl.name} v${tpl.version}（已保存在本机，下次打开不用重新导入）。已在下方编辑器里打开，可直接改。`, 'ok');
  } catch (err) {
    showNotice(`模板文件无效：${err.message}`, 'error');
  }
});

// ---------- 模板管理：导出 / 复制 / 删除 / 新建品类 ----------
function downloadTextFile(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

$('#exportTemplateBtn').addEventListener('click', () => {
  const tpl = settingsTpl();
  if (!tpl) return;
  const raw = stripLoaded(tpl);
  downloadTextFile(JSON.stringify(raw, null, 2), `${tpl.id}-v${tpl.version}.json`, 'application/json');
  showNotice(`已导出模板：${tpl.name} v${tpl.version}`, 'ok');
});

$('#duplicateTemplateBtn').addEventListener('click', () => {
  const tpl = settingsTpl();
  if (!tpl) return;
  const name = prompt('复制后的模板叫什么名字？（如：食品-散装）', tpl.name + '-复制');
  if (!name) return;
  const copy = stripLoaded(tpl);
  copy.name = name.trim();
  copy.id = copy.id + '-copy-' + Date.now().toString(36);
  copy.version = '1.0.0';
  try {
    const nt = loadTemplate(copy);
    templates.set(tplKey(nt), nt);
    refreshTemplateSelect();
    saveTemplates();
    loadEditor(tplKey(nt));
    showNotice(`已复制为新模板：${nt.name} v${nt.version}（已在编辑器里打开）`, 'ok');
  } catch (err) {
    showNotice(`复制失败：${err.message}`, 'error');
  }
});

$('#deleteTemplateBtn').addEventListener('click', () => {
  const tpl = settingsTpl();
  if (!tpl) return;
  if (BUNDLED_TEMPLATE_IDS.includes(tpl.id)) {
    showNotice('内置模板不能删除（服装/美妆/鞋/食品/数码/家居/母婴一直在下拉里）。', 'error');
    return;
  }
  if (!confirm(`确定删除模板 ${tpl.name} v${tpl.version} 吗？本机保存的这份也会删掉。`)) return;
  const wasCurrent = currentTpl === tpl;
  templates.delete(tplKey(tpl));
  if (wasCurrent) {
    currentTpl = templates.get('clothing@1.0.0') || [...templates.values()][0];
    clearStyles();
    saveCurrentTemplateKey();
  }
  editDraft = null;
  editSourceKey = null;
  refreshTemplateSelect();
  saveTemplates();
  if (currentTpl) loadEditor(tplKey(currentTpl));
  showNotice(wasCurrent ? '已删除，当前模板切回服装。' : '已删除。', 'ok');
});

$('#createCategoryBtn').addEventListener('click', () => {
  const name = $('#newCategoryName').value.trim();
  const axes = [$('#newAxis1').value.trim(), $('#newAxis2').value.trim(), $('#newAxis3').value.trim()];
  if (!name) { showNotice('请先填新品类名（如：食品）。', 'error'); return; }
  const base = templates.get('clothing@1.0.0');
  if (!base) { showNotice('内置服装模板未加载，无法新建品类。', 'error'); return; }
  try {
    const tpl = loadTemplate(createCategoryTemplate(stripLoaded(base), name, axes));
    templates.set(tplKey(tpl), tpl);
    currentTpl = tpl;
    refreshTemplateSelect();
    saveTemplates();
    saveCurrentTemplateKey();
    loadEditor(tplKey(tpl));
    showNotice(`已新建品类模板：${tpl.name}（${axes.filter(Boolean).join(' × ') || '无规格'}），已保存在本机。已在下方编辑器里打开，可继续加扩展字段（如保质期）。`, 'ok');
  } catch (err) {
    showNotice(`新建品类失败：${err.message}`, 'error');
  }
});

// ---------- 模板编辑器（设置界面：草稿 + 即时校验，点保存才生效） ----------
let editDraft = null;         // 原始 JSON 草稿（未保存前不碰 templates）
let editSourceKey = null;     // 草稿来源模板 key
let editSavedSnapshot = '';   // 上次载入/保存时的草稿 JSON，用于判断有没有未保存修改

function editorDirty() {
  return !!editDraft && JSON.stringify(editDraft) !== editSavedSnapshot;
}

function showEditorError(err) {
  const box = $('#edErrors');
  box.hidden = false;
  box.className = 'notice error';
  box.textContent = String(err?.message || err);
}

function loadEditor(key) {
  const tpl = templates.get(key);
  if (!tpl) return;
  editDraft = stripLoaded(tpl);
  editSourceKey = key;
  editSavedSnapshot = JSON.stringify(editDraft);
  renderEditor();
}

function validateEditor() {
  const box = $('#edErrors');
  if (!editDraft) { box.hidden = true; return []; }
  const errors = validateDraft(editDraft);
  box.hidden = false;
  if (!errors.length) {
    box.className = 'notice ok';
    box.textContent = '校验通过，可以保存。';
  } else {
    box.className = 'notice error';
    box.textContent = '模板现在还不能保存：\n' + errors.map((e) => '· ' + e).join('\n');
  }
  $('#edSaveBtn').disabled = errors.length > 0;
  return errors;
}

function fieldTypeLabel(f) {
  if (f.styleAnchor) return '锚字段（款名）';
  if (f.type === 'price') return '价格';
  if (f.type === 'freight') return '运费';
  if (f.type === 'stock') return '库存';
  if (f.type === 'list') return '列表';
  return '文本';
}

function renderEditor() {
  if (!editDraft) return;
  const d = editDraft;
  $('#editorTitle').textContent = `${d.name} v${d.version}`;
  $('#edName').value = d.name || '';
  $('#edVersion').value = d.version || '';
  $('#edDesc').value = d.description || '';

  // 规格轴
  const axesBody = $('#edAxesBody');
  axesBody.innerHTML = '';
  (d.specAxes || []).forEach((ax) => {
    const f = d.fields.find((x) => x.key === ax);
    const row = h('div', { class: 'ed-row', dataset: { testid: 'editor-axis-row', axis: ax } });
    row.append(h('span', { class: 'key', text: '轴 ' + ax }));
    const inp = h('input', { type: 'text', value: f ? f.names[0] : ax, 'aria-label': '轴显示名', dataset: { testid: 'editor-axis-name' } });
    inp.addEventListener('change', () => {
      try { renameFieldFirstName(editDraft, ax, inp.value); renderEditor(); }
      catch (err) { inp.value = f ? f.names[0] : ax; showEditorError(err); }
    });
    row.append(inp, h('span', { class: 'tag', text: '改名后规格预览、出包表头、图片类别同步改' }));
    row.append(h('button', { class: 'btn btn-small btn-danger', text: '移出轴', onclick: () => {
      setAxisList(editDraft, d.specAxes.filter((k) => k !== ax));
      renderEditor();
    } }));
    axesBody.append(row);
  });
  if (!d.specAxes.length) axesBody.append(h('p', { class: 'hint', text: '无规格：只有库存，没有规格组合。' }));
  const addSel = $('#edAddAxisSelect');
  addSel.innerHTML = '';
  const cands = d.fields.filter((f) => f.type === 'list' && !d.specAxes.includes(f.key));
  if (!cands.length) addSel.append(h('option', { value: '', text: '（没有可加的列表字段，先在下方加一个列表字段）' }));
  else for (const f of cands) addSel.append(h('option', { value: f.key, text: `${f.names[0]}（${f.key}）` }));

  // 主字段
  const fieldsBody = $('#edFieldsBody');
  fieldsBody.innerHTML = '';
  for (const f of d.fields) {
    const row = h('div', { class: 'ed-row', dataset: { testid: 'editor-field-row', field: f.key } });
    row.append(h('span', { class: 'key', text: f.key }));
    const inp = h('input', { type: 'text', value: f.names[0], 'aria-label': `字段 ${f.key} 显示名`, dataset: { testid: 'editor-field-name' } });
    inp.addEventListener('change', () => {
      try { renameFieldFirstName(editDraft, f.key, inp.value); renderEditor(); }
      catch (err) { inp.value = f.names[0]; showEditorError(err); }
    });
    row.append(inp, h('span', { class: 'tag', text: fieldTypeLabel(f) }));
    const req = h('input', { type: 'checkbox', 'aria-label': '必填' });
    req.checked = !!f.required;
    req.addEventListener('change', () => { setFieldRequired(editDraft, f.key, req.checked); validateEditor(); });
    const reqLab = h('label', { class: 'chk' }, req, '必填');
    row.append(reqLab);
    row.append(h('button', { class: 'btn btn-small btn-danger', text: '删除', onclick: () => {
      try { removeField(editDraft, f.key); renderEditor(); }
      catch (err) { showEditorError(err); }
    } }));
    fieldsBody.append(row);
  }

  // 扩展字段
  const extraBody = $('#edExtraBody');
  extraBody.innerHTML = '';
  for (const ef of d.extraFields || []) {
    const row = h('div', { class: 'ed-row', dataset: { testid: 'editor-extra-row', field: ef.key } });
    row.append(h('span', { class: 'key', text: ef.key }));
    const inp = h('input', { type: 'text', value: ef.names[0], 'aria-label': `扩展字段 ${ef.key} 显示名`, dataset: { testid: 'editor-extra-name' } });
    inp.addEventListener('change', () => {
      try { renameFieldFirstName(editDraft, ef.key, inp.value); renderEditor(); }
      catch (err) { inp.value = ef.names[0]; showEditorError(err); }
    });
    row.append(inp);
    const typeSel = h('select', { 'aria-label': '扩展字段类型', dataset: { testid: 'editor-extra-type' } });
    for (const [v, label] of [['text', '文本'], ['number', '数字'], ['date', '日期'], ['enum', '枚举'], ['list', '列表']]) {
      const opt = h('option', { value: v, text: label });
      if (ef.type === v) opt.selected = true;
      typeSel.append(opt);
    }
    typeSel.addEventListener('change', () => {
      ef.type = typeSel.value;
      if (ef.type === 'enum' && !(ef.options || []).length) ef.options = ['选项1'];
      if (ef.type !== 'enum') delete ef.options;
      renderEditor();
    });
    row.append(typeSel);
    const optInp = h('input', { type: 'text', value: (ef.options || []).join('、'), 'aria-label': '枚举可选值', dataset: { testid: 'editor-extra-options' } });
    optInp.disabled = ef.type !== 'enum';
    optInp.placeholder = '枚举可选值，顿号分隔';
    optInp.addEventListener('change', () => {
      try { setExtraOptions(editDraft, ef.key, optInp.value); validateEditor(); }
      catch (err) { optInp.value = (ef.options || []).join('、'); showEditorError(err); }
    });
    row.append(optInp);
    const req = h('input', { type: 'checkbox', 'aria-label': '必填' });
    req.checked = !!ef.required;
    req.addEventListener('change', () => { setFieldRequired(editDraft, ef.key, req.checked); validateEditor(); });
    row.append(h('label', { class: 'chk' }, req, '必填'));
    row.append(h('button', { class: 'btn btn-small btn-danger', text: '删除', onclick: () => {
      removeExtraField(editDraft, ef.key);
      renderEditor();
    } }));
    extraBody.append(row);
  }
  if (!(d.extraFields || []).length) extraBody.append(h('p', { class: 'hint', text: '暂无扩展字段。' }));

  // 图片类别
  const imgBody = $('#edImgBody');
  imgBody.innerHTML = '';
  for (const c of d.images.categories || []) {
    const row = h('div', { class: 'ed-row', dataset: { testid: 'editor-image-row', category: c.key } });
    row.append(h('span', { class: 'key', text: c.key }));
    const labInp = h('input', { type: 'text', value: c.label, 'aria-label': `图片类别 ${c.key} 显示名`, dataset: { testid: 'editor-image-label' } });
    labInp.addEventListener('change', () => {
      try { setImageCategory(editDraft, c.key, { label: labInp.value }); validateEditor(); }
      catch (err) { labInp.value = c.label; showEditorError(err); }
    });
    row.append(labInp);
    const nmInp = h('input', { type: 'text', value: c.naming, 'aria-label': `图片类别 ${c.key} 命名规则`, dataset: { testid: 'editor-image-naming' } });
    nmInp.classList.add('wide');
    nmInp.addEventListener('change', () => {
      try { setImageCategory(editDraft, c.key, { naming: nmInp.value }); validateEditor(); }
      catch (err) { nmInp.value = c.naming; showEditorError(err); }
    });
    row.append(nmInp);
    const kfSel = h('select', { 'aria-label': '图片类别对应字段', dataset: { testid: 'editor-image-keyfrom' } });
    kfSel.append(h('option', { value: '', text: '不按轴取值' }));
    for (const f of d.fields.filter((x) => x.type === 'list')) {
      const opt = h('option', { value: f.key, text: `按${f.names[0]}（${f.key}）` });
      if (c.keyFrom === f.key) opt.selected = true;
      kfSel.append(opt);
    }
    kfSel.addEventListener('change', () => {
      try { setImageCategory(editDraft, c.key, { keyFrom: kfSel.value || null }); renderEditor(); }
      catch (err) { kfSel.value = c.keyFrom || ''; showEditorError(err); }
    });
    row.append(kfSel);
    const req = h('input', { type: 'checkbox', 'aria-label': '必填' });
    req.checked = !!c.required;
    req.addEventListener('change', () => { setImageCategory(editDraft, c.key, { required: req.checked }); validateEditor(); });
    row.append(h('label', { class: 'chk' }, req, '必填'));
    row.append(h('button', { class: 'btn btn-small btn-danger', text: '删除', onclick: () => {
      try { removeImageCategory(editDraft, c.key); renderEditor(); }
      catch (err) { showEditorError(err); }
    } }));
    imgBody.append(row);
  }

  // 图片类别“对应字段”下拉（新增行用）
  const kfNew = $('#edNewImgKeyFrom');
  kfNew.innerHTML = '';
  kfNew.append(h('option', { value: '', text: '不按轴取值' }));
  for (const f of d.fields.filter((x) => x.type === 'list')) {
    kfNew.append(h('option', { value: f.key, text: `按${f.names[0]}（${f.key}）` }));
  }

  validateEditor();
}

$('#edName').addEventListener('change', () => {
  try { setMeta(editDraft, { name: $('#edName').value }); $('#editorTitle').textContent = `${editDraft.name} v${editDraft.version}`; validateEditor(); }
  catch (err) { $('#edName').value = editDraft.name; showEditorError(err); }
});
$('#edVersion').addEventListener('change', () => {
  try { setMeta(editDraft, { version: $('#edVersion').value }); $('#editorTitle').textContent = `${editDraft.name} v${editDraft.version}`; validateEditor(); }
  catch (err) { $('#edVersion').value = editDraft.version; showEditorError(err); }
});
$('#edDesc').addEventListener('change', () => {
  setMeta(editDraft, { description: $('#edDesc').value });
  validateEditor();
});

$('#edAddAxisBtn').addEventListener('click', () => {
  const key = $('#edAddAxisSelect').value;
  if (!key) return;
  try { setAxisList(editDraft, [...editDraft.specAxes, key]); renderEditor(); }
  catch (err) { showEditorError(err); }
});

$('#edAddFieldBtn').addEventListener('click', () => {
  try {
    addField(editDraft, { key: $('#edNewKey').value, name: $('#edNewName').value, type: $('#edNewType').value });
    $('#edNewKey').value = ''; $('#edNewName').value = '';
    renderEditor();
  } catch (err) { showEditorError(err); }
});

$('#edAddExtraBtn').addEventListener('click', () => {
  try {
    addExtraField(editDraft, {
      key: $('#edNewExtraKey').value, name: $('#edNewExtraName').value,
      type: $('#edNewExtraType').value, options: $('#edNewExtraOptions').value,
    });
    $('#edNewExtraKey').value = ''; $('#edNewExtraName').value = ''; $('#edNewExtraOptions').value = '';
    renderEditor();
  } catch (err) { showEditorError(err); }
});

$('#edAddImgBtn').addEventListener('click', () => {
  try {
    addImageCategory(editDraft, {
      key: $('#edNewImgKey').value, label: $('#edNewImgLabel').value,
      naming: $('#edNewImgNaming').value, keyFrom: $('#edNewImgKeyFrom').value || null,
    });
    $('#edNewImgKey').value = ''; $('#edNewImgLabel').value = ''; $('#edNewImgNaming').value = '';
    renderEditor();
  } catch (err) { showEditorError(err); }
});

$('#edResetBtn').addEventListener('click', () => {
  if (editorDirty() && !confirm('放弃本次未保存的修改吗？')) return;
  loadEditor(editSourceKey);
  showNotice('已放弃修改，恢复到保存过的版本。', 'ok');
});

$('#edSaveBtn').addEventListener('click', () => {
  if (!editDraft) return;
  const errors = validateEditor();
  if (errors.length) return;
  const source = templates.get(editSourceKey);
  const isBundled = source && BUNDLED_TEMPLATE_IDS.includes(source.id);
  const draft = cloneRaw(editDraft);
  if (isBundled) {
    // 内置模板不动：另存为副本（新 id、版本照编辑器里填的）
    draft.id = source.id + '-edit-' + Date.now().toString(36);
  }
  try {
    const nt = loadTemplate(draft);
    const newKey = tplKey(nt);
    if (newKey !== editSourceKey) templates.delete(editSourceKey);
    templates.set(newKey, nt);
    if (currentTpl && tplKey(currentTpl) === editSourceKey) {
      currentTpl = nt;
      saveCurrentTemplateKey();
    }
    editSourceKey = newKey;
    editSavedSnapshot = JSON.stringify(stripLoaded(nt));
    editDraft = stripLoaded(nt);
    refreshTemplateSelect();
    saveTemplates();
    renderEditor();
    showNotice(isBundled
      ? `内置模板已另存为副本：${nt.name} v${nt.version}（原模板不动）。点「设为生成模板并开始生成」即可用它出包。`
      : `已保存模板：${nt.name} v${nt.version}。`, 'ok');
  } catch (err) {
    showNotice(`保存失败：${err.message}`, 'error');
  }
});

// ---------- 输入：页签 ----------
$('#tabPaste').addEventListener('click', () => switchTab('paste'));
$('#tabFile').addEventListener('click', () => switchTab('file'));
function switchTab(which) {
  $('#tabPaste').classList.toggle('active', which === 'paste');
  $('#tabFile').classList.toggle('active', which === 'file');
  $('#tabPaste').setAttribute('aria-selected', String(which === 'paste'));
  $('#tabFile').setAttribute('aria-selected', String(which === 'file'));
  $('#panePaste').hidden = which !== 'paste';
  $('#paneFile').hidden = which !== 'file';
}

const SAMPLE_TEXT = `款名：重磅素色短袖
分类：短袖
价格：129
运费方式：套模板
描述：240g 重磅棉，宽松版型，素色百搭。
颜色：本白、克莱因蓝
尺码：M、L
图案：素色
库存：100，本白/M/素色=50`;
$('#fillSampleBtn').addEventListener('click', () => { $('#pasteArea').value = SAMPLE_TEXT; });
$('#clearPasteBtn').addEventListener('click', () => { $('#pasteArea').value = ''; });

// 文件输入
let pendingFile = null;
const fileInput = $('#fileInput');
const dropzone = $('#fileDropzone');
fileInput.addEventListener('change', () => setPendingFile(fileInput.files[0] || null));
for (const ev of ['dragover', 'dragenter']) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
}
for (const ev of ['dragleave', 'drop']) {
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag'); });
}
dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (f) setPendingFile(f);
});
function setPendingFile(f) {
  pendingFile = f;
  $('#fileNameLabel').textContent = f ? f.name : '';
  $('#parseFileBtn').disabled = !f;
  // xlsx/xls 多表：先读表名，多于一张就让买家选一张再解析（G6 P1）
  const sheetRow = $('#sheetRow');
  sheetRow.hidden = true;
  if (f && /\.(xlsx|xls)$/i.test(f.name)) {
    f.arrayBuffer().then(async (buf) => {
      if (pendingFile !== f) return; // 期间换了文件就不管了
      try {
        const names = await listXlsxSheets(new Uint8Array(buf));
        if (names.length > 1) {
          const sel = $('#sheetSelect');
          sel.innerHTML = '';
          names.forEach((n, i) => sel.append(h('option', { value: String(i), text: `第 ${i + 1} 张：${n}` })));
          sheetRow.hidden = false;
        }
      } catch { /* 表名读不出来：解析时再报错，不提前拦 */ }
    });
  }
}

function showNotice(text, kind) {
  // 两个界面各有一个提示区，都写一份（当前看不见的那个切过去时也能看到）
  for (const id of ['#parseNotice', '#settingsNotice']) {
    const n = $(id);
    if (!n) continue;
    n.hidden = false;
    n.className = 'notice ' + kind;
    n.textContent = text;
  }
}

// ---------- 解析 ----------
function fieldsToRaw(fields, tpl) {
  const raw = {};
  for (const f of tpl.fields) {
    const v = fields[f.key];
    if (v === undefined || v === null) continue;
    if (f.type === 'list') raw[f.key] = v.join('、');
    else if (f.type === 'stock') {
      const segs = v.default !== null && v.default !== undefined ? [String(v.default)] : [];
      for (const [k, val] of v.overrides) segs.push(`${k.split('\u001f').join('/')}=${val}`);
      raw[f.key] = segs.join('、');
    } else raw[f.key] = String(v);
  }
  for (const ef of tpl.extraFields || []) {
    const v = fields.extra ? fields.extra[ef.key] : undefined;
    if (v === undefined || v === null) continue;
    raw[ef.key] = Array.isArray(v) ? v.join('、') : String(v);
  }
  return raw;
}

function addStyles(records, warnings) {
  let added = 0;
  for (const rec of records) {
    const style = {
      id: ++styleSeq,
      raw: fieldsToRaw(rec.fields, currentTpl),
      fields: rec.fields,
      images: [],
      errors: [], warnings: [...(rec.warnings || [])],
      combos: [], comboStocks: new Map(),
      packMsg: null,
    };
    recompute(style);
    styles.push(style);
    added++;
  }
  renderStyles();
  const extra = warnings && warnings.length ? '\n' + warnings.join('\n') : '';
  showNotice(`已解析 ${added} 款，已加入下方列表。请逐款核对字段、配好图片再出包。${extra}`, 'ok');
}

$('#parsePasteBtn').addEventListener('click', async () => {
  const text = $('#pasteArea').value;
  if (!text.trim()) { showNotice('请先粘贴文字。', 'error'); return; }
  try {
    const { records, warnings } = await parsePastedText(text, currentTpl);
    addStyles(records, warnings);
  } catch (err) {
    showNotice(`解析失败：${err.message}`, 'error');
  }
});

$('#parseFileBtn').addEventListener('click', async () => {
  if (!pendingFile) return;
  try {
    const bytes = new Uint8Array(await pendingFile.arrayBuffer());
    const opts = {};
    if (!$('#sheetRow').hidden) opts.sheet = Number($('#sheetSelect').value);
    const { records, warnings } = await parseFileInput({ name: pendingFile.name, bytes }, currentTpl, opts);
    addStyles(records, warnings);
  } catch (err) {
    showNotice(`解析失败：${err.message}`, 'error');
  }
});

// ---------- 款式：重算与渲染 ----------
function recompute(style) {
  style.packMsg = null;
  try {
    const { fields, warnings } = normalizeRecord(style.raw, currentTpl);
    style.fields = fields;
    style.fieldError = null;
    const v = validateStyle(fields, style.images, currentTpl);
    style.errors = v.errors;
    style.warnings = [...warnings, ...v.warnings];
    style.combos = v.combos;
    style.comboStocks = v.comboStocks;
  } catch (err) {
    style.fieldError = err.message;
    style.errors = [err.message];
    style.warnings = [];
    style.combos = [];
    style.comboStocks = new Map();
  }
}

function renderStyles() {
  const list = $('#styleList');
  list.innerHTML = '';
  $('#emptyHint').hidden = styles.length > 0;
  $('#downloadAllBtn').disabled = styles.length === 0;
  $('#clearAllBtn').disabled = styles.length === 0;
  for (const style of styles) list.append(renderStyleCard(style));
}

function renderStyleCard(style) {
  const f = style.fields || {};
  const card = h('article', { class: 'style-card', dataset: { styleId: style.id, testid: 'style-card' } });
  const head = h('div', { class: 'style-head' },
    h('h3', { text: f.name || '(未命名款)' }),
    h('span', { class: 'code', text: '款号：' + (f.code || '—') }),
    h('button', { class: 'btn btn-small btn-danger', text: '删除本款', onclick: () => removeStyle(style.id) })
  );
  card.append(head);

  // 字段编辑（主字段 + 扩展字段）
  const grid = h('div', { class: 'field-grid' });
  for (const field of [...currentTpl.fields, ...(currentTpl.extraFields || [])]) {
    const wrap = h('div', { class: 'field' });
    const label = field.names[0] + (field.required ? ' *' : '');
    wrap.append(h('label', { text: label }));
    const val = style.raw[field.key] ?? '';
    if (field.multiline) {
      const ta = h('textarea', { rows: '2', dataset: { key: field.key } });
      ta.value = val;
      ta.addEventListener('change', () => onFieldEdit(style, field.key, ta.value));
      wrap.append(ta);
      wrap.classList.add('full');
    } else {
      const inp = h('input', { type: 'text', value: val, dataset: { key: field.key } });
      inp.addEventListener('change', () => onFieldEdit(style, field.key, inp.value));
      wrap.append(inp);
    }
    if (field.type === 'stock') wrap.append(h('div', { class: 'hint', text: `统一数写数字；单个组合覆盖写「${axisDisplayNames(currentTpl).join('/')}=数字」，顿号分隔；没有统一数时每个组合都要写覆盖。` }));
    if (field.type === 'list') wrap.append(h('div', { class: 'hint', text: '多值用顿号分隔。' }));
    if (field.type === 'date') wrap.append(h('div', { class: 'hint', text: '日期写 YYYY-MM-DD，如 2027-06-30。' }));
    if (field.type === 'number') wrap.append(h('div', { class: 'hint', text: '写数字。' }));
    if (field.type === 'enum') wrap.append(h('div', { class: 'hint', text: `只认：${field.options.join('、')}。` }));
    grid.append(wrap);
  }
  card.append(grid);

  // 规格预览（表头用轴显示名，如色号/规格/质地；Excel 表头仍按模板 specHeaders 出）
  if (style.combos.length > 0) {
    const table = h('table', { class: 'spec-table', dataset: { testid: 'spec-table' } });
    const previewHeaders = [...axisDisplayNames(currentTpl), '库存'];
    const thead = h('thead', {}, h('tr', {}, ...previewHeaders.map((t) => h('th', { text: t }))));
    const tbody = h('tbody');
    for (const combo of style.combos) {
      const key = comboKey(combo);
      const cells = combo.map((v) => h('td', { text: v }));
      cells.push(h('td', { class: 'num', text: String(style.comboStocks.get(key) ?? '') }));
      tbody.append(h('tr', {}, ...cells));
    }
    table.append(thead, tbody);
    card.append(table);
  }

  // 错误与警告
  if (style.errors.length) {
    card.append(h('div', { class: 'msg error', dataset: { testid: 'style-errors' }, text: '出包前须修正：\n' + style.errors.map((e) => '· ' + e).join('\n') }));
  }
  if (style.warnings.length) {
    card.append(h('div', { class: 'msg warn', text: '提醒：\n' + style.warnings.map((e) => '· ' + e).join('\n') }));
  }
  if (style.packMsg) {
    card.append(h('div', { class: 'msg ' + style.packMsg.kind, text: style.packMsg.text }));
  }

  // 图片区
  card.append(renderImageArea(style));

  // 出包按钮
  const ops = h('div', { class: 'row' },
    h('button', { class: 'btn btn-primary', dataset: { testid: 'pack-btn' }, text: '生成素材包', onclick: () => packStyle(style) }),
    h('button', { class: 'btn btn-ghost', text: '只下载信息表', onclick: () => downloadXlsxOnly(style) }),
    h('button', { class: 'btn btn-ghost', text: '下载 JSON', onclick: () => downloadJsonOnly(style) }),
    h('button', { class: 'btn btn-ghost', text: '下载 CSV', onclick: () => downloadCsvOnly(style) })
  );
  card.append(ops);
  return card;
}

function onFieldEdit(style, key, value) {
  style.raw[key] = value;
  recompute(style);
  renderStyles();
}

function removeStyle(id) {
  const s = styles.find((x) => x.id === id);
  if (s) for (const im of s.images) URL.revokeObjectURL(im.url);
  styles = styles.filter((x) => x.id !== id);
  renderStyles();
}

function clearStyles() {
  for (const s of styles) for (const im of s.images) URL.revokeObjectURL(im.url);
  styles = [];
  renderStyles();
}
$('#clearAllBtn').addEventListener('click', () => {
  if (confirm('清空全部款式与图片吗？')) clearStyles();
});

// ---------- 图片 ----------
function renderImageArea(style) {
  const area = h('div', { class: 'img-groups' });
  const cats = currentTpl.images.categories;
  for (const cat of cats) {
    const groupImgs = style.images.filter((im) => im.category === cat.key);
    const group = h('div', { class: 'img-group' });
    group.append(h('h4', {}, `${cat.label}`, h('span', { class: 'count', text: `（${groupImgs.length} 张${cat.required ? '，必填' : ''}）` })));
    const thumbs = h('div', { class: 'thumbs' });
    for (const im of groupImgs) thumbs.append(renderThumb(style, im, cat));
    if (groupImgs.length === 0) thumbs.append(h('p', { class: 'hint', text: '暂无图片' }));
    group.append(thumbs);
    area.append(group);
  }
  const addRow = h('div', { class: 'img-add row' });
  const fileBtn = h('label', { class: 'btn btn-ghost file-btn', text: '添加图片' });
  const fi = h('input', { type: 'file', accept: 'image/*,.webp', multiple: 'multiple', hidden: 'hidden', dataset: { testid: 'image-input' } });
  fi.addEventListener('change', () => { addImages(style, [...fi.files]); fi.value = ''; });
  fileBtn.append(fi);
  addRow.append(fileBtn, h('span', { class: 'hint', text: '支持 jpg/png/webp（webp 出包时自动转 JPEG）；详情图墙内上下顺序即详情页顺序。' }));
  area.append(addRow);
  return area;
}

function renderThumb(style, im, cat) {
  const thumb = h('div', { class: 'thumb', dataset: { testid: 'thumb' } });
  thumb.append(h('img', { src: im.url, alt: im.sourceName }));
  thumb.append(h('div', { class: 'meta', text: `${im.sourceName}\n${im.probe.format ? im.probe.format.toUpperCase() + ' ' + im.probe.width + '×' + im.probe.height : '未知格式'}` }));
  // 类别选择
  const sel = h('select', { 'aria-label': '图片类别', dataset: { testid: 'category-select' } });
  for (const c of currentTpl.images.categories) {
    const opt = h('option', { value: c.key, text: c.label });
    if (c.key === im.category) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => {
    im.category = sel.value;
    const newCat = currentTpl.images.categories.find((c) => c.key === im.category);
    if (!newCat || !newCat.keyFrom) im.colorKey = null;
    else if (!im.colorKey && style.fields[newCat.keyFrom]) im.colorKey = style.fields[newCat.keyFrom][0];
    recompute(style);
    renderStyles();
  });
  thumb.append(sel);
  // 带 keyFrom 的图片类别（如颜色图/口味图/款式图）：选对应的轴值
  const catDef = currentTpl.images.categories.find((c) => c.key === im.category);
  if (catDef && catDef.keyFrom) {
    const axisField = currentTpl.fields.find((x) => x.key === catDef.keyFrom);
    const csel = h('select', { 'aria-label': '对应' + (axisField ? axisField.names[0] : catDef.keyFrom), dataset: { testid: 'color-select' } });
    for (const c of style.fields[catDef.keyFrom] || []) {
      const opt = h('option', { value: c, text: c });
      if (c === im.colorKey) opt.selected = true;
      csel.append(opt);
    }
    csel.addEventListener('change', () => { im.colorKey = csel.value; recompute(style); renderStyles(); });
    thumb.append(csel);
  }
  // 排序与删除（同类内移动）
  const ops = h('div', { class: 'ops' });
  const siblings = style.images.filter((x) => x.category === im.category);
  const pos = siblings.indexOf(im);
  const up = h('button', { text: '↑', disabled: pos <= 0 ? 'disabled' : null, onclick: () => moveImage(style, im, -1) });
  const down = h('button', { text: '↓', disabled: pos >= siblings.length - 1 ? 'disabled' : null, onclick: () => moveImage(style, im, 1) });
  const del = h('button', { text: '删除', onclick: () => removeImage(style, im) });
  ops.append(up, down, del);
  thumb.append(ops);
  return thumb;
}

function moveImage(style, im, dir) {
  const siblings = style.images.filter((x) => x.category === im.category);
  const pos = siblings.indexOf(im);
  const other = siblings[pos + dir];
  if (!other) return;
  const i1 = style.images.indexOf(im);
  const i2 = style.images.indexOf(other);
  style.images[i1] = other;
  style.images[i2] = im;
  renderStyles();
}

function removeImage(style, im) {
  URL.revokeObjectURL(im.url);
  style.images = style.images.filter((x) => x !== im);
  recompute(style);
  renderStyles();
}

async function addImages(style, files) {
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const probe = probeImage(bytes);
    if (!probe.format || !currentTpl.images.accept.includes(probe.format)) {
      showNotice(`图片 ${file.name} 不受支持（${probe.reason || '格式不在接受范围'}），已跳过。`, 'error');
      continue;
    }
    const hasMain = style.images.some((x) => x.category === 'main');
    style.images.push({
      uid: ++imgSeq,
      bytes,
      category: hasMain ? 'detail' : 'main',
      colorKey: null,
      sourceName: file.name,
      probe,
      url: URL.createObjectURL(new Blob([bytes])),
    });
  }
  recompute(style);
  renderStyles();
}

// webp -> JPEG（canvas 转换，保持像素尺寸）
async function convertWebp(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas 转 JPEG 失败'))), 'image/jpeg', 0.92);
  });
  return new Uint8Array(await blob.arrayBuffer());
}

async function downloadBlob(bytes, filename, mime) {
  // APK 壳内：经 JS 桥写系统下载文件夹（WebView 拿不到 blob: 数据）
  if (typeof window.ItgNative !== 'undefined' && typeof window.ItgNative.saveFile === 'function') {
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(new Blob([bytes], { type: mime }));
    });
    const res = String(window.ItgNative.saveFile(base64, filename, mime));
    if (!res.startsWith('OK:')) throw new Error(res.replace(/^ERR:/, '') || '保存失败');
    return { via: 'bridge', name: res.slice(3) };
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { via: 'anchor', name: filename };
}

async function packStyle(style) {
  try {
    const images = style.images.map((im, i) => ({ ...im, order: i }));
    const pack = await generatePack(style.fields, images, currentTpl, { convertWebp });
    const saved = await downloadBlob(pack.zipBytes, pack.zipName, 'application/zip');
    const warn = pack.warnings.length ? '\n提醒：\n' + pack.warnings.join('\n') : '';
    const where = saved.via === 'bridge' ? `已保存到下载文件夹：${saved.name}` : `已生成 ${pack.zipName}`;
    style.packMsg = { kind: 'ok', text: `${where}（${(pack.zipBytes.length / 1024).toFixed(1)} KB，${pack.combos} 个规格组合）。${warn}` };
  } catch (err) {
    style.packMsg = { kind: 'error', text: `出包失败：${err.message}` };
  }
  renderStyles();
}

async function downloadXlsxOnly(style) {
  try {
    if (style.errors.length) throw new Error('请先修正错误：\n' + style.errors.join('\n'));
    const xlsx = await buildInfoTableXlsx(style.fields, style.combos, style.comboStocks, currentTpl);
    const saved = await downloadBlob(xlsx, `${style.fields.code}-信息表.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    style.packMsg = { kind: 'ok', text: saved.via === 'bridge' ? `信息表已保存到下载文件夹：${saved.name}。` : '信息表已下载（仅表格，未打包图片）。' };
  } catch (err) {
    style.packMsg = { kind: 'error', text: `下载失败：${err.message}` };
  }
  renderStyles();
}

async function downloadJsonOnly(style) {
  try {
    if (style.errors.length) throw new Error('请先修正错误：\n' + style.errors.join('\n'));
    const json = buildRecordsJson(style.fields, style.combos, style.comboStocks, currentTpl);
    const saved = await downloadBlob(new TextEncoder().encode(json), `${style.fields.code}-记录.json`, 'application/json');
    style.packMsg = { kind: 'ok', text: saved.via === 'bridge' ? `JSON 已保存到下载文件夹：${saved.name}。` : '记录 JSON 已下载（每行一个规格组合 + 库存）。' };
  } catch (err) {
    style.packMsg = { kind: 'error', text: `下载失败：${err.message}` };
  }
  renderStyles();
}

async function downloadCsvOnly(style) {
  try {
    if (style.errors.length) throw new Error('请先修正错误：\n' + style.errors.join('\n'));
    const csv = buildRecordsCsv(style.fields, style.combos, style.comboStocks, currentTpl);
    const saved = await downloadBlob(new TextEncoder().encode(csv), `${style.fields.code}-记录.csv`, 'text/csv');
    style.packMsg = { kind: 'ok', text: saved.via === 'bridge' ? `CSV 已保存到下载文件夹：${saved.name}。` : '记录 CSV 已下载（每行一个规格组合 + 库存）。' };
  } catch (err) {
    style.packMsg = { kind: 'error', text: `下载失败：${err.message}` };
  }
  renderStyles();
}

$('#downloadAllBtn').addEventListener('click', async () => {
  for (const style of styles) {
    await packStyle(style);
    await new Promise((r) => setTimeout(r, 300));
  }
});

// ---------- 更新检查（只提示，用户确认才换版） ----------
let swRegistration = null;
let pendingUpdate = null;

async function getUpdateCheckUrl() {
  // 桌面壳：主进程配置的版本文件地址（空 = 未配置）
  try {
    const u = await window.ItgDesktop?.getUpdateUrl?.();
    if (u) return u;
  } catch { /* 无桥或桥异常：往下试 */ }
  // APK 壳：原生配置的版本文件地址（空 = 未配置，读内置 version.json，恒等于当前版）
  try {
    const u = window.ItgNative?.getUpdateUrl?.();
    if (u) return u;
  } catch { /* 无桥或桥异常：走默认 */ }
  return 'version.json';
}

async function checkUpdate() {
  try {
    const res = await fetch(await getUpdateCheckUrl(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    if (data.version && data.version !== APP_VERSION) {
      pendingUpdate = data;
      $('#updateText').textContent = `发现新版本 v${data.version}：${data.notes || ''}（当前 v${APP_VERSION}）`;
      $('#updateBanner').hidden = false;
    }
  } catch {
    // 离线或取不到版本文件：静默，本机照常工作
  }
}
$('#updateLaterBtn').addEventListener('click', () => { $('#updateBanner').hidden = true; });
$('#updateNowBtn').addEventListener('click', async () => {
  $('#updateText').textContent = '正在更新…';
  try {
    // 桌面壳且新版带安装包地址：主进程下载 + 打开走系统安装确认
    if (pendingUpdate?.exeUrl && typeof window.ItgDesktop?.downloadUpdate === 'function') {
      await window.ItgDesktop.downloadUpdate(pendingUpdate.exeUrl);
      $('#updateText').textContent = '新版安装包已下载并打开，请按系统提示安装。';
      return;
    }
    // APK 壳且新版带安装包地址：原生下载 + 系统安装确认
    if (pendingUpdate?.apkUrl && typeof window.ItgNative?.downloadApk === 'function') {
      window.ItgNative.downloadApk(pendingUpdate.apkUrl);
      $('#updateText').textContent = '已开始下载新版安装包，下载完成后按系统提示安装。';
      return;
    }
    if (!swRegistration) {
      // register() 的 promise 可能还在等新 worker 安装完成才 resolve（横幅已出、变量还空），
      // 直接现取已有注册，不等它；取不到才算真未注册。
      try { swRegistration = await navigator.serviceWorker.getRegistration() || null; } catch { swRegistration = null; }
    }
    if (!swRegistration) throw new Error('Service Worker 未注册');
    await swRegistration.update();
    const worker = swRegistration.installing || swRegistration.waiting;
    if (worker) {
      // 不用等 worker 到 installed 再发消息：installing 中的 worker 也能收 postMessage，
      // skipWaiting() 会在安装完成后立即接管；等 installed 的 10 秒兜底只会拖长更新。
      // 只等 controllerchange（新 worker 接管）再刷新；不等就直接刷新会把新 worker 晾在 waiting 里。
      const tookOver = new Promise((resolve) => {
        const onChange = () => {
          navigator.serviceWorker.removeEventListener('controllerchange', onChange);
          resolve(true);
        };
        navigator.serviceWorker.addEventListener('controllerchange', onChange);
        setTimeout(() => {
          navigator.serviceWorker.removeEventListener('controllerchange', onChange);
          resolve(false);
        }, 20000);
      });
      worker.postMessage({ type: 'SKIP_WAITING' });
      await tookOver;
    }
    // 新 worker 接管后刷新；若无新 worker（版本文件已新但 sw 未变），直接刷新取新文件
    location.reload();
  } catch (err) {
    $('#updateText').textContent = `更新失败：${err.message}。可稍后重试，或重新打开本页。`;
  }
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  navigator.serviceWorker.register('sw.js').then((reg) => { swRegistration = reg; }).catch(() => {});
}

// ---------- 启动 ----------
(async function init() {
  try {
    currentTpl = await loadBundledTemplates();
    refreshTemplateSelect();
    checkUpdate();
  } catch (err) {
    showNotice(`初始化失败：${err.message}`, 'error');
  }
})();

// 供自动化验收读取状态（无界面影响）
window.__itg = {
  get version() { return APP_VERSION; },
  get styles() { return styles; },
  get template() { return currentTpl; },
  get view() { return currentView; },
  get editDraft() { return editDraft; },
  get templates() { return [...templates.values()].map((t) => `${t.id}@${t.version}`); },
};
