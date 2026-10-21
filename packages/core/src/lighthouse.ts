/**
 * Lighthouse 联动
 *
 * 体积本身不是业务指标，加载耗时才是。这里做两件事：
 *   ① 读取已有的 Lighthouse 报告，把当前性能分与 LCP 拉进 bundle 报告
 *   ② 用「传输耗时」把体积换算成人能感知的毫秒：
 *      体积差 (KB) ÷ 带宽 (kbps) × 8 × 1000 ≈ 传输耗时差 (ms)
 *
 * 这是粗估（没算解析/执行/往返），但足够回答「省了 150 KB 到底值多少」。
 */

import fs from 'node:fs';

export interface LighthouseReport {
  score?: number;
  lcpMs?: number;
  fcpMs?: number;
  tbtMs?: number;
  fetchedAt?: number;
}

/** 常见网络档位（下行带宽 kbps） */
export const NETWORK_PROFILES: Record<string, number> = {
  'slow-3g': 400,
  'fast-3g': 1600,
  '4g': 9000,
  wifi: 30000,
};

export function readLighthouseReport(file: string): LighthouseReport | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const audits = (raw.audits ?? {}) as Record<string, { numericValue?: number }>;
    const categories = (raw.categories ?? {}) as Record<string, { score?: number }>;
    return {
      score: typeof categories.performance?.score === 'number'
        ? Math.round(categories.performance.score * 100)
        : undefined,
      lcpMs: audits['largest-contentful-paint']?.numericValue,
      fcpMs: audits['first-contentful-paint']?.numericValue,
      tbtMs: audits['total-blocking-time']?.numericValue,
      fetchedAt: typeof raw.fetchTime === 'string' ? Date.parse(raw.fetchTime) : undefined,
    };
  } catch {
    return null;
  }
}

/** 给定字节数在某带宽下的传输耗时（毫秒） */
export function estimateTransferMs(bytes: number, kbps = NETWORK_PROFILES['4g']): number {
  if (bytes <= 0 || kbps <= 0) return 0;
  return (bytes * 8) / (kbps * 1000) * 1000;
}

export interface ImpactEstimate {
  beforeMs: number;
  afterMs: number;
  savedMs: number;
  kbps: number;
}

export function estimateImpact(
  beforeBytes: number,
  afterBytes: number,
  kbps = NETWORK_PROFILES['fast-3g']
): ImpactEstimate {
  const beforeMs = estimateTransferMs(beforeBytes, kbps);
  const afterMs = estimateTransferMs(afterBytes, kbps);
  return { beforeMs, afterMs, savedMs: beforeMs - afterMs, kbps };
}

export function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

/** 生成一段可插进 Markdown 报告的说明 */
export function renderLighthouseSection(
  report: LighthouseReport | null,
  impact: ImpactEstimate
): string[] {
  const lines: string[] = [];
  if (report?.score !== undefined) {
    lines.push(`- Lighthouse Performance：**${report.score}**${report.lcpMs ? ` · LCP ${formatMs(report.lcpMs)}` : ''}`);
  }
  lines.push(
    `- 在 ${Math.round(impact.kbps / 1000)} Mbps 下，传输耗时 ${formatMs(impact.beforeMs)} → ${formatMs(impact.afterMs)}（**省 ${formatMs(impact.savedMs)}**）`
  );
  lines.push('  _耗时为传输估算，未计入解析与执行开销_');
  return lines;
}
