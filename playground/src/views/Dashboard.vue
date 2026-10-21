<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { initChart, initRawCanvas } from '@chart';
import { loadUser, userState } from '../store/user';
import { formatDate, fromNow } from '@date';

const chartEl = ref<HTMLDivElement>();

onMounted(() => {
  const chart = initChart(chartEl.value!);
  chart.setOption({
    title: { text: '周活跃趋势' },
    tooltip: { trigger: 'axis' },
    legend: { data: ['访问', '下单'] },
    grid: { left: 40, right: 20, top: 50, bottom: 30 },
    xAxis: { type: 'category', data: ['一', '二', '三', '四', '五', '六', '日'] },
    yAxis: { type: 'value' },
    series: [
      { name: '访问', type: 'line', data: [820, 932, 901, 934, 1290, 1330, 1320] },
      { name: '下单', type: 'bar', data: [120, 200, 150, 80, 70, 110, 130] },
    ],
  });
  // 触发 zrender 直接依赖（制造多版本重复）
  void initRawCanvas(chartEl.value!);
  void loadUser();
});

const today = formatDate(new Date());
const updated = fromNow(Date.now() - 1000 * 60 * 35);
</script>

<template>
  <div class="card">
    <div class="card__head">
      <h2 class="card__title">业务概览</h2>
      <div style="display: flex; gap: 10px; align-items: center">
        <span class="card__sub">{{ today }} · {{ updated }}</span>
        <el-tag type="success" size="small">{{ userState.name || '加载中' }} · {{ userState.role }}</el-tag>
      </div>
    </div>
    <div class="card__body">
      <el-row :gutter="16">
        <el-col :span="16">
          <div ref="chartEl" style="height: 280px"></div>
        </el-col>
        <el-col :span="8">
          <div class="kpi__k" style="margin-bottom: 6px">本页引入的重依赖</div>
          <div class="rank" style="gap: 8px">
            <div class="rank__row" style="grid-template-columns: 92px 1fr 56px">
              <span class="rank__name">echarts</span>
              <div class="rank__bar"><i style="width: 100%; background: #ff4a17"></i></div>
              <span class="rank__size">全量</span>
            </div>
            <div class="rank__row" style="grid-template-columns: 92px 1fr 56px">
              <span class="rank__name">moment</span>
              <div class="rank__bar"><i style="width: 22%; background: #c4241a"></i></div>
              <span class="rank__size">+locale</span>
            </div>
            <div class="rank__row" style="grid-template-columns: 92px 1fr 56px">
              <span class="rank__name">zrender</span>
              <div class="rank__bar"><i style="width: 34%; background: #2e45b8"></i></div>
              <span class="rank__size">双版本</span>
            </div>
          </div>
          <p style="font-size: 0.78rem; color: var(--muted); margin: 14px 0 0">
            这张图本身就是体积大头 —— 用 <code class="mono">echarts/core</code> 按需注册可省一半。
          </p>
        </el-col>
      </el-row>
    </div>
  </div>
</template>
