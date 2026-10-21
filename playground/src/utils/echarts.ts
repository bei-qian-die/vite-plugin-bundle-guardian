/**
 * ❌ 坏味道：echarts 全量引入（所有图表类型 + 所有坐标系 + SVG/Canvas 双渲染器）
 * 一个只用折线图和饼图的页面，付了 1MB 的钱
 */

import * as echarts from 'echarts';
// ❌ 又一个坏味道：直接依赖了一个旧版 zrender，
//    而 echarts 内部还要另一个版本的 zrender → 产物里会打进两份
import { init as initZrender } from 'zrender';

export function initChart(el: HTMLElement) {
  return echarts.init(el);
}

/** 只有这里真的用一下，zrender 才会被打进产物 */
export function initRawCanvas(el: HTMLElement) {
  return initZrender(el);
}

export type { EChartsOption } from 'echarts';
