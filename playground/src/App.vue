<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useReport } from './composables/useReport';
// 靶场坏味道收纳盒：不渲染 UI，只在 before 模式把 moment/echarts/lodash 全量拉进产物
import HiddenSink from './views/HiddenSink.vue';

const {
  report,
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
} = useReport();

/** build 短 id：取报告时间戳，纯装饰但每次都变，像真 commit */
const buildId = computed(() =>
  report.value ? (report.value.at % 0xfffffff).toString(16).padStart(7, '0') : '-------'
);

const padEnd = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
const padStart = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

type Tone = 'dim' | 'accent' | 'ok' | 'warn' | 'err' | 'info' | 'white' | '';
interface Seg {
  text: string;
  tone?: Tone;
}

/**
 * 终端卡内容：按概念图的四段式排版
 *   ① 命令行  ② 产物表（ASSET / GZIP / Δ BASE / STATUS）
 *   ③ 预算条（BUDGET / ACTUAL-LIMIT）  ④ 结论 + 下一步提示
 * 所有数值来自真实 report.json，列宽用 padEnd 对齐（等宽字体下等同于表格）。
 */
const termLines = computed<Seg[][]>(() => {
  const r = report.value;
  if (!r || !stats.value) return [];

  const lines: Seg[][] = [];
  lines.push([{ text: '$ ', tone: 'dim' }, { text: 'pnpm bundle-guardian check --ci', tone: 'white' }]);
  lines.push([]);
  lines.push([
    { text: ' ██ ', tone: 'accent' },
    { text: 'bundle-guardian ' },
    { text: 'v1.0.0', tone: 'info' },
    { text: `      build #${buildId.value}`, tone: 'dim' },
  ]);
  lines.push([]);
  lines.push([{ text: ` ASSET${'GZIP'.padStart(26)}${'  '}${'Δ BASE'.padStart(9)}${'   '}STATUS` }]);
  lines.push([{ text: ' ' + '─'.repeat(56), tone: 'dim' }]);

  for (const a of termAssets.value) {
    const tone: Tone = a.level === 'error' ? 'err' : a.level === 'warn' ? 'warn' : 'ok';
    lines.push([
      { text: ' ' + padEnd(a.name, 22) },
      { text: padStart(fmtBytes(a.gzip), 8) + '  ' },
      { text: padStart(a.delta, 9) + '   ', tone: 'dim' },
      { text: a.mark, tone },
    ]);
  }

  lines.push([{ text: ' ' + '─'.repeat(56), tone: 'dim' }]);
  lines.push([{ text: ` BUDGET${'ACTUAL / LIMIT'.padStart(28)}` }]);
  for (const b of termBudgets.value) {
    const tone: Tone = b.level === 'error' ? 'err' : b.level === 'warn' ? 'warn' : 'ok';
    lines.push([
      { text: ' ' + padEnd(b.name, 18) },
      { text: b.bar, tone },
      { text: padStart(`${Math.round(b.ratio * 100)}%`, 6) },
      { text: '  ' + b.mark, tone },
    ]);
  }

  lines.push([{ text: ' ' + '─'.repeat(56), tone: 'dim' }]);
  lines.push([
    { text: ` ✖ ${errorCount.value} error${errorCount.value === 1 ? '' : 's'}`, tone: 'err' },
    { text: ' · ', tone: 'dim' },
    { text: `⚠ ${warnCount.value} warning${warnCount.value === 1 ? '' : 's'}`, tone: 'warn' },
    { text: ' · analyzed in ', tone: 'dim' },
    { text: `${Math.round(r.durationMs)}ms` },
  ]);
  lines.push([]);
  if (largest.value) {
    lines.push([
      { text: ' → ', tone: 'dim' },
      { text: `bundle-guardian why ${largest.value.fileName.replace(/^assets\//, '')}`, tone: 'white' },
    ]);
  }
  return lines;
});

/** 压缩瀑布：真实 raw / gzip / brotli，宽度按占比 */
const funnel = computed(() => {
  const s = stats.value;
  if (!s) return [];
  const max = s.raw || 1;
  return [
    { label: 'RAW', bytes: s.raw, pct: 100, note: '未压缩', delta: '100%' },
    {
      label: 'GZIP',
      bytes: s.gzip,
      pct: (s.gzip / max) * 100,
      note: 'level 9',
      delta: `-${((1 - s.gzip / max) * 100).toFixed(1)}%`,
    },
    {
      label: 'BROTLI',
      bytes: s.brotli,
      pct: (s.brotli / max) * 100,
      note: 'level 11',
      delta: `-${((1 - s.brotli / max) * 100).toFixed(1)}%`,
    },
  ];
});

