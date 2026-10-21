<script setup lang="ts">
/**
 * HiddenSink —— 靶场的「坏味道收纳盒」
 *
 * 这个组件在页面上不渲染任何可见 UI，唯一职责：
 * 在 before 模式下，把四条「体积坏味道」真实地拉进产物，让治理收益可复现。
 *
 * 为什么需要它：
 *   before/after 差异由 vite.config.ts 的 alias 切换驱动（@date/@chart/@helper/@ui）。
 *   这些 alias 模块必须「被 import 且被真实调用」才会进包。
 *   概念图版式（App.vue）不引用任何日期/图表/工具函数，所以删掉原来的 Dashboard/DataTable
 *   两个演示组件后，整条坏味道引入链断了，dist-before 从 765 KB 掉到 ~330 KB，
 *   导致 README「765.7 → 506.0 KB（−33.9%）」无法复现。
 *
 * 关键：用「副作用导入」而非「void 丢弃调用」。
 *   date.ts / echarts.ts / helper.ts 的顶层都含副作用（moment.locale(...)、import * as echarts 等），
 *   裸 `import '@date'` 会让 Rollup 保留整个模块及其依赖链，
 *   而 `void fn()` 这种「调用后丢弃」会被 tree-shaking 判定为可消除。
 *
 * 下方再补一次真实调用作为「双保险」：把结果写进一个模块级 Map，让 Rollup 无法证明它没用。
 */
import '@date';
import '@chart';
import '@helper';

import { formatDate, fromNow } from '@date';
import { initChart } from '@chart';
import { deepClone } from '@helper';

/** 模块级副作用锚点：结果写入、永不读取，但 Rollup 无法静态消除 */
const __sink = new Map<string, unknown>();

function anchor(): void {
  const d = new Date();
  __sink.set('date', formatDate(d));
  __sink.set('fromNow', fromNow(d));
  __sink.set('clone', deepClone({ x: 1 }));

  // 饼图不需要坐标轴，避免在离屏容器里因缺少 xAxis 抛错
  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:-9999px;top:0;width:200px;height:200px;';
  document.body.appendChild(holder);

  const chart = initChart(holder);
  chart.setOption({
    series: [{ type: 'pie', radius: '60%', data: [{ name: 'a', value: 1 }, { name: 'b', value: 2 }] }],
  });
  __sink.set('chart', chart);
  chart.dispose();
  holder.remove();
}

// 顶层立即执行，保证副作用在模块加载时就发生。
// 用 try/catch 兜住：靶场页面绝不能因为「故意引入的坏味道」而白屏。
try {
  anchor();
} catch {
  /* 运行时失败不影响页面渲染，体积测量的意义不受影响 */
}
</script>

<template>
  <!-- 无可见 UI：概念图版式保持纯净 -->
</template>
