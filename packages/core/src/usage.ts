/**
 * 「实际用到这个包的哪些导出」分析
 *
 * `why lodash` 只告诉你谁引入了它还不够 —— 真正能推动优化的是下一句：
 * 「你只用了 sortBy / debounce / cloneDeep 三个方法，却付了整个库的钱」。
 *
 * 实现上只解析**引用方那个文件**的 import 语句（链路上倒数第二个节点），
 * 不扫全项目，成本可以忽略。
 */

import fs from 'node:fs';

export interface UsageInfo {
  /** 具名导入的成员，如 ['sortBy', 'debounce'] */
  named: string[];
  /** 默认导入的本地变量名，如 `_` */
  defaultAlias?: string;
  /** 命名空间导入的别名，如 `echarts` */
  namespaceAlias?: string;
  /** 是否用了 require() */
  viaRequire: boolean;
  /** 是否整包导入（默认导入或命名空间导入）—— 这是 tree-shaking 失效的信号 */
  isWholePackage: boolean;
  /** 命中的 import 语句原文（最多 3 条，用于终端展示） */
  statements: string[];
}

const EMPTY: UsageInfo = {
  named: [],
  viaRequire: false,
  isWholePackage: false,
  statements: [],
};

/** 判断 import 的 specifier 是否指向目标包（含子路径与 pnpm 路径） */
function matchesPkg(spec: string, pkg: string): boolean {
  return spec === pkg || spec.startsWith(pkg + '/');
}

export function extractImports(code: string, pkg: string): UsageInfo {
  const info: UsageInfo = { ...EMPTY, named: [], statements: [] };
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // import def, { a, b as c } from 'pkg'
  const mixedRe = new RegExp(
    `import\\s+([A-Za-z_$][\\w$]*)\\s*,\\s*\\{([^}]*)\\}\\s*from\\s*['"\`]([^'"\`]+)['"\`]`,
    'g'
  );
  // import { a, b as c } from 'pkg'
  const namedRe = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  // import def from 'pkg'
  const defaultRe = new RegExp(
    `import\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"\`]([^'"\`]+)['"\`]`,
    'g'
  );
  // import * as ns from 'pkg'
  const nsRe = new RegExp(`import\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  // require('pkg')
  const requireRe = new RegExp(`require\\s*\\(\\s*['"\`]([^'"\`]+)['"\`]\\s*\\)`, 'g');
  // 子路径：import sortBy from 'pkg/sortBy'
  const subRe = new RegExp(
    `import\\s+(?:[A-Za-z_$][\\w$]*|\\*\\s*as\\s+[A-Za-z_$][\\w$]*|\\{[^}]*\\})\\s*from\\s*['"\`]${escaped}\\/([^'"\`]+)['"\`]`,
    'g'
  );

  let m: RegExpExecArray | null;

  while ((m = mixedRe.exec(code)) !== null) {
    if (!matchesPkg(m[3], pkg)) continue;
    info.defaultAlias = info.defaultAlias ?? m[1];
    info.isWholePackage = true;
    pushNamed(info, m[2]);
    pushStatement(info, m[0]);
  }
  while ((m = namedRe.exec(code)) !== null) {
    if (!matchesPkg(m[2], pkg)) continue;
    pushNamed(info, m[1]);
    pushStatement(info, m[0]);
  }
  while ((m = defaultRe.exec(code)) !== null) {
    if (!matchesPkg(m[2], pkg)) continue;
    // `import sortBy from 'lodash/sortBy'` 是按需引入，不能算整包
    if (m[2].includes('/')) {
      const leaf = m[2].split('/').pop() ?? m[2];
      if (!info.named.includes(leaf)) info.named.push(leaf);
      pushStatement(info, m[0]);
      continue;
    }
    info.defaultAlias = info.defaultAlias ?? m[1];
    info.isWholePackage = true;
    pushStatement(info, m[0]);
  }
  while ((m = nsRe.exec(code)) !== null) {
    if (!matchesPkg(m[2], pkg)) continue;
    if (m[2].includes('/')) continue; // 子路径的 namespace 导入同样视为按需
    info.namespaceAlias = info.namespaceAlias ?? m[1];
    info.isWholePackage = true;
    pushStatement(info, m[0]);
  }
  while ((m = requireRe.exec(code)) !== null) {
    if (!matchesPkg(m[1], pkg)) continue;
    info.viaRequire = true;
    info.isWholePackage = true;
  }
  while ((m = subRe.exec(code)) !== null) {
    // 子路径导入是「按需」的好习惯，记录下来供展示
    const leaf = m[1].split('/').pop() ?? m[1];
    if (!info.named.includes(leaf)) info.named.push(leaf);
  }

  return info;
}

function pushNamed(info: UsageInfo, raw: string): void {
  for (const part of raw.split(',')) {
    const name = part.trim().split(/\s+as\s+/)[0].trim();
    if (!name) continue;
    if (!info.named.includes(name)) info.named.push(name);
  }
}

function pushStatement(info: UsageInfo, text: string): void {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (info.statements.length < 3 && !info.statements.includes(oneLine)) {
    info.statements.push(oneLine);
  }
}

/** 读文件并分析（文件不存在返回 null） */
export function readFileImports(file: string, pkg: string): UsageInfo | null {
  try {
    return extractImports(fs.readFileSync(file, 'utf8'), pkg);
  } catch {
    return null;
  }
}

/** 生成给终端看的一句话摘要 */
export function describeUsage(info: UsageInfo): string {
  const parts: string[] = [];
  if (info.named.length > 0) parts.push(info.named.join(' · '));
  if (info.defaultAlias) parts.push(`默认导入 ${info.defaultAlias}`);
  if (info.namespaceAlias) parts.push(`命名空间 ${info.namespaceAlias}`);
  if (info.viaRequire) parts.push('require()');
  return parts.length > 0 ? parts.join(' · ') : '未解析到具名导入';
}