function fmtBytes(n: number) {
  const h = human(n);
  return `${h.value} ${h.unit}`;
}

/** 一次编排好的入场序列：滚动进入时逐块上浮 */
onMounted(() => {
  const els = document.querySelectorAll<HTMLElement>('.reveal');
  if (!('IntersectionObserver' in window)) {
    els.forEach((el) => el.classList.add('is-in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e, i) => {
        if (!e.isIntersecting) return;
        const el = e.target as HTMLElement;
        el.style.transitionDelay = `${Math.min(i * 70, 280)}ms`;
        el.classList.add('is-in');
        io.unobserve(el);
      });
    },
    { rootMargin: '-8% 0px -12% 0px' }
  );
  els.forEach((el) => io.observe(el));
});
</script>

<template>
  <!-- ══════════ 顶栏：品牌 + 导航 + npm 芯片 ══════════ -->
  <header class="topbar">
    <div class="topbar__in">
      <a class="brand" href="#top">
        <span class="brand__mark">bg</span>
        <span class="brand__name">bundle-guardian</span>
      </a>
      <nav class="navlinks" aria-label="页面导航">
        <a href="#funnel">效果图</a>
        <a href="#attribution">包归因</a>
        <a href="#diag">诊断</a>
        <a href="/__guardian" target="_blank" rel="noopener">完整报告</a>
      </nav>
      <span class="npm-chip mono">npm i -D <b>vite-plugin-bundle-guardian</b></span>
    </div>
  </header>

  <main id="top">
    <!-- ══════════ Hero ══════════ -->
    <section class="hero">
      <div class="shell">
        <div class="hero__grid">
          <div>
            <p class="build-stamp mono">
              <span class="dot"></span> BUILD #{{ buildId }} &nbsp;·&nbsp;
              {{ stats ? stats.assetCount : '—' }} assets &nbsp;·&nbsp;
              {{ stats ? stats.pkgCount : '—' }} packages
            </p>

            <h1 class="hero__title">
              构建产物<br />治理插件<em>·</em><br />
              <span class="hero__subtitle">体积守护 + 依赖分析</span>
            </h1>

            <p class="lede">
              让「包体积失控」从<strong>事后发现</strong>变成<strong>提交即拦截</strong>的工程化门禁。
              在 <code class="mono">generateBundle</code> 钩子里采集产物，用手写 SourceMap 解码做<strong>字节级体积归因</strong>，
              把每一 KB 精确追到 npm 包，并用 8 条治理规则给出可执行的修复建议。
            </p>

            <div class="hero__cta">
              <a class="btn btn--primary" href="#funnel">看效果图 ↓</a>
              <a class="btn btn--ghost" href="/__guardian" target="_blank" rel="noopener">完整报告 ↗</a>
            </div>

            <!-- KPI 数字墙：版式同概念图，数字全部现场算 -->
            <div class="kpis">
              <div class="kpi kpi--hot">
                <span class="kpi__val">
                  {{ governance ? '−' + governance.drop.toFixed(1) : '—' }}<small>%</small>
                </span>
                <span class="kpi__key">JS gzip 总量降幅（治理前 → 后）</span>
              </div>
              <div class="kpi">
                <span class="kpi__val">
                  {{ conservation !== null ? (conservation * 100).toFixed(2) : '—' }}<small>%</small>
                </span>
                <span class="kpi__key">归因覆盖率（包级 / JS 产物）</span>
              </div>
              <div class="kpi">
                <span class="kpi__val">
                  {{ stats ? Math.round(stats.durationMs) : '—' }}<small>ms</small>
                </span>
                <span class="kpi__key">{{ stats ? stats.assetCount : '—' }} 个产物分析耗时</span>
              </div>
              <div class="kpi">
                <span class="kpi__val">{{ stats ? stats.pkgCount : '—' }}</span>
                <span class="kpi__key">npm 包字节级归因</span>
              </div>
            </div>
          </div>

          <!-- 破格：轻微倾斜的终端卡片 -->
          <div class="term reveal">
            <div class="term__bar">
              <span class="term__dots"><i></i><i></i><i></i></span>
              <span class="term__title">bash — bundle-guardian check</span>
            </div>
            <pre class="term__body"><template v-for="(line, i) in termLines" :key="i"><span v-for="(seg, j) in line" :key="j" :class="seg.tone ? 't-' + seg.tone : ''">{{ seg.text }}</span>
