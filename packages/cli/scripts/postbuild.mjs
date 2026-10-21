// 构建后处理：确保 dist/index.js 可被当作可执行文件（shebang + 权限位）
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

if (!existsSync(entry)) {
  console.error('[postbuild] dist/index.js 不存在，请先完成 TypeScript 编译');
  process.exit(1);
}

let content = readFileSync(entry, 'utf8');
if (!content.startsWith('#!')) {
  content = '#!/usr/bin/env node\n' + content;
  writeFileSync(entry, content, 'utf8');
  console.log('[postbuild] 已补写 shebang');
}

if (process.platform !== 'win32') {
  try {
    chmodSync(entry, 0o755);
  } catch {
    /* 忽略权限失败 */
  }
}

console.log('[postbuild] bundle-guardian CLI 已就绪');
