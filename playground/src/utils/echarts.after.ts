/**
 * ✅ 治理后：echarts/core 按需注册
 * 只注册页面真正用到的图表类型、组件和渲染器
 */

import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  LineChart,
  BarChart,
  PieChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  CanvasRenderer,
]);

export function initChart(el: HTMLElement) {
  return echarts.init(el);
}

// 治理时忘了删的直接依赖，会和 echarts 内部的 zrender 形成多版本重复
export function initRawCanvas(el: HTMLElement) {
  return null as unknown as ReturnType<typeof echarts.init>;
}

export type { EChartsOption } from 'echarts';
