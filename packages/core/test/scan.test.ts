import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanModuleGraph, collectSourcePaths } from '../src/scan.js';
import { readPackageMeta, resetPackageMetaCache } from '../src/pkg-meta.js';

/**
 * 这两个模块都依赖真实文件系统，测试里用项目内的临时目录造 fixture。
 * （不用 os.tmpdir()：某些受管环境下系统 temp 目录会 EPERM。）
 */
function makeTmp(prefix: string): string {
  // mkdtempSync 在 Windows 上对中文/特殊字符敏感，这里用纯 ASCII 前缀
  return fs.mkdtempSync(path.join(os.tmpdir().startsWith('C') ? process.cwd() : process.cwd(), `.tmp-${prefix}-`));
}

function writeFile(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file.replace(/\\/g, '/');
}

let tmp = '';

beforeAll(() => {
  tmp = makeTmp('scan');
});

afterAll(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
});

describe('scanModuleGraph · 离线源码扫描建图', () => {
  it('还原相对路径 import / 动态 import / require', () => {
    const root = path.join(tmp, 'project');
    const entry = writeFile(
      path.join(root, 'src/main.ts'),
      `import { helper } from './utils/helper';\nimport 'dayjs';\nexport { x } from './api/auth';\nconst lazy = () => import('./views/Dashboard');\nconst cjs = require('./legacy');\n`
    );
    const helper = writeFile(path.join(root, 'src/utils/helper.ts'), 'export const helper = 1;');
    const auth = writeFile(path.join(root, 'src/api/auth.ts'), 'export const x = 1;');
    const dash = writeFile(path.join(root, 'src/views/Dashboard.vue'), '<template/>');
    const legacy = writeFile(path.join(root, 'src/legacy.js'), 'module.exports = 1;');
    const dayjs = writeFile(path.join(root, 'node_modules/dayjs/index.js'), 'module.exports = 1;');

    const sources = [entry, helper, auth, dash, legacy, dayjs];
    const graph = scanModuleGraph(sources, root);

    const main = graph.find((m) => m.id === entry)!;
    expect(main).toBeDefined();
    // 相对路径 + 扩展名补全
    expect(main.importedIds).toContain(helper);
    // export ... from
    expect(main.importedIds).toContain(auth);
    // 动态 import
    expect(main.importedIds).toContain(dash);
    // require
    expect(main.importedIds).toContain(legacy);
    // bare specifier → 命中包目录下层级最浅的文件
    expect(main.importedIds).toContain(dayjs);
  });

  it('node_modules 里的文件保留为节点，但不再深入解析', () => {
    const root = path.join(tmp, 'project2');
    const pkgEntry = writeFile(path.join(root, 'node_modules/big/index.js'), `import './deep/a';`);
    const pkgDeep = writeFile(path.join(root, 'node_modules/big/deep/a.js'), 'export const a = 1;');
    const app = writeFile(path.join(root, 'src/app.ts'), `import 'big';`);

    const graph = scanModuleGraph([pkgEntry, pkgDeep, app], root);
    const deep = graph.find((m) => m.id === pkgDeep)!;

    expect(deep).toBeDefined();      // 节点存在
    expect(deep.importedIds).toEqual([]); // 但不再往里解析
  });

  it('路径别名能把断开的链接接回来', () => {
    const root = path.join(tmp, 'project3');
    const view = writeFile(path.join(root, 'src/views/Dashboard.vue'), `import { formatDate } from '@date';`);
    const date = writeFile(path.join(root, 'src/utils/date.ts'), `import moment from 'moment';`);
    const moment = writeFile(path.join(root, 'node_modules/moment/moment.js'), 'module.exports = 1;');

    const withoutAlias = scanModuleGraph([view, date, moment], root);
    expect(withoutAlias.find((m) => m.id === view)!.importedIds).not.toContain(date);

    const withAlias = scanModuleGraph([view, date, moment], root, {
      alias: { '@date': date },
    });
    expect(withAlias.find((m) => m.id === view)!.importedIds).toContain(date);
  });

  it('读不到的文件保留节点而不抛错', () => {
    const root = path.join(tmp, 'project4');
    const graph = scanModuleGraph([path.join(root, 'deleted.ts').replace(/\\/g, '/')], root);
    expect(graph).toHaveLength(1);
    expect(graph[0].importedIds).toEqual([]);
  });
});

describe('collectSourcePaths', () => {
  it('合并多个 sourcemap 的 sources 并去重', () => {
    const set = collectSourcePaths([
      { sources: ['a.ts', 'b.ts'] },
      null,
      { sources: ['b.ts', 'c.ts'] },
    ]);
    expect([...set].sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

describe('readPackageMeta · ESM 入口探测', () => {
  beforeAll(() => resetPackageMetaCache());

  it('main 只有 CJS、无 module/exports → 判定为纯 CJS', () => {
    const root = path.join(tmp, 'meta1');
    writeFile(path.join(root, 'node_modules/fake-cjs/package.json'), JSON.stringify({ name: 'fake-cjs', main: 'index.js' }));
    const meta = readPackageMeta('fake-cjs', root);
    expect(meta.found).toBe(true);
    expect(meta.hasEsm).toBe(false);
    expect(meta.main).toBe('index.js');
  });

  it('有 module 字段 → 判定为提供 ESM', () => {
    const root = path.join(tmp, 'meta2');
    writeFile(path.join(root, 'node_modules/fake-esm/package.json'), JSON.stringify({ name: 'fake-esm', main: 'index.js', module: 'esm/index.js' }));
    expect(readPackageMeta('fake-esm', root).hasEsm).toBe(true);
  });

  it('type=module 也算 ESM', () => {
    const root = path.join(tmp, 'meta3');
    writeFile(path.join(root, 'node_modules/fake-mjs/package.json'), JSON.stringify({ name: 'fake-mjs', type: 'module' }));
    expect(readPackageMeta('fake-mjs', root).hasEsm).toBe(true);
  });

  it('有 esm/ 目录也算（dayjs 就是这种形态）', () => {
    const root = path.join(tmp, 'meta4');
    writeFile(path.join(root, 'node_modules/fake-dir/package.json'), JSON.stringify({ name: 'fake-dir', main: 'index.js' }));
    writeFile(path.join(root, 'node_modules/fake-dir/esm/index.js'), 'export const a = 1;');
    expect(readPackageMeta('fake-dir', root).hasEsm).toBe(true);
  });

  it('包不存在时 found=false，不抛错', () => {
    const root = path.join(tmp, 'meta5');
    expect(readPackageMeta('nope', root).found).toBe(false);
  });
});