</template><span v-if="loading" class="t-dim">正在读取构建报告…</span><span v-else-if="error" class="t-warn">还没有构建产物。
先跑：pnpm -F playground build</span></pre>
          </div>
        </div>

        <!-- 记忆点：压缩漏斗 -->
        <div class="waterfall reveal" id="funnel">
          <div class="wf-row" v-for="row in funnel" :key="row.label">
            <span class="wf-label mono">{{ row.label }}</span>
            <div class="wf-track">
              <div class="wf-fill" :style="{ width: Math.max(row.pct, 6) + '%' }">
                <b>{{ row.note }}</b>
              </div>
            </div>
            <span class="wf-size mono">{{ fmtBytes(row.bytes) }} <i>{{ row.delta }}</i></span>
          </div>
          <p class="hint" v-if="!funnel.length && !loading" style="margin-top: 14px">
            还没有构建产物。先跑 <code>pnpm -F playground build</code>，刷新本页即可看到真实数据。
          </p>
        </div>
      </div>
    </section>

    <hr class="rule-hr" />

    <!-- ══════════ 01 / 归因与诊断 ══════════ -->
    <section class="sec">
      <div class="shell">
        <div class="sec__head reveal">
          <div>
            <span class="eyebrow">01 / Attribution</span>
            <h2>到底是谁<br />吃掉了体积</h2>
          </div>
          <p class="lede" style="font-size: 1rem">
            下面两栏就是 <code class="mono">check</code> 命令的结论：左边是按 npm 包聚合的<strong>字节级归因</strong>，
            右边是 8 条规则命中的问题及修复建议。两者都从同一份报告里读出来，不存在「图表好看但算错」。
          </p>
        </div>

        <div class="duo">
          <section class="panel reveal" id="attribution">
            <div class="panel__head">
              <h3 class="panel__title">Top 包归因</h3>
              <span class="panel__sub">面积 = gzip</span>
            </div>
            <div class="panel__body">
              <div class="rank" v-if="topPackages.length">
                <div class="rank__row" v-for="p in topPackages" :key="p.pkg">
                  <span class="rank__name" :title="p.pkg">{{ p.pkg }}</span>
                  <div class="rank__bar"><i :class="p.tone" :style="{ width: p.width + '%' }"></i></div>
                  <span class="rank__size">{{ p.size.value }} {{ p.size.unit }}</span>
                </div>
              </div>
              <p class="hint" v-else>等待构建报告…</p>
              <p class="panel__note mono" v-if="stats">
                共 {{ stats.pkgCount }} 个包参与归因 ·
                覆盖率 {{ conservation !== null ? (conservation * 100).toFixed(2) : '—' }}%（包级 / JS 产物）
              </p>
            </div>
            <div class="panel__foot" v-if="largest">
              最大产物 → {{ largest.fileName.replace(/^assets\//, '') }} · {{ fmtBytes(largest.gzip) }} gzip
            </div>
          </section>

          <section class="panel reveal" id="diag">
            <div class="panel__head">
              <h3 class="panel__title">Diagnostics</h3>
              <span class="panel__sub">8 条内建规则 · 带修复建议</span>
            </div>
            <div class="diag" v-if="topDiagnostics.length">
              <div
                class="diag__item"
                :class="'diag--' + d.level"
                v-for="(d, i) in topDiagnostics"
                :key="i"
              >
                <span class="diag__icon">{{ d.level === 'error' ? '✖' : d.level === 'warn' ? '⚠' : 'ℹ' }}</span>
                <div>
                  <div class="diag__msg">
                    {{ d.msg }}
                    <span class="diag__rule">[{{ d.ruleId }}]</span>
                  </div>
                  <span class="diag__fix" v-if="d.fix">↳ {{ d.fix }}</span>
                </div>
                <span class="diag__bytes">{{ d.bytes ? fmtBytes(d.bytes) : '' }}</span>
              </div>
            </div>
            <p class="hint" v-else style="margin: 16px">等待构建报告…</p>
            <div class="panel__foot">
              ✖ {{ errorCount }} errors · ⚠ {{ warnCount }} warnings ·
              analyzed in {{ stats ? Math.round(stats.durationMs) : '—' }} ms
            </div>
          </section>
        </div>

        <footer class="foot">
          <span>playground · 故意埋雷的靶场 · Vue 3 + Element Plus + ECharts + moment + lodash</span>
          <span>设计语言与概念图共用一套 token（纸灰 / 墨黑 / 朱红）</span>
        </footer>
      </div>
    </section>

    <!-- 坏味道收纳盒：无可见 UI，仅让 before 模式的体积坏味道真实进包 -->
    <HiddenSink />
  </main>
</template>
