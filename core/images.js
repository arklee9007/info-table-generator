// images.js —— 图片格式嗅探与像素尺寸读取（只读文件头，不解码全图）。
// 格式按魔数判定，不认扩展名；解析器只接受 PNG/JPEG，webp 须在出包前转 JPEG。

export function sniffImageFormat(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
  if (b.length >= 6 && (String.fromCharCode(...b.slice(0, 6)) === 'GIF87a' || String.fromCharCode(...b.slice(0, 6)) === 'GIF89a')) return 'gif';
  return null;
}

function readU32BE(b, off) {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

function pngDimensions(b) {
  // IHDR：8 字节签名 + 4 字节长度 + 4 字节 'IHDR'，宽/高各 4 字节大端
  if (b.length < 24) return null;
  if (String.fromCharCode(...b.slice(12, 16)) !== 'IHDR') return null;
  return { width: readU32BE(b, 16), height: readU32BE(b, 20) };
}

function jpegDimensions(b) {
  // 扫描 marker 找 SOF0/1/2（0xC0/0xC1/0xC2）；遇 SOS 停止（SOF 必在 SOS 之前）
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS：没找到 SOF
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      return { width, height };
    }
    i += 2 + len;
  }
  return null;
}

function webpDimensions(b) {
  if (b.length < 30) return null;
  const chunk = String.fromCharCode(...b.slice(12, 16));
  if (chunk === 'VP8X') {
    if (b.length < 30) return null;
    const width = (b[24] | (b[25] << 8) | (b[26] << 16)) + 1;
    const height = (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
    return { width, height };
  }
  if (chunk === 'VP8L') {
    if (b.length < 25) return null;
    const width = (b[21] | ((b[22] & 0x3f) << 8)) + 1;
    const height = (((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10))) + 1;
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    if (b.length < 30) return null;
    const width = (b[26] | ((b[27] & 0x3f) << 8));
    const height = (b[28] | ((b[29] & 0x3f) << 8));
    return { width, height };
  }
  return null;
}

// 返回 { format, width, height }；无法识别或读不出尺寸时 format/dims 为 null 并附 reason。
export function probeImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const format = sniffImageFormat(b);
  if (!format) return { format: null, width: null, height: null, reason: '不是 PNG/JPEG/WebP/GIF 文件' };
  let dims = null;
  if (format === 'png') dims = pngDimensions(b);
  else if (format === 'jpeg') dims = jpegDimensions(b);
  else if (format === 'webp') dims = webpDimensions(b);
  if (format === 'gif') return { format, width: null, height: null, reason: 'GIF 不受支持，请转 PNG/JPEG' };
  if (!dims) return { format, width: null, height: null, reason: '文件头损坏，读不出像素尺寸' };
  return { format, width: dims.width, height: dims.height, reason: null };
}
