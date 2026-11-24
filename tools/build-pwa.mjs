// tools/build-pwa.mjs —— 组装 PWA 发行目录 dist-pwa/。
// 来源：app/（界面）+ core/（核心）+ vendor/*.js（离线库）+ templates/*.json。
// 注入：index.html 的 app-version、sw.js 的缓存名与预缓存清单。
// 校验：入口 import 图全部可达、manifest 图标存在。失败即退出非零，不出半成品。

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-pwa');

const versionInfo = JSON.parse(readFileSync(join(ROOT, 'app/version.json'), 'utf-8'));
const VERSION = versionInfo.version;
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`version.json 版本格式无效：${VERSION}`);

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1) 复制
cpSync(join(ROOT, 'app'), DIST, { recursive: true });
cpSync(join(ROOT, 'core'), join(DIST, 'core'), { recursive: true });
mkdirSync(join(DIST, 'vendor'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'vendor')).filter((x) => x.endsWith('.js'))) {
  cpSync(join(ROOT, 'vendor', f), join(DIST, 'vendor', f));
}
mkdirSync(join(DIST, 'templates'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'templates')).filter((x) => x.endsWith('.json'))) {
  cpSync(join(ROOT, 'templates', f), join(DIST, 'templates', f));
}

// 2) 注入版本
const indexPath = join(DIST, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf-8')
  .replace('<meta name="app-version" content="0.0.0-dev">', `<meta name="app-version" content="${VERSION}">`));

// 3) 预缓存清单 = dist 内全部文件（相对路径，sw.js 自身除外；version.json 在列，供离线回退）
function walk(dir, base = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel));
    else if (e.isFile() && rel !== 'sw.js') out.push('./' + rel);
  }
  return out.sort();
}
const precache = ['./', ...walk(DIST)];
const swPath = join(DIST, 'sw.js');
const swSrc = readFileSync(swPath, 'utf-8')
  .replace('__VERSION__', VERSION)
  .replace('__PRECACHE__', JSON.stringify(precache));
if (swSrc.includes('__VERSION__') || swSrc.includes('__PRECACHE__')) throw new Error('sw.js 占位符未替换干净');
writeFileSync(swPath, swSrc);

// 4) 校验：import 图可达
const importRe = /(?:from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const checked = new Set();
function checkFile(absPath) {
  if (checked.has(absPath)) return;
  checked.add(absPath);
  if (!existsSync(absPath)) throw new Error(`引用缺失：${absPath}`);
  const src = readFileSync(absPath, 'utf-8');
  for (const m of src.matchAll(importRe)) {
    const spec = m[1] || m[2];
    if (!spec.startsWith('.')) continue; // 裸包名只在 Node 路径出现，浏览器走 UMD 全局
    const target = resolve(dirname(absPath), spec);
    if (!existsSync(target)) throw new Error(`${absPath} 引用的 ${spec} 不存在`);
    checkFile(target);
  }
}
checkFile(join(DIST, 'app.js'));
checkFile(join(DIST, 'core/index.js'));

// 5) 校验：manifest 图标存在
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.webmanifest'), 'utf-8'));
for (const icon of manifest.icons) {
  if (!existsSync(join(DIST, icon.src))) throw new Error(`manifest 图标缺失：${icon.src}`);
}
// 6) 校验：index.html 引用的本地脚本/样式存在
const html = readFileSync(indexPath, 'utf-8');
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const ref = m[1];
  if (/^(https?:|#|data:)/.test(ref)) continue;
  if (!existsSync(join(DIST, ref))) throw new Error(`index.html 引用的 ${ref} 不存在`);
}

// 7) 清单
let total = 0;
let count = 0;
for (const rel of walk(DIST)) {
  total += statSync(join(DIST, rel.replace(/^\.\//, ''))).size;
  count++;
}
total += statSync(swPath).size;
count++;
console.log(`PWA 构建完成：v${VERSION}，${count} 个文件，${(total / 1024).toFixed(0)} KB -> dist-pwa/`);
console.log('预缓存文件数：', precache.length);
