/**
 * 体积趋势历史
 *
 * baseline 只记住「上一次」，看不出趋势。这里额外维护一份时间序列，
 * 用来回答「这个月体积是怎么一点点涨上来的」—— 也是给团队看的那一屏。
 *
 * 存储在 .guardian/history.json，保留最近 N 条（默认 60）。
 */

import fs from 'node:fs';
import path from 'node:path';

export interface HistoryPoint {
  at: number;
  commit?: string;
  branch?: string;
  totalGzip: number;
  totalBrotli?: number;
  assetCount: number;
  /** 超标项数量，用来在趋势图上标红 */
  errors?: number;
}

export interface HistoryFile {
  version: number;
  points: HistoryPoint[];
}

const VERSION = 1;
const DEFAULT_LIMIT = 60;

export function readHistory(file: string): HistoryPoint[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as HistoryFile;
    if (!raw?.points || !Array.isArray(raw.points)) return [];
    return raw.points.sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

/** 追加一条记录并落盘，超出 limit 的从头部丢弃 */
export function appendHistory(
  file: string,
  point: HistoryPoint,
  limit = DEFAULT_LIMIT
): HistoryPoint[] {
  const points = readHistory(file);
  points.push(point);
  const trimmed = points.slice(Math.max(0, points.length - limit));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: VERSION, points: trimmed }, null, 2), 'utf8');
  } catch {
    /* 写不进去也不影响本次分析 */
  }
  return trimmed;
}

/** 终端里的 ASCII 折线：不引图表库，报告依然单文件可用 */
export function renderHistoryAscii(points: HistoryPoint[], width = 56, height = 10): string {
  if (points.length === 0) return '  （还没有历史记录，先跑一次 `bundle-guardian check --record`）';

  const values = points.map((p) => p.totalGzip);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const grid: string[][] = Array.from({ length: height }, () => Array(width).fill(' '));

  points.forEach((p, i) => {
    const x = Math.min(width - 1, Math.round((i / Math.max(1, points.length - 1)) * (width - 1)));
    const y = height - 1 - Math.round(((p.totalGzip - min) / span) * (height - 1));
    grid[y][x] = p.errors && p.errors > 0 ? '!' : '●';
  });

  // 简单的连线：把两点之间的行补上 '·'
  for (let i = 1; i < points.length; i++) {
    const x0 = Math.round(((i - 1) / Math.max(1, points.length - 1)) * (width - 1));
    const x1 = Math.round((i / Math.max(1, points.length - 1)) * (width - 1));
    const y0 = height - 1 - Math.round(((values[i - 1] - min) / span) * (height - 1));
    const y1 = height - 1 - Math.round(((values[i] - min) / span) * (height - 1));
    for (let x = x0 + 1; x < x1; x++) {
      const y = Math.round(y0 + ((y1 - y0) * (x - x0)) / Math.max(1, x1 - x0));
      if (grid[y] && grid[y][x] === ' ') grid[y][x] = '·';
    }
  }

  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  const rows = grid.map((row, i) => {
    const label = i === 0 ? kb(max) : i === height - 1 ? kb(min) : '';
    return `  ${label.padStart(9)} │${row.join('')}`;
  });

  const first = new Date(points[0].at).toLocaleDateString('zh-CN');
  const last = new Date(points[points.length - 1].at).toLocaleDateString('zh-CN');
  rows.push(`  ${''.padStart(9)} └${'─'.repeat(width)}`);
  rows.push(`  ${''.padStart(11)}${first}${' '.repeat(Math.max(1, width - first.length - last.length))}${last}`);
  rows.push(`  ${''.padStart(11)}● 正常  ! 当次有超标  · 趋势`);
  return rows.join('\n');
}

/** Markdown 版本（贴 PR / 周报用） */
export function renderHistoryMarkdown(points: HistoryPoint[]): string {
  if (points.length === 0) return '_暂无历史记录_';
  const rows = points
    .slice(-12)
    .map((p) => `| ${new Date(p.at).toLocaleString('zh-CN')} | ${p.commit ?? '—'} | ${(p.totalGzip / 1024).toFixed(1)} KB | ${p.assetCount} | ${p.errors ?? 0} |`)
    .join('\n');
  return ['| 时间 | Commit | gzip | 产物数 | 超标 |', '| --- | --- | ---: | ---: | ---: |', rows].join('\n');
}

/** 趋势摘要：首末对比 + 峰值 */
export function summarizeTrend(points: HistoryPoint[]): {
  first: number;
  last: number;
  delta: number;
  ratio: number;
  peak: number;
} | null {
  if (points.length < 2) return null;
  const first = points[0].totalGzip;
  const last = points[points.length - 1].totalGzip;
  return {
    first,
    last,
    delta: last - first,
    ratio: first === 0 ? 0 : (last - first) / first,
    peak: Math.max(...points.map((p) => p.totalGzip)),
  };
}
