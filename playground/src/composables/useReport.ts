import { computed, onMounted, ref } from 'vue';

/**
 * 页面上的每个数字都来自真实的构建报告（/__guardian/report.json），
 * 不是写死的演示数据 —— 否则这张页面就只是又一个好看的假 figma。
 *
 * 另外还会取 /__guardian/report-before.json 与 report-after.json，
 * 用来算「治理收益」这类需要两份产物对比才能得出的指标。
 */
export interface JsonBudget {
  name: string;
  level: 'ok' | 'warn' | 'error';
  actual: number;
  limit: number;
  ratio: number;
  target?: string;
}

export interface JsonDiagnostic {
  ruleId: string;
  level: 'error' | 'warn' | 'info';
  pkg?: string;
  bytes?: number;
  msg: string;
  fix?: string;
  where?: string;
}

export interface JsonPackage {
  pkg: string;
  version?: string;
  gzipBytes: number;
  bytes: number;
}

export interface JsonAsset {
  fileName: string;
  kind?: string;
  ext: string;
  gzip: number;
  raw: number;
  brotli: number;
  isEntry?: boolean;
}

export interface JsonBaseline {
  increaseRatio: number;
  increaseLimit: number;
  ok: boolean;
  deltas: Array<{ fileName: string; before: number; after: number; diff: number; ratio: number }>;
}

export interface JsonReport {
  at: number;
  durationMs: number;
  degraded: boolean;
  summary: { assetCount: number; totalRaw: number; totalGzip: number; totalBrotli: number };
  assets: JsonAsset[];
  budgets: JsonBudget[];
  diagnostics: JsonDiagnostic[];
  packages: JsonPackage[];
  baseline?: JsonBaseline;
}

export function human(n: number): { value: string; unit: string } {
  if (n >= 1024 * 1024) return { value: (n / 1024 / 1024).toFixed(2), unit: 'MB' };
  if (n >= 1024) return { value: (n / 1024).toFixed(1), unit: 'KB' };
  return { value: String(n), unit: 'B' };
}

/** 只取 JS 的 gzip 总量，用于前后对比 */
function jsGzip(r: JsonReport | null): number {
  if (!r) return 0;
  return r.assets.filter((a) => a.ext === 'js').reduce((s, a) => s + a.gzip, 0);
}

async function fetchReport(path: string): Promise<JsonReport | null> {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = (await res.json()) as JsonReport;
    return json?.summary ? json : null;
  } catch {
    return null;
  }
}

