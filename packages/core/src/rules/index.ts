/**
 * 体积治理规则集
 *
 * 每条规则是 { id, defaultLevel, description, check(ctx) } 的纯函数。
 * 规则与引擎解耦：用户可以通过 .guardianrc / options.rules 覆盖级别或关闭，
 * 也可以用 Rule 接口注入自己的规则。
 *
 * 统一产出 Diagnostic[]：
 *   { ruleId, level, pkg?, bytes?, msg, where?, fix?, estimatedSaving? }
 * 四种 reporter 消费同一份结构，保证终端 / HTML / PR 评论三处口径一致。
 */

import type { Diagnostic, DiagnosticLevel, PkgStat, ReplacementMap, Rule, RuleContext } from '../types.js';
import { readPackageMeta } from '../pkg-meta.js';
import { parseSize } from '../utils.js';

/** 常见重包的替换建议：包名 → { 替代方案, 典型 gzip 降幅 } */
export const REPLACEMENTS: ReplacementMap = {
  moment: { to: 'dayjs', saving: 0.96 },
  'moment-timezone': { to: 'dayjs/plugin/timezone', saving: 0.9 },
  lodash: { to: 'lodash-es', saving: 0.82 },
  underscore: { to: 'lodash-es', saving: 0.6 },
  jquery: { to: '原生 DOM API', saving: 1 },
  'core-js': { to: '按需 polyfill / useBuiltIns: usage', saving: 0.85 },
  'crypto-js': { to: 'node:crypto / Web Crypto', saving: 0.78 },
  JSEncrypt: { to: 'Web Crypto RSA-OAEP', saving: 0.7 },
};

const DEFAULT_MIN_BYTES = parseSize('100 KB');

function levelOf(ctx: RuleContext, id: string, fallback: DiagnosticLevel): DiagnosticLevel | 'off' {
  const cfg = ctx.options.rules?.[id];
  if (!cfg) return fallback;
  if (Array.isArray(cfg)) return cfg[0] as DiagnosticLevel;
  return cfg as DiagnosticLevel;
}

function emit(ctx: RuleContext, d: Omit<Diagnostic, 'level'> & { level?: DiagnosticLevel }): Diagnostic[] {
  const resolved = levelOf(ctx, d.ruleId, d.level ?? 'warn');
  if (resolved === 'off') return [];
  return [{ ...d, level: resolved } as Diagnostic];
}

/* ────────────── 1. heavy-package ────────────── */
const heavyPackage: Rule = {
  id: 'heavy-package',
  defaultLevel: 'error',
  description: '单包归因体积超过阈值，并给出替换建议',
  check(ctx) {
    // 支持 ['error', { maxGzip: '200 KB' }] 形式自定义阈值
    const cfg = ctx.options.rules?.['heavy-package'];
    let min = DEFAULT_MIN_BYTES;
    if (Array.isArray(cfg)) {
      const opts = cfg[1] as { max?: string | number; maxGzip?: string | number } | undefined;
      const raw = opts?.maxGzip ?? opts?.max;
      if (raw !== undefined) min = parseSize(raw);
    }

    return ctx.pkgs.flatMap((p) => {
      if (p.kind !== 'npm' || p.pkg.startsWith('<')) return [];
      if (p.gzipBytes < min) return [];

      const replacement = REPLACEMENTS[p.pkg];
      return emit(ctx, {
        ruleId: 'heavy-package',
        pkg: p.pkg,
        bytes: p.gzipBytes,
        msg: `${p.pkg}${p.version ? `@${p.version}` : ''} 占了 ${fmtKB(p.gzipBytes)} gzip`,
        where: p.files[0],
        fix: replacement ? `→ ${replacement.to}` : '检查是否有更轻的替代实现',
        estimatedSaving: replacement
          ? Math.round(p.gzipBytes * replacement.saving)
          : undefined,
      });
    });
  },
};

