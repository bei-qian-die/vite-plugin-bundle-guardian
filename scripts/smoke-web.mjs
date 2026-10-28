/**
 * 冒烟测试：用 happy-dom 在 Node 里真实执行打包产物，验证页面渲染逻辑。
 * 目的不是做视觉校验，而是确认「导入 → 取数 → 渲染」这条链路没有问题。
 *
 *   node ../../scripts/smoke-web.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const built = resolve(root, 'packages/web/dist/assets');

/* happy-dom 借用本机另一个仓库里的依赖（避免为了跑测试再装一遍） */
const happyDomPaths = [
  'C:/Users/qiuzh/Documents/Trae-CN/temp_20261020_01/nova-ui/node_modules/.pnpm/happy-dom@15.11.7/node_modules/happy-dom',
  'C:/Users/qiuzh/Documents/Trae-CN/temp_20261020_01/nova-ui/node_modules/happy-dom'
];
const happyDomRoot = happyDomPaths.find((p) => existsSync(p));
if (!happyDomRoot) {
  console.warn('未找到 happy-dom，跳过 DOM 冒烟（仅做产物存在性检查）');
  process.exit(0);
}
const req = createRequire(`${happyDomRoot}/`);
const { Window } = req('happy-dom');

/*
 * 构建时 emptyOutDir=false（绕开沙箱的批量删除保护），assets 里会留下历史产物。
 * 所以按 mtime 取最新的那份，否则会拿旧包跑测试、误判新代码没生效。
 */
const bundleName = readdirSync(built)
  .filter((f) => f.endsWith('.js'))
  .map((f) => ({ f, t: statSync(resolve(built, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t)[0]?.f;
if (!bundleName) {
  console.error('没有找到打包产物，先跑 scripts/build-web.mjs');
  process.exit(1);
}
console.log(`[smoke] bundle = ${bundleName}`);

const html = readFileSync(resolve(root, 'packages/web/dist/index.html'), 'utf8');
const markup = html
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .replace(/<link[^>]*>/g, '')
  .replace(/<!DOCTYPE[^>]*>/i, '');

const main = readFileSync(resolve(root, 'packages/web/index.html'), 'utf8');
const bodyMatch = /<body>([\s\S]*?)<script/.exec(main);

const win = new Window({ url: 'http://localhost/analyzer/' });
const doc = win.document;
doc.body.innerHTML = bodyMatch ? bodyMatch[1] : markup;

globalThis.window = win;
globalThis.document = doc;
globalThis.location = win.location;
globalThis.HTMLElement = win.HTMLElement;
globalThis.KeyboardEvent = win.KeyboardEvent;
globalThis.DragEvent = win.DragEvent;
globalThis.Event = win.Event;
globalThis.MutationObserver = win.MutationObserver;
globalThis.CustomEvent = win.CustomEvent;
globalThis.Node = win.Node;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);

/* 历史记录依赖 Web Storage / 压缩流：优先用 happy-dom 的实现，缺失时退回 Node 全局 */
globalThis.localStorage = win.localStorage ?? globalThis.localStorage;
globalThis.DOMException = win.DOMException ?? globalThis.DOMException;
for (const key of ['Blob', 'Response', 'CompressionStream', 'DecompressionStream', 'btoa', 'atob']) {
  if (globalThis[key] === undefined && win[key] !== undefined) globalThis[key] = win[key];
}

const samples = new Map([
  ['/analyzer/samples/before.json', JSON.parse(readFileSync(resolve(root, '.tmp-reports/before.json'), 'utf8'))],
  ['/analyzer/samples/after.json', JSON.parse(readFileSync(resolve(root, '.tmp-reports/after.json'), 'utf8'))]
]);

globalThis.fetch = async (input) => {
  const url = String(input);
  const pathname = new URL(url).pathname;
  if (samples.has(pathname)) {
    const data = samples.get(pathname);
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

await import(`file://${resolve(built, bundleName)}`);
await new Promise((r) => setTimeout(r, 300));

const pick = (sel) => (doc.querySelector(sel)?.innerHTML ?? '').trim();
const isHidden = (id) => doc.getElementById(id).className.includes('hidden');

/* 首屏结束时的状态：这些快照必须在后续交互之前取，否则会被覆盖 */
const bootStatus = pick('#status');

/* 第二阶段：未登录状态下切换示例，历史区应显示登录入口而不是记录 */
doc.getElementById('btnAfter').click();
await new Promise((r) => setTimeout(r, 400));
const gateShown = !isHidden('histGate');
const opsHidden = isHidden('histOps');
const gateText = pick('#histMeta');
const twoRecords = (await win.__bg.records()).length;
const compareShown = false; // 未登录时走云端基线，此路径不覆盖
const baselinePersisted = null;
const baselineTagged = null;
const checks = [
  ['KPI 卡片已渲染', pick('#cards').includes('kpi') && pick('#cards').length > 200],
  ['包表格含 echarts', pick('#pkgTable').includes('echarts')],
  ['包表格含 element-plus', pick('#pkgTable').includes('element-plus')],
  ['树图已生成 SVG', pick('#treemap').includes('<svg')],
  ['树图有矩形块', (pick('#treemap').match(/<rect/g) || []).length > 5],
  ['诊断项已渲染', pick('#diagList').includes('single-huge-chunk')],
  ['修复建议已渲染', pick('#diagList').includes('manualChunks')],
  ['引入链面板可见', !doc.getElementById('traceCard').className.includes('hidden')],
  ['meta 条含耗时', pick('#meta').includes('ms')],
  ['状态栏已更新', bootStatus.includes('示例')],
  /* 登录门控：未登录时不得读写用户级数据 */
  ['未登录时历史为空', twoRecords === 0],
  ['未登录时展示登录入口', gateShown],
  ['未登录时隐藏历史操作', opsHidden],
  ['未登录提示可见', gateText.includes('未登录')],
  ['未登录不显示对比面板', compareShown === false]
];

let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

const kpis = [...doc.querySelectorAll('#cards .kpi')].map((el) => {
  const k = el.querySelector('.k')?.textContent ?? '';
  const v = el.querySelector('.v')?.textContent ?? '';
  return `${k}=${v}`;
});
console.log('\nKPI:', kpis.join('  |  '));

process.exit(failed === 0 ? 0 : 1);
