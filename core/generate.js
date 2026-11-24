// generate.js —— 图片标准命名 + 素材包打包。
// 包结构：单款号文件夹形态（<款号>/信息表.xlsx + <款号>/<图片>），解析器明文支持；
// 款号取文件夹名，ZIP 文件名即使被浏览器改写也不影响款号（实测 headless 下载会丢中文文件名）。

import { getFflate } from './deps.js';
import { probeImage } from './images.js';
import { buildInfoTableXlsx } from './xlsx-write.js';
import { validateStyle } from './validate.js';

function extFor(format) {
  if (format === 'png') return '.png';
  if (format === 'jpeg') return '.jpg';
  if (format === 'webp') return '.jpg'; // webp 出包前已转 JPEG
  return '.bin';
}

// 按模板 naming 规则给图片命名。images 须已按展示/拖拽顺序排好（同类内按 order）。
// convertWebp: async (bytes) => jpegBytes，调用方注入（浏览器用 canvas）；缺省时 webp 报错。
export async function nameImages(images, tpl, convertWebp) {
  const cats = Object.fromEntries(tpl.images.categories.map((c) => [c.key, c]));
  const counters = {};
  const named = [];
  const sorted = [...images].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const im of sorted) {
    const cat = cats[im.category];
    if (!cat) throw new Error(`未知图片类别：${im.category}`);
    const probe = probeImage(im.bytes);
    if (!probe.format) throw new Error(`图片无法识别：${im.sourceName || ''}`);
    let bytes = im.bytes;
    let format = probe.format;
    if (format === 'webp') {
      if (typeof convertWebp !== 'function') {
        throw new Error(`图片 ${im.sourceName || ''} 是 webp 格式，须先转 JPEG（解析器不接受 webp）`);
      }
      bytes = await convertWebp(im.bytes);
      format = 'jpeg';
      const re = probeImage(bytes);
      if (re.format !== 'jpeg') throw new Error(`webp 转 JPEG 失败：${im.sourceName || ''}`);
    }
    counters[im.category] = (counters[im.category] || 0) + 1;
    let name = cat.naming
      .replace('{index}', String(counters[im.category]))
      .replace('{key}', im.colorKey || '');
    name += extFor(format);
    named.push({ ...im, bytes, format, fileName: name });
  }
  return named;
}

// 生成一款的素材包。返回 { zipName, zipBytes, xlsxBytes, files: [{name, bytes}] }。
// 校验失败抛 Error（message 为全部错误行的拼接）。
export async function generatePack(fields, images, tpl, { convertWebp } = {}) {
  const { errors, warnings, combos, comboStocks } = validateStyle(fields, images, tpl);
  if (errors.length) {
    throw new Error('出包前校验未通过：\n' + errors.map((e) => '· ' + e).join('\n'));
  }
  const named = await nameImages(images, tpl, convertWebp);
  const xlsxBytes = await buildInfoTableXlsx(fields, combos, comboStocks, tpl);
  const fflate = await getFflate();
  const prefix = fields.code + '/';
  const files = { [prefix + '信息表.xlsx']: xlsxBytes };
  for (const im of named) {
    const key = prefix + im.fileName;
    if (files[key]) throw new Error(`图片命名冲突：${im.fileName}`);
    files[key] = im.bytes;
  }
  const zipBytes = fflate.zipSync(files, { level: 6 });
  if (zipBytes.length > tpl.limits.maxZipBytes) {
    const breakdown = Object.entries(files)
      .map(([n, b]) => `${n} ${(b.length / 1024).toFixed(0)}KB`)
      .join('、');
    throw new Error(
      `素材包 ${(zipBytes.length / 1024 / 1024).toFixed(2)} MB，超出 2 MB 上限（后台会拒绝）。请压缩图片后重试。包内：${breakdown}`
    );
  }
  return {
    zipName: `${fields.code}.zip`,
    zipBytes,
    xlsxBytes,
    files: Object.entries(files).map(([name, bytes]) => ({ name, bytes })),
    warnings,
    combos: combos.length,
  };
}
