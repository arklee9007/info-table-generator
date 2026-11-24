// 从商城样表（素材包模板/信息表.xlsx）提取静态 OOXML 部件，生成 core/ooxml-parts.js。
// 样板来自 openpyxl 产出的真实样表，解析器已验证可读；只提取 styles 与 theme 两个静态部件。
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';

const sample = readFileSync('/home/hatch/workspace/miniprogram-mall/素材包模板/信息表.xlsx');
const parts = unzipSync(new Uint8Array(sample));
const dec = new TextDecoder('utf-8');
const styles = dec.decode(parts['xl/styles.xml']);
const theme = dec.decode(parts['xl/theme/theme1.xml']);
if (!styles.includes('<styleSheet') || !theme.includes('<a:theme')) throw new Error('样板提取失败');

const out = `// ooxml-parts.js —— 由 tools/extract-parts.mjs 从商城样表提取的静态 OOXML 部件。
// 来源：~/workspace/miniprogram-mall/素材包模板/信息表.xlsx（openpyxl 产出，解析器已验证）。
// 请勿手改；样表变化时重新运行提取脚本。

export const STYLES_XML = ${JSON.stringify(styles)};
export const THEME_XML = ${JSON.stringify(theme)};
`;
writeFileSync(new URL('../core/ooxml-parts.js', import.meta.url), out);
console.log('wrote core/ooxml-parts.js, styles', styles.length, 'theme', theme.length);