/* ────────────── 2. full-locale-import ────────────── */
const LOCALE_PATTERNS: Array<{ re: RegExp; tips: string }> = [
  { re: /node_modules\/moment\/locale\//, tips: 'moment/locale/* 全量注入 → 只引 locale/zh-cn' },
  { re: /node_modules\/dayjs\/locale\/(?!zh-cn)/, tips: 'dayjs locale 全量 → 按需单点引入' },
  { re: /node_modules\/@ant-design\/icons\/lib\/dist/, tips: '图标全量 dist → 改成 @ant-design/icons 单图标按需引入' },
  { re: /node_modules\/@element-plus\/icons-vue\/dist/, tips: '图标 dist 全量 → 改成单组件 import' },
];

const fullLocaleImport: Rule = {
  id: 'full-locale-import',
  defaultLevel: 'error',
  description: '语言包 / 图标库全量引入',
  check(ctx) {
    const byPkg = new Map<string, { bytes: number; files: Set<string>; tip: string }>();

    for (const pkg of ctx.pkgs) {
      for (const file of pkg.files) {
        for (const pattern of LOCALE_PATTERNS) {
          if (!pattern.re.test(file)) continue;
          const entry = byPkg.get(pkg.pkg) ?? { bytes: 0, files: new Set<string>(), tip: pattern.tips };
          entry.bytes += pkg.gzipBytes;
          entry.files.add(file);
          byPkg.set(pkg.pkg, entry);
        }
      }
    }

    return [...byPkg.entries()].flatMap(([pkg, data]) =>
      emit(ctx, {
        ruleId: 'full-locale-import',
        pkg,
        bytes: data.bytes,
        msg: `${pkg} 全量引入国际化的资源`,
        where: [...data.files][0],
        fix: data.tip,
      })
    );
  },
};

/* ────────────── 3. duplicate-dep ────────────── */
/** 由 engine 侧注入重复检测结果，这里只做格式化 */
export interface DuplicateDiagnosticInput {
  pkg: string;
  versions: string[];
  estimatedBytes: number;
}

let duplicateInput: DuplicateDiagnosticInput[] = [];
export function setDuplicateInput(list: DuplicateDiagnosticInput[]): void {
  duplicateInput = list;
}

const duplicateDep: Rule = {
  id: 'duplicate-dep',
  defaultLevel: 'warn',
  description: '同名包存在多个版本',
  check(ctx) {
    return duplicateInput.flatMap((d) =>
      emit(ctx, {
        ruleId: 'duplicate-dep',
        pkg: d.pkg,
        bytes: d.estimatedBytes,
        msg: `${d.pkg} 并存 ${d.versions.length} 个版本：${d.versions.join(' / ')}`,
        fix: `pnpm.overrides 锁定到 ${d.versions.sort()[d.versions.length - 1]}`,
      })
    );
  },
};

/* ────────────── 4. circular-dep ────────────── */
export interface CircularDiagnosticInput {
  cycle: string[];
}

let circularInput: CircularDiagnosticInput[] = [];
export function setCircularInput(list: CircularDiagnosticInput[]): void {
  circularInput = list;
}

const circularDep: Rule = {
  id: 'circular-dep',
  defaultLevel: 'warn',
  description: '循环依赖（Tarjan SCC）',
  check(ctx) {
    return circularInput.slice(0, 5).flatMap((c) =>
      emit(ctx, {
        ruleId: 'circular-dep',
        msg: `检测到循环依赖（${c.cycle.length} 个模块）`,
        where: c.cycle.join(' → ') + ' → ' + c.cycle[0],
        fix: '抽离公共模块 / 用依赖注入打破环',
      })
    );
  },
};

/* ────────────── 5. unused-dep ────────────── */
export interface UnusedDiagnosticInput {
  pkg: string;
  reason: string;
}

let unusedInput: UnusedDiagnosticInput[] = [];
export function setUnusedInput(list: UnusedDiagnosticInput[]): void {
  unusedInput = list;
}

const unusedDep: Rule = {
  id: 'unused-dep',
  defaultLevel: 'info',
  description: '声明了但没被引用的依赖',
  check(ctx) {
    if (unusedInput.length === 0) return [];
    return emit(ctx, {
      ruleId: 'unused-dep',
      msg: `${unusedInput.length} 个依赖声明未被引用`,
      where: unusedInput.map((u) => u.pkg).join(' · '),
      fix: `pnpm rm ${unusedInput.map((u) => u.pkg).join(' ')}`,
    });
  },
};

/* ────────────── 6. cjs-bundled ────────────── */
const cjsBundled: Rule = {
  id: 'cjs-bundled',
  defaultLevel: 'warn',
  description: '体积较大的纯 CommonJS 依赖被打包，tree-shaking 失效',
  check(ctx) {
    const min = parseSize('20 KB');
    const root = ctx.options.root ?? process.cwd();

    return ctx.pkgs.flatMap((p) => {
      if (p.kind !== 'npm' || p.pkg.startsWith('<')) return [];
      if (p.gzipBytes < min) return [];

      // 判据不是路径里有没有 "cjs" 字样（lodash 的路径就没有任何标记），
      // 而是这个包**有没有提供 ESM 入口** —— 看它自己的 package.json。
      const meta = readPackageMeta(p.pkg, root);
      if (!meta.found || meta.hasEsm) return [];

      const suggestion = CJS_REPLACEMENTS[p.pkg];
      return emit(ctx, {
        ruleId: 'cjs-bundled',
        pkg: p.pkg,
        bytes: p.gzipBytes,
        msg: `${p.pkg} 只提供 CommonJS 入口（main=${meta.main ?? '?'}），tree-shaking 无法生效`,
        where: p.files[0],
        fix: suggestion ?? '寻找提供 ESM 的版本（如 xxx-es），或改用 esm.sh 预构建产物',
      });
    });
  },
};

/** 常见纯 CJS 包的 ESM 替代 */
const CJS_REPLACEMENTS: Record<string, string> = {
  lodash: '→ lodash-es（-82%）',
  underscore: '→ lodash-es',
  moment: '→ dayjs（-96%）',
  'crypto-js': '→ js-sha256 / Web Crypto',
  jquery: '→ 原生 DOM API',
  async: '→ 原生 Promise',
};

/* ────────────── 7. no-dynamic-import ────────────── */
const noDynamicImport: Rule = {
  id: 'no-dynamic-import',
  defaultLevel: 'warn',
  description: '首屏 chunk 里的大包没有做动态拆分',
  check(ctx) {
    const min = parseSize('200 KB');
    const entries = ctx.assets.filter((a) => a.kind === 'chunk' && a.isEntry);
    if (entries.length === 0) return [];

    const findings: Diagnostic[] = [];
    for (const pkg of ctx.pkgs) {
      if (pkg.kind !== 'npm' || pkg.gzipBytes < min) continue;
      const inEntry = pkg.chunks.some((c) => entries.some((e) => e.fileName === c));
      if (!inEntry) continue;
      findings.push(
        ...emit(ctx, {
          ruleId: 'no-dynamic-import',
          pkg: pkg.pkg,
          bytes: pkg.gzipBytes,
          msg: `${pkg.pkg}（${fmtKB(pkg.gzipBytes)}）落在首屏入口 chunk 里`,
          where: pkg.files[0],
          fix: '改成 () => import() 懒加载，配合 prefetch',
        })
      );
    }
    return findings;
  },
};

/* ────────────── 8. single-huge-chunk ────────────── */
const singleHugeChunk: Rule = {
  id: 'single-huge-chunk',
  defaultLevel: 'error',
  description: '单产物体积过大，建议 manualChunks 拆分',
  check(ctx) {
    const min = parseSize('250 KB');
    return ctx.assets.flatMap((a) => {
      if (a.kind !== 'chunk' || a.size.gzip < min) return [];
      return emit(ctx, {
        ruleId: 'single-huge-chunk',
        bytes: a.size.gzip,
        msg: `${a.fileName} 单产物 gzip ${fmtKB(a.size.gzip)}，超出建议值`,
        where: a.fileName,
        fix: '用 build.rollupOptions.output.manualChunks 按厂商/路由拆分',
      });
    });
  },
};

function fmtKB(bytes: number): string {
  if (bytes >= 1000 * 1000) return `${(bytes / 1000 / 1000).toFixed(2)} MB`;
  if (bytes >= 1000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** 内建规则顺序：先结构性问题，再体积问题 */
export const builtinRules: Rule[] = [
  duplicateDep,
  circularDep,
  unusedDep,
  fullLocaleImport,
  heavyPackage,
  cjsBundled,
  noDynamicImport,
  singleHugeChunk,
];

/** 执行全部规则并按级别排序（error > warn > info） */
export function runRules(ctx: RuleContext): Diagnostic[] {
  const all = builtinRules.flatMap((rule) => {
    let found: Diagnostic[];
    try {
      found = rule.check(ctx);
    } catch (err) {
      found = [
        {
          ruleId: rule.id,
          level: 'info' as DiagnosticLevel,
          msg: `规则执行失败：${(err as Error).message}`,
        },
      ];
    }
    // 用户没有显式配置这条规则时，用它注册的 defaultLevel
    // （否则 emit 的兜底值会让 heavy-package 这类 error 级规则退化成 warn）
    const overridden = ctx.options.rules?.[rule.id] !== undefined;
    return found.map((d) => ({
      ...d,
      level: overridden ? d.level : rule.defaultLevel,
    }));
  });

  const order: Record<DiagnosticLevel, number> = { error: 0, warn: 1, info: 2 };
  return all.sort((a, b) => order[a.level] - order[b.level] || (b.bytes ?? 0) - (a.bytes ?? 0));
}

/** pkg 列表里取 Top N 用于报告展示 */
export function topPackages(pkgs: PkgStat[], n = 12, minBytes = parseSize('4 KB')): PkgStat[] {
  return pkgs.filter((p) => p.gzipBytes >= minBytes).slice(0, n);
}
