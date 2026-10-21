// 告诉 Node：dist/cjs 下的 .js 按 CommonJS 解析
// （根目录 package.json 是 "type": "module"，不写这个 CJS 产物会被当成 ESM 而报错）
import { writeFileSync } from 'node:fs';

writeFileSync(
  new URL('../dist/cjs/package.json', import.meta.url),
  JSON.stringify({ type: 'commonjs' }, null, 2) + '\n',
  'utf8'
);

console.log('[postbuild] dist/cjs/package.json → { "type": "commonjs" }');
