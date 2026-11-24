// deps.js —— 第三方库解析：浏览器里用预加载的 UMD 全局变量，Node 里用已安装的包。
// 核心模块不直接 import 它们，全部经这里拿，保证同一份核心能在 PWA / APK / EXE / Node 测试里跑。

let _xlsx = null;
let _fflate = null;

export async function getXLSX() {
  if (_xlsx) return _xlsx;
  if (typeof globalThis !== 'undefined' && globalThis.XLSX) {
    _xlsx = globalThis.XLSX;
    return _xlsx;
  }
  const mod = await import('xlsx');
  _xlsx = mod.default ?? mod;
  return _xlsx;
}

export async function getFflate() {
  if (_fflate) return _fflate;
  if (typeof globalThis !== 'undefined' && globalThis.fflate) {
    _fflate = globalThis.fflate;
    return _fflate;
  }
  const mod = await import('fflate');
  _fflate = mod.default ?? mod;
  return _fflate;
}

// 供测试或壳注入：显式指定已加载的库。
export function setDeps({ XLSX, fflate } = {}) {
  if (XLSX) _xlsx = XLSX;
  if (fflate) _fflate = fflate;
}