export function useReport() {
  const report = ref<JsonReport | null>(null);
  const before = ref<JsonReport | null>(null);
  const after = ref<JsonReport | null>(null);
  const error = ref<string | null>(null);
  const loading = ref(true);

  onMounted(async () => {
    const [cur, b, a] = await Promise.all([
      fetchReport('/__guardian/report.json'),
      fetchReport('/__guardian/report-before.json'),
      fetchReport('/__guardian/report-after.json'),
    ]);
    if (!cur) error.value = '还没有构建报告';
    report.value = cur;
    before.value = b;
    after.value = a;
    loading.value = false;
  });

  const assets = computed(() => report.value?.assets ?? []);
  const js = computed(() => assets.value.filter((a) => a.ext === 'js'));
  const css = computed(() => assets.value.filter((a) => a.ext === 'css'));

  const stats = computed(() => {
    const r = report.value;
    if (!r) return null;
    const jsGzipBytes = js.value.reduce((s, a) => s + a.gzip, 0);
    const cssGzipBytes = css.value.reduce((s, a) => s + a.gzip, 0);
    return {
      raw: r.summary.totalRaw,
      gzip: r.summary.totalGzip,
      brotli: r.summary.totalBrotli,
      jsGzip: jsGzipBytes,
      cssGzip: cssGzipBytes,
      assetCount: r.summary.assetCount,
      pkgCount: r.packages.length,
      durationMs: r.durationMs,
      degraded: r.degraded,
      gzipRatio: 1 - r.summary.totalGzip / (r.summary.totalRaw || 1),
      brotliRatio: 1 - r.summary.totalBrotli / (r.summary.totalRaw || 1),
    };
  });

  /** 治理降幅：只有同时拿到 before / after 才显示，否则为 null（页面显示 —） */
  const governance = computed(() => {
    const b = jsGzip(before.value);
    const a = jsGzip(after.value);
    if (!b || !a) return null;
    return { before: b, after: a, drop: (1 - a / b) * 100 };
  });

  /**
   * 归因覆盖率：包级归因到的 gzip 之和 / JS 产物 gzip 之和。
   * CSS 与 html 不参与字节级归因（它们没有 sourcemap 的模块粒度），
   * 所以分母只取 JS —— 拿总产物做分母会得出一个假的分母口径。
   */
  const conservation = computed(() => {
    const r = report.value;
    if (!r) return null;
    const sum = r.packages.reduce((s, p) => s + p.gzipBytes, 0);
    const total = js.value.reduce((s, a) => s + a.gzip, 0);
    if (!total) return null;
    return sum / total;
  });

  const errorCount = computed(
    () =>
      (report.value?.budgets.filter((b) => b.level === 'error').length ?? 0) +
      (report.value?.diagnostics.filter((d) => d.level === 'error').length ?? 0)
  );
  const warnCount = computed(
    () =>
      (report.value?.budgets.filter((b) => b.level === 'warn').length ?? 0) +
      (report.value?.diagnostics.filter((d) => d.level === 'warn').length ?? 0)
  );

  /** 终端卡里的产物表：按 gzip 倒序取前 4 个，带 baseline 增量与状态 */
  const termAssets = computed(() => {
    const r = report.value;
    if (!r) return [];
    const deltas = new Map((r.baseline?.deltas ?? []).map((d) => [d.fileName, d]));
    const budgetOf = (file: string) => r.budgets.find((b) => b.target === file)?.level ?? 'ok';

    return [...r.assets]
      .sort((x, y) => y.gzip - x.gzip)
      .slice(0, 4)
      .map((a) => {
        const d = deltas.get(a.fileName);
        const delta =
          !d || d.before === 0 ? 'new' : `${d.diff >= 0 ? '+' : ''}${(d.ratio * 100).toFixed(1)}%`;
        const level = budgetOf(a.fileName);
        const short = a.fileName.replace(/^assets\//, '');
        return {
          name: short.length > 24 ? `${short.slice(0, 21)}…` : short,
          gzip: a.gzip,
          delta,
          level,
          mark: level === 'error' ? '✖ ERR' : level === 'warn' ? '⚠ WARN' : '✔ OK',
        };
      });
  });

  /** 终端卡里的预算行：同名预算只留最严重的一条 */
  const termBudgets = computed(() => {
    const r = report.value;
    if (!r) return [];
    const worst = new Map<string, JsonBudget>();
    for (const b of r.budgets) {
      const prev = worst.get(b.name);
      if (!prev || b.ratio > prev.ratio) worst.set(b.name, b);
    }
    const order = { error: 0, warn: 1, ok: 2 } as const;
    return [...worst.values()]
      .sort((a, b) => order[a.level] - order[b.level] || b.ratio - a.ratio)
      .slice(0, 3)
      .map((b) => {
        // 条形：以 100% 预算为满格，超支封顶但整行标红
        const cells = 16;
        const filled = Math.max(1, Math.min(cells, Math.round(Math.min(b.ratio, 1) * cells)));
        return {
          name: b.name,
          ratio: b.ratio,
          level: b.level,
          bar: '█'.repeat(filled) + '░'.repeat(cells - filled),
          mark: b.level === 'error' ? '✖' : b.level === 'warn' ? '⚠' : '✔',
        };
      });
  });

  const topPackages = computed(() => {
    const list = report.value?.packages.slice(0, 8) ?? [];
    const max = Math.max(...list.map((p) => p.gzipBytes), 1);
    return list.map((p, i) => ({
      ...p,
      width: (p.gzipBytes / max) * 100,
      size: human(p.gzipBytes),
      /** 只让第一名用朱红：一个页面只留一个强调，符合「60/30/10」配色纪律 */
      tone: i === 0 ? 'hot' : 'ink',
    }));
  });

  const topDiagnostics = computed(() => report.value?.diagnostics.slice(0, 6) ?? []);

  const largest = computed(() => {
    const list = report.value?.assets ?? [];
    if (!list.length) return null;
    return list.reduce((m, a) => (a.gzip > m.gzip ? a : m));
  });

  return {
    report,
    before,
    after,
    loading,
    error,
    stats,
    governance,
    conservation,
    errorCount,
    warnCount,
    termAssets,
    termBudgets,
    topPackages,
    topDiagnostics,
    largest,
    human,
  };
}
