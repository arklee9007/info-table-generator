// decode.js —— 文本文件解码：BOM 嗅探 + UTF-8 严格解码，失败回退 GBK（记事本 ANSI 存盘）。
// TextDecoder 在现代浏览器与 Node 里都有，'gbk' 属 WHATWG 编码标准，跨端一致。

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// bytes: Uint8Array。返回 { text, encoding }，encoding 供界面展示与排障。
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // BOM 嗅探
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    return { text: stripBom(new TextDecoder('utf-16le').decode(b.subarray(2))), encoding: 'UTF-16LE' };
  }
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    return { text: stripBom(new TextDecoder('utf-16be').decode(b.subarray(2))), encoding: 'UTF-16BE' };
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'UTF-8(BOM)' };
  }
  // 无 BOM：先 UTF-8 严格解码
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    return { text: stripBom(text), encoding: 'UTF-8' };
  } catch {
    // 回退 GBK（Windows 记事本默认 ANSI 存盘的中文文件）
    const text = new TextDecoder('gbk').decode(b);
    return { text: stripBom(text), encoding: 'GBK' };
  }
}

// 统一换行符为 \n，并把全角冒号保留（字段识别同时认半角与全角冒号）。
export function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}
