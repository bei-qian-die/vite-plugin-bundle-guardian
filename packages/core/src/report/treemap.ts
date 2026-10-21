/**
 * Squarified Treemap 布局（自研，零依赖）
 *
 * 为什么不用 ECharts / D3：HTML 报告必须是**单文件、离线可打开**的，
 * 引一个 300KB 的图表库去展示一份体积报告本身就是讽刺。
 *
 * Squarified 算法的目标：在给定矩形里铺放 N 个面积确定的方块，
 * 使每个方块的**长宽比尽量接近 1**（避免细长条，保证可读性与可点击性）。
 *
 * 核心是 worst() 启发式：逐行装填，每次尝试往当前行追加一个元素，
 * 如果「追加后该行最差长宽比」反而变好了就继续加，否则换行。
 */

export interface TreemapItem {
  name: string;
  value: number;
  color?: string;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Tile<T> extends Rect {
  item: T;
}

/** 计算当前行最差的长宽比 */
function worstRatio(values: number[], sum: number, thickness: number, shortSide: number): number {
  let max = 0;
  for (const v of values) {
    const len = shortSide * (v / sum);
    if (len <= 0) continue;
    const r = Math.max(thickness / len, len / thickness);
    if (r > max) max = r;
  }
  return max;
}

/**
 * 计算布局。输入 items 会被内部按 value 降序排列（不会修改原数组）。
 * @returns 与 items 一一对应的矩形列表
 */
export function squarify<T extends TreemapItem>(items: T[], rect: Rect): Tile<T>[] {
  const out: Tile<T>[] = [];
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, d) => s + d.value, 0);
  if (total <= 0 || rect.w <= 1 || rect.h <= 1) return out;

  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;
  let idx = 0;
  let remaining = total;
  let guard = 0;

  while (idx < sorted.length && guard++ < 2000) {
    const shortSide = Math.min(w, h);
    if (shortSide <= 1) break;

    // ── 选出这一行要放哪些元素 ──
    const rowValues: number[] = [];
    let rowSum = 0;
    let best = Infinity;
    let cursor = idx;

    while (cursor < sorted.length) {
      const candidateSum = rowSum + sorted[cursor].value;
      const candidate = rowValues.concat(sorted[cursor].value);
      const thickness = (candidateSum * (w * h)) / remaining / shortSide;
      const wr = worstRatio(candidate, candidateSum, thickness, shortSide);

      // 追加后反而变差 = 该换行了（第一行必须至少放一个，所以 rowValues 为空时不判断）
      if (rowValues.length > 0 && wr > best) break;

      best = wr;
      rowValues.push(sorted[cursor].value);
      rowSum = candidateSum;
      cursor++;
    }

    // ── 把这一行铺出来 ──
    const rowCount = cursor - idx;
    if (rowCount <= 0) break;
    const thickness = (rowSum * (w * h)) / remaining / shortSide;
    let pos = 0;

    for (let k = idx; k < cursor; k++) {
      const fraction = sorted[k].value / rowSum;
      const len = shortSide * fraction;
      out.push(
        w >= h
          ? { item: sorted[k], x, y: y + pos, w: thickness, h: len }
          : { item: sorted[k], x: x + pos, y, w: len, h: thickness }
      );
      pos += len;
    }

    if (w >= h) {
      x += thickness;
      w -= thickness;
    } else {
      y += thickness;
      h -= thickness;
    }

    idx = cursor;
    remaining -= rowSum;
    if (thickness <= 0.01) break;
  }

  return out;
}

/** 把布局结果直接渲染成 SVG 片段（用于 HTML 报告） */
export function renderTreemapSvg(
  items: TreemapItem[],
  options: { width?: number; height?: number; unit?: string } = {}
): string {
  const width = options.width ?? 1100;
  const height = options.height ?? 340;
  const unit = options.unit ?? 'KB';

  const palette = ['#FF4A17', '#C4241A', '#2E45B8', '#131612', '#B87300', '#0E6B4F'];
  const colored = items.map((it, i) => ({ ...it, color: it.color ?? palette[i % palette.length] }));
  const tiles = squarify(colored, { x: 0, y: 0, w: width, h: height });

  const body = tiles
    .map((t) => {
      const label = escapeXml(t.item.name);
      const value = `${t.item.value.toFixed(1)} ${unit}`;
      const showText = t.w > 52 && t.h > 28;
      const fontSize = Math.max(9, Math.min(14, Math.floor(t.w / 9)));
      return [
        `<rect x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" width="${(t.w - 1.5).toFixed(1)}" height="${(t.h - 1.5).toFixed(1)}" fill="${t.item.color}" fill-opacity="0.92"><title>${label} · ${value}</title></rect>`,
        showText
          ? `<text x="${(t.x + 7).toFixed(1)}" y="${(t.y + fontSize + 5).toFixed(1)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${fontSize}" font-weight="600" fill="#ffffff">${label}</text>` +
            `<text x="${(t.x + 7).toFixed(1)}" y="${(t.y + fontSize * 2 + 7).toFixed(1)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="${Math.max(8, fontSize - 2)}" fill="rgba(255,255,255,.8)">${value}</text>`
          : '',
      ].join('');
    })
    .join('');

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img">${body}</svg>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
