/**
 * 公共类型定义
 *
 * 设计约束：本文件（乃至整个 core 包）**零运行时依赖**，
 * 不使用任何 `vite` / `rollup` 的运行时导入，只做结构化类型兼容。
 * 好处：CLI 可以离线分析任意构建产物，将来接 Webpack / Rspack 只需再写一层 adapter。
 */

/* ────────────────────────── SourceMap ────────────────────────── */

/** RawSourceMap 的最小可用子集（与 rollup / magic-string 的输出结构一致） */
export interface SourceMapLike {
  version: number;
  sources: string[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings: string;
  file?: string;
  sourceRoot?: string;
}

/**
 * 解码后的单个映射段。
 * 四元组含义：[generatedColumn(绝对), sourceIndex, sourceLine, sourceColumn]
 */
export type Seg4 = [number, number, number, number];

/** 一整行 generated 代码对应的所有 segment */
export type LineSegments = Seg4[];

/* ────────────────────────── 构建产物 ────────────────────────── */

/** 用于 sourcemap 缺失时的降级估算 */
export interface BundleModule {
  id: string;
  code: string | null;
}

export interface ChunkLike {
  type?: 'chunk';
  fileName: string;
  code: string;
  map?: SourceMapLike | null;
  name?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  /** rollup/vite 侧用于增量缓存的产物哈希 */
  hash?: string;
  /**
   * 降级模式下（无 sourcemap）用于按模块原始长度估算。
   * 同时兼容两种形态：core 自己构造的 BundleModule[]，
   * 以及 Rollup 的 `OutputChunk.modules: Record<string, RenderedModule>`。
   */
  modules?: BundleModule[] | Record<string, { code?: string | null } | undefined>;
}

export interface AssetLike {
  type: 'asset';
  fileName: string;
  source: string | Uint8Array;
}

export type OutputItem = ChunkLike | AssetLike;

export type Bundle = Record<string, OutputItem>;

/* ────────────────────────── 体积度量 ────────────────────────── */

export interface SizeSet {
  /** UTF-8 字节数 */
  raw: number;
  /** zlib.gzipSync(level 9) 后的字节数 */
  gzip: number;
  /** zlib.brotliCompressSync 后的字节数 */
  brotli: number;
}

export type AssetExt = 'js' | 'css' | 'map' | 'other';

export interface AssetRecord {
  fileName: string;
  kind: 'chunk' | 'asset';
  ext: AssetExt;
  isEntry: boolean;
  size: SizeSet;
  imports?: string[];
  dynamicImports?: string[];
}

/* ────────────────────────── 归因结果 ────────────────────────── */

/** 源文件解析后归属的“逻辑包” */
export type SourceKind = 'npm' | 'app' | 'virtual' | 'runtime';

export interface ResolvedSource {
  /**
   * 归一化后的包名：'lodash' / '@babel/runtime'
   * 业务源码统一为 '@app'，Rollup/Vite 注入的垫片为 '<rollup-helpers>'
   */
  pkg: string;
  version?: string;
  /** 包内子路径 */
  subPath?: string;
  kind: SourceKind;
  /** 原始 source 路径（保留 Vite query 前缀信息前的形态） */
  raw: string;
}

export interface SourceAttribution {
  source: string;
  bytes: number;
  resolved: ResolvedSource;
}

export interface PkgStat {
  pkg: string;
  version?: string;
  kind: SourceKind;
  /** 归因得到的源字节（压缩前，按 sourcemap 映射） */
  bytes: number;
  /** 按字节占比折算得到的 gzip / brotli 估算 */
  gzipBytes: number;
  brotliBytes: number;
  /** 命中的源文件（最多保留 12 条，避免报告爆炸） */
  files: string[];
  fileCount: number;
  /** 命中的产物 */
  chunks: string[];
}

export interface AttributionResult {
  totalBytes: number;
  /** 未被任何 segment 映射到的字节（banner / runtime 注入 / `${@...}` 模板） */
  runtimeBytes: number;
  /** 缺少 sourcemap，退化为“按模块原始大小估算”的降级模式 */
  degraded: boolean;
  bySource: SourceAttribution[];
}

/* ────────────────────────── 依赖图 ────────────────────────── */

export interface ModuleNode {
  id: string;
  importedIds: string[];
}

export interface CircularDep {
  /** 环上的模块 id（首尾相接） */
  cycle: string[];
  /** 环外是谁引入了它 */
  via?: string;
}

export interface DuplicateGroup {
  pkg: string;
  versions: string[];
  /** 每个版本命中的源文件样例 */
  samples: Record<string, string>;
  estimatedBytes: number;
}

export interface UnusedDependency {
  pkg: string;
  reason: string;
}

/* ────────────────────────── 预算 ────────────────────────── */

export type BudgetField = 'gzip' | 'brotli' | 'raw';

export interface Budget {
  name: string;
  /** 文件名包含匹配 */
  contains?: string | RegExp;
  /** 命中这些 npm 包（用 pkgs 时统计的是这些包的归因体积之和） */
  pkgs?: string[];
  /** 扩展名过滤 */
  ext?: AssetExt;
  /** 对每个产物分别应用同一限额 */
  each?: boolean;
  /** 命中项合计上限，如 '300 KB' */
  maxTotal?: string | number;
  /** 单产物上限（each: true 时使用），如 '200 KB' */
  maxGzip?: string | number;
  /** 用量达到该比例时降级为 warning，默认 0.9 */
  warnAt?: number;
}

export type BudgetLevel = 'ok' | 'warn' | 'error';

export interface BudgetResult {
  name: string;
  level: BudgetLevel;
  actual: number;
  limit: number;
  field: BudgetField;
  ratio: number;
  offenders: string[];
  /** each: true 时为被判定的具体产物名 */
  target?: string;
}

export interface BaselineDelta {
  fileName: string;
  field: BudgetField;
  before: number;
  after: number;
  /** true 表示新增产物 */
  isNew: boolean;
  diff: number;
  ratio: number;
}

/* ────────────────────────── 诊断 ────────────────────────── */

export type DiagnosticLevel = 'error' | 'warn' | 'info';

export interface Diagnostic {
  ruleId: string;
  level: DiagnosticLevel;
  pkg?: string;
  bytes?: number;
  msg: string;
  /** 发生位置 / 引入链路 */
  where?: string;
  /** 可执行的修复建议 */
  fix?: string;
  /** 预计可节省的 gzip 字节 */
  estimatedSaving?: number;
}

/** 体积替换建议表：包名 → { 替代包, 典型降幅 } */
export interface ReplacementMap {
  [pkg: string]: { to: string; saving: number };
}

export interface GuardianOptions {
  budgets?: Budget[];
  baseline?: {
    file?: string;
    /** 允许的体积增幅，如 '5%'；超出即 error */
    increaseLimit?: string;
    autoUpdate?: boolean;
  };
  rules?: Record<string, DiagnosticLevel | [DiagnosticLevel, unknown]>;
  report?: {
    html?: string | false;
    json?: string | false;
    markdown?: string | false;
    terminal?: boolean;
    open?: boolean;
  };
  /** 包可见的最小归因体积（字节），低于该值的包不进入 Top 列表 */
  minPackageBytes?: number;
  failOnError?: boolean;
  root?: string;
  /** 并行压缩 worker 数，默认 min(cpus-1, assets) */
  workers?: number;
  cache?: boolean;
  cacheDir?: string;
  /** dev / preview 服务器上的实时面板路径，默认 /__guardian */
  devServer?: { path?: string };
  /**
   * 路径别名（Vite 的 resolve.alias）。
   * 离线扫描源码建图时用来还原 `@/xxx` 这类引用 —— 也可写在 .guardianrc.json 里。
   */
  alias?: Record<string, string>;
}

export interface AnalysisResult {
  /** 本次分析时间戳 */
  at: number;
  root: string;
  assets: AssetRecord[];
  attribution: AttributionResult;
  pkgs: PkgStat[];
  diagnostics: Diagnostic[];
  budgets: BudgetResult[];
  baseline?: {
    file: string;
    deltas: BaselineDelta[];
    increaseRatio: number;
    increaseLimit: number;
    ok: boolean;
  };
  durationMs: number;
  degraded: boolean;
  /**
   * 模块依赖图（写入 report.json 后，CLI 的 `why` 命令才能离线回溯引入链）。
   * 超大图会被裁剪，默认上限见 analyze 中的 GRAPH_LIMIT。
   */
  graph?: ModuleNode[];
}

export interface RuleContext {
  assets: AssetRecord[];
  attribution: AttributionResult;
  pkgs: PkgStat[];
  options: GuardianOptions;
  /** 各包被哪些入口引入的最短链路（仅对被规则命中的包惰性计算） */
  resolveChain?: (pkg: string) => string[] | null;
}

export interface Rule {
  id: string;
  defaultLevel: DiagnosticLevel;
  description: string;
  check(ctx: RuleContext): Diagnostic[];
}
