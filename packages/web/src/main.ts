/**
 * bundle-guardian 在线报告查看器
 *
 * 纯静态：所有解析、归因、布局都在浏览器里完成，
 * 直接复用 @beiqiandie/core 的编译产物（formatBytes / squarify / graph 算法），
 * 而不是在这里重新实现一遍 —— 页面和 CLI 共用同一套逻辑。
 *
 * 跨刷新的数据（历史记录 / 对比基线）统一走 src/backend.ts，
 * UI 层不直接碰 SDK；当前挂的是 CloudBackend（WorkBuddy 云服务）。
 */

import { formatBytes, formatPercent } from '@core/utils.js';
import { renderTreemapSvg } from '@core/report/treemap.js';
import { buildAdjacency, findRoots, findShortestPath } from '@core/graph.js';
import type { Report } from './types.js';
import { backend, type AnalysisRecord, type PendingOtp } from './backend.js';
import { buildShareLink, copyText, download } from './share.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

let current: Report | null = null;
let currentId: string | null = null;
let baseline: Report | null = null;
let baselineId: string | null = null;
let label = '';

/** 历史列表缓存（只含指标，不含报告全文） */
let records: AnalysisRecord[] = [];
/** 发码后待验码的状态，必须跨事件保存在这里 */
let pendingOtp: PendingOtp | null = null;
/** 未登录时打开分享链接，登录成功后再回来取 */
let pendingShared: string | null = null;

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

/** 把本地绝对路径压成 node_modules/... 的可读形式 */
const short = (p: string): string => {
  const i = p.lastIndexOf('node_modules/');
  if (i >= 0) return p.slice(i);
  const j = p.lastIndexOf('/');
  return j >= 0 ? p.slice(j + 1) : p;
};

function setStatus(text: string): void {
  $('status').textContent = text;
}

function show(id: string, on = true): void {
  $(id).classList.toggle('hidden', !on);
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ────────────────────────── 载入 ────────────────────────── */

/**
 * 拼接站点内相对路径，并保留当前 URL 上的查询参数（如 sharecode）。
 * 否则 new URL('samples/x.json', href) 会把 query 丢掉，静态托管会返回 403。
 */
function resolveAsset(rel: string): string {
  const dir = location.pathname.replace(/[^/]*$/, '');
  const url = new URL(dir + rel, location.origin);
  if (location.search) url.search = location.search;
  return url.href;
}

interface AdoptOptions {
  /** 是否归档到云端（从历史里「载入」回放时不需要再存一遍） */
  archive?: boolean;
  recordId?: string | null;
}

async function adopt(report: Report, name: string, opts: AdoptOptions = {}): Promise<void> {
  current = report;
  label = name;
  currentId = opts.recordId ?? null;
  render();

  if (opts.archive) {
    if (!backend.signedIn()) {
      setStatus(`${name} · 未登录，本次分析不会同步到历史`);
      return;
    }
    try {
      const saved = await backend.saveRecord(name, report);
      currentId = saved.id;
      setStatus(`${name} · 已归档到云端`);
    } catch (e) {
      setStatus(`归档失败：${errMsg(e)}`);
    }
  }
  void refreshHistory();
}

async function loadFromUrl(url: string, name: string): Promise<void> {
  setStatus(`载入 ${name} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const report = (await res.json()) as Report;
  await adopt(report, name, { archive: true });
}

async function loadFromFile(file: File): Promise<void> {
  setStatus(`解析 ${file.name} …`);
  const text = await file.text();
  let parsed: Report;
  try {
    parsed = JSON.parse(text) as Report;
  } catch {
    setStatus('解析失败：不是合法的 JSON');
    return;
  }
  if (!parsed || !parsed.summary || !Array.isArray(parsed.packages)) {
    setStatus('结构不匹配：请上传 bundle-guardian analyze --json 生成的报告');
    return;
  }
  await adopt(parsed, file.name.replace(/\.json$/i, ''), { archive: true });
}

/* ────────────────────────── 历史记录 ────────────────────────── */

async function refreshHistory(): Promise<void> {
  if (!backend.signedIn()) {
    records = [];
    $('histMeta').innerHTML = '<span class="flag">未登录 · 历史不会同步，报告也不会离开本机</span>';
    $('histList').innerHTML = '';
    show('histGate', true);
    show('histOps', false);
    show('compareCard', false);
    return;
  }

  show('histGate', false);
  show('histOps', true);
  records = await backend.listRecords();
  const sharedCount = records.filter((r) => r.shared).length;
  const base = records.find((r) => r.isBaseline) ?? null;

  $('histMeta').innerHTML =
    `<span>共 <b>${records.length}</b> 条</span>` +
    (sharedCount ? `<span>已分享 <b>${sharedCount}</b> 条</span>` : '') +
    `<span>账号：<b>${esc(backend.account()?.name ?? backend.account()?.phone ?? '已登录')}</b></span>` +
    `<span>存储后端：<b>${esc(backend.label)}</b></span>`;

  if (!records.length) {
    $('histList').innerHTML = '<p class="empty">还没有记录，载入示例或上传报告后会自动归档。</p>';
    return;
  }

  $('histList').innerHTML = records
    .map((r) => {
      const isCur = r.id === currentId;
      const isBase = r.isBaseline;
      let delta = '';
      if (base && !isBase) {
        const d = r.metrics.totalGzip - base.metrics.totalGzip;
        const cls = d < 0 ? 'down' : d > 0 ? 'up' : '';
        delta = `<span class="delta ${cls}">${d > 0 ? '+' : ''}${formatBytes(d)}</span>`;
      }
      const tags =
        (isCur ? '<span class="tag cur">当前</span>' : '') +
        (isBase ? '<span class="tag base">基线</span>' : '');
      return `<div class="hist ${isCur ? 'is-cur' : ''}">
        <div class="hline">
          <span class="hname">${esc(r.label)}</span>${tags}
          <span class="htime">${fmtTime(r.savedAt)}</span>
        </div>
        <div class="hmetrics">
          <span>gzip <b>${formatBytes(r.metrics.totalGzip)}</b></span>
          <span>产物 <b>${r.metrics.assetCount}</b></span>
          <span>包 <b>${r.metrics.packageCount}</b></span>
          <span class="${r.metrics.errorCount ? 'warn' : ''}">错误 <b>${r.metrics.errorCount}</b></span>
          ${delta}
        </div>
        <div class="hops">
          <button class="mini" data-act="load" data-id="${r.id}">载入</button>
          <button class="mini" data-act="base" data-id="${r.id}">设为基线</button>
          <button class="mini danger" data-act="del" data-id="${r.id}">删除</button>
        </div>
      </div>`;
    })
    .join('');
}

$('histList').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  if (act === 'load') void loadRecord(id as string);
  else if (act === 'base') void setBaselineById(id as string);
  else if (act === 'del') void deleteRecord(id as string);
});

$('btnClearHist').addEventListener('click', () => {
  void (async () => {
    await backend.clearRecords();
    current = null;
    currentId = null;
    baseline = null;
    baselineId = null;
    $('btnBaseline').textContent = '设为对比基线';
    show('compareCard', false);
    void refreshHistory();
    setStatus('已清空全部历史');
  })();
});

async function loadRecord(id: string): Promise<void> {
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  try {
    const report = await backend.loadReport(rec);
    /* 从历史回放，不需要再归档一次 */
    await adopt(report, rec.label, { recordId: rec.id });
    setStatus(`已载入历史记录：${rec.label}`);
  } catch (e) {
    setStatus(`载入失败：${errMsg(e)}`);
  }
}

async function deleteRecord(id: string): Promise<void> {
  try {
    await backend.deleteRecord(id);
  } catch (e) {
    setStatus(`删除失败：${errMsg(e)}`);
    return;
  }
  if (currentId === id) {
    currentId = null;
    current = null;
  }
  if (baselineId === id) {
    baselineId = null;
    baseline = null;
    $('btnBaseline').textContent = '设为对比基线';
    show('compareCard', false);
  }
  void refreshHistory();
  setStatus('已删除该记录');
}

async function setBaselineById(id: string): Promise<void> {
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  try {
    await backend.setBaseline(id);
    baseline = await backend.loadReport(rec);
    baselineId = rec.id;
    $('btnBaseline').textContent = `基线：${rec.label}`;
    renderCompare();
    void refreshHistory();
    setStatus(`基线已设为：${rec.label}`);
  } catch (e) {
    setStatus(`设置基线失败：${errMsg(e)}`);
  }
}

function setBaseline(): void {
  if (!current || !currentId) return;
  void setBaselineById(currentId);
}

/* ────────────────────────── 渲染 ────────────────────────── */

function render(): void {
  if (!current) return;
  renderMeta();
  renderCards();
  renderTreemap();
  renderPkgTable();
  renderDiagnostics();
  renderCompare();
  renderTraceHint();
  $('footVer').textContent = `${current.tool} ${current.version}`;
}

function renderMeta(): void {
  const r = current as Report;
  const parts = [
    `<span><b>${esc(r.tool)}</b> ${esc(r.version)}</span>`,
    `<span>分析耗时 <b>${r.durationMs} ms</b></span>`,
    `<span>产物 <b>${r.summary.assetCount}</b></span>`,
    `<span>生成于 <b>${new Date(r.at).toLocaleString('zh-CN')}</b></span>`
  ];
  if (r.degraded) parts.push('<span class="flag">降级模式（无 sourcemap，归因精度下降）</span>');
  $('meta').innerHTML = parts.join('');
  show('meta', true);
}

function renderCards(): void {
  const s = (current as Report).summary;
  const gzipPerAsset = s.assetCount ? s.totalGzip / s.assetCount : 0;
  const cards = [
    { k: '原始体积', v: formatBytes(s.totalRaw), d: `${s.assetCount} 个产物合计`, cls: '' },
    { k: 'gzip 后', v: formatBytes(s.totalGzip), d: `压缩比 ${formatPercent(s.totalGzip / (s.totalRaw || 1), 1)}`, cls: '' },
    { k: 'brotli 后', v: formatBytes(s.totalBrotli), d: '比 gzip 再省 ' + formatBytes(Math.max(0, s.totalGzip - s.totalBrotli)), cls: 'ok' },
    { k: '单产物均值', v: formatBytes(Math.round(gzipPerAsset)), d: 'gzip', cls: '' },
    { k: '错误级规则', v: String(s.errorCount), d: `警告 ${s.warnCount}`, cls: s.errorCount > 0 ? 'warn' : 'ok' }
  ];
  $('cards').innerHTML = cards
    .map(
      (c) =>
        `<div class="kpi ${c.cls}"><div class="k">${c.k}</div><div class="v">${c.v}</div><div class="d">${c.d}</div></div>`
    )
    .join('');
}

function renderTreemap(): void {
  const pkgs = (current as Report).packages;
  const items = pkgs
    .slice()
    .sort((a, b) => b.gzipBytes - a.gzipBytes)
    .slice(0, 24)
    .map((p) => ({ name: `${p.pkg}${p.version ? `@${p.version}` : ''}`, value: p.gzipBytes }));
  $('treemap').innerHTML = renderTreemapSvg(items, { width: 1100, height: 360, unit: 'KB' });
  show('treeCard', true);
}

function renderPkgTable(): void {
  const r = current as Report;
  const total = r.packages.reduce((s, p) => s + p.gzipBytes, 0) || 1;
  const rows = r.packages
    .slice()
    .sort((a, b) => b.gzipBytes - a.gzipBytes)
    .slice(0, 15)
    .map((p, i) => {
      const share = p.gzipBytes / total;
      return `<tr>
        <td class="num">${i + 1}</td>
        <td class="pkgname">${esc(p.pkg)}</td>
        <td class="ver">${p.version ? esc(p.version) : '—'}</td>
        <td class="num">${formatBytes(p.gzipBytes)}</td>
        <td class="num">${formatBytes(p.bytes)}</td>
        <td class="num">${formatPercent(share, 1)}</td>
        <td><div class="barwrap"><span style="width:${(share * 100).toFixed(1)}%"></span></div>
      </tr>`;
    })
    .join('');
  $('pkgTable').innerHTML = `<thead><tr>
      <th class="num">#</th><th>包</th><th>版本</th><th class="num">gzip</th><th class="num">原始</th><th class="num">占比</th><th>份额</th>
    </tr></thead><tbody>${rows}</tbody>`;
  show('pkgCard', true);
}

function renderDiagnostics(): void {
  const list = (current as Report).diagnostics;
  if (!list.length) {
    $('diagList').innerHTML = '<p class="empty">没有命中任何治理规则。</p>';
  } else {
    $('diagList').innerHTML = list
      .map(
        (d) => `<div class="diag ${esc(d.level)}">
          <div class="head">
            <span class="lv">${esc(d.level)}</span>
            <span class="rule">${esc(d.ruleId)}</span>
            <span class="where">${esc(short(d.where))}</span>
            <span class="where">${d.bytes ? formatBytes(d.bytes) : ''}</span>
          </div>
          <p class="msg">${esc(d.msg)}</p>
          <p class="fix">${esc(d.fix)}</p>
        </div>`
      )
      .join('');
  }
  show('diagCard', true);
}

function renderCompare(): void {
  if (!baseline || !current) return;
  const a = baseline.summary.totalGzip;
  const b = current.summary.totalGzip;
  const delta = b - a;
  const pct = (Math.abs(delta) / (a || 1)) * 100;
  const dir = delta < 0 ? 'down' : 'up';
  const mapA = new Map(baseline.packages.map((p) => [p.pkg, p.gzipBytes]));
  const top = current.packages
    .slice()
    .sort((x, y) => Math.abs(y.gzipBytes - (mapA.get(y.pkg) ?? 0)) - Math.abs(x.gzipBytes - (mapA.get(x.pkg) ?? 0)))
    .slice(0, 8)
    .map((p) => {
      const prev = mapA.get(p.pkg) ?? 0;
      const d = p.gzipBytes - prev;
      const cls = d < 0 ? 'down' : d > 0 ? 'up' : '';
      const sign = d > 0 ? '+' : '';
      return `<div class="cmpitem">
        <div class="pkg">${esc(p.pkg)}</div>
        <div class="delta ${cls}">${sign}${formatBytes(d)}　${sign}${((d / (prev || 1)) * 100).toFixed(1)}%</div>
        <div class="ver">${formatBytes(prev)} → ${formatBytes(p.gzipBytes)}</div>
      </div>`;
    })
    .join('');
  $('compareBody').innerHTML =
    `<p class="sub">基线 ${formatBytes(a)} → 当前 ${formatBytes(b)}，` +
    `<b class="${dir}">${dir === 'down' ? '减少' : '增加'} ${formatBytes(Math.abs(delta))}（${pct.toFixed(1)}%）</b></p>` +
    `<h3 style="font-size:13px;margin:12px 0 8px">包级变化 Top 8</h3><div class="cmp">${top}</div>`;
  show('compareCard', true);
}

function renderTraceHint(): void {
  const mods = (current as Report).modules ?? [];
  if (!mods.length) {
    show('traceCard', false);
    return;
  }
  $('pkgList').innerHTML = (current as Report).packages
    .map((p) => `<option value="${esc(p.pkg)}"></option>`)
    .join('');
  $('traceOut').innerHTML = '<p class="empty">输入包名试试，例如 echarts</p>';
  show('traceCard', true);
}

function trace(target: string): void {
  const mods = (current as Report).modules ?? [];
  if (!mods.length || !target.trim()) return;
  const adjacency = buildAdjacency(mods);
  const keyword = target.trim().toLowerCase();
  const path = findShortestPath(adjacency, (id) => id.toLowerCase().includes(keyword), findRoots(adjacency));
  if (!path || !path.length) {
    $('traceOut').innerHTML = `<p class="empty">没有找到包含 “${esc(target)}” 的引入链。</p>`;
    return;
  }
  $('traceOut').innerHTML = `<div class="chain">${path
    .map((id, i) => {
      const hit = i === path.length - 1;
      const line = `<div><span class="${hit ? 'hit' : 'step'}">${esc(short(id))}</span></div>`;
      return i === 0 ? line : `<div><span class="arrow">↑</span> ${line.replace(/^<div>/, '')}`;
    })
    .join('')}</div><p class="sub" style="margin-top:8px">共 ${path.length} 跳（BFS 最短路径，与 CLI <code>why</code> 同源）</p>`;
}

/* ────────────────────────── 账号 ────────────────────────── */

/** 渲染顶栏账号区 + 历史卡片上的登录入口 */
function renderAccount(): void {
  const acc = backend.account();
  const chip = $('authChip');

  if (!acc) {
    chip.innerHTML =
      '<span class="who">未登录</span>' +
      '<button class="mini" id="btnSignIn">登录 / 注册</button>';
    $('btnSignIn').addEventListener('click', () => {
      const gate = $('histGate');
      gate.scrollIntoView({ behavior: 'smooth', block: 'center' });
      ($('phoneInput') as HTMLInputElement).focus();
    });
    return;
  }

  const initial = (acc.name ?? acc.phone ?? '?').trim().charAt(0).toUpperCase();
  chip.innerHTML =
    `<span class="avatar">${esc(initial)}</span>` +
    `<span class="who">${esc(acc.name ?? acc.phone ?? '已登录')}</span>` +
    '<button class="mini" id="btnSignOut">退出</button>';
  $('btnSignOut').addEventListener('click', () => {
    void (async () => {
      try {
        await backend.signOut();
      } catch (e) {
        setStatus(`退出失败：${errMsg(e)}`);
      }
    })();
  });
}

let sendTimer = 0;

function setPhoneError(text: string): void {
  $('phoneErr').textContent = text;
}

function normalizePhone(v: string): string {
  return v.replace(/\D/g, '');
}

async function sendCode(): Promise<void> {
  const raw = ($('phoneInput') as HTMLInputElement).value;
  const phone = normalizePhone(raw);
  /* 大陆手机号：11 位且以 1 开头，不对其它地区号码套用这条规则 */
  if (!/^1\d{10}$/.test(phone)) {
    setPhoneError('请输入正确的 11 位手机号');
    return;
  }
  setPhoneError('');
  const btn = $('btnSendCode') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = '发送中 …';
  try {
    pendingOtp = await backend.sendPhoneCode(phone);
    $('loginHint').textContent = `${pendingOtp.isExistingUser ? '账号已存在' : '新账号'}，验证码已发送`;
    let left = 60;
    btn.textContent = `${left} 秒后重发`;
    sendTimer = window.setInterval(() => {
      left -= 1;
      if (left <= 0) {
        window.clearInterval(sendTimer);
        sendTimer = 0;
        btn.disabled = false;
        btn.textContent = '获取验证码';
      } else {
        btn.textContent = `${left} 秒后重发`;
      }
    }, 1000);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '获取验证码';
    setStatus(`验证码发送失败：${errMsg(e)}`);
  }
}

async function submitLogin(): Promise<void> {
  const token = ($('codeInput') as HTMLInputElement).value;
  if (!pendingOtp) {
    setStatus('请先获取验证码');
    return;
  }
  if (!/^\d{4,8}$/.test(token.trim())) {
    setStatus('请输入验证码');
    return;
  }
  try {
    /* 验证码输错时这里不会重新发码，pendingOtp 保持原样可继续重试 */
    await backend.verifyPhoneCode(pendingOtp, token);
    pendingOtp = null;
    ($('codeInput') as HTMLInputElement).value = '';
    if (sendTimer) {
      window.clearInterval(sendTimer);
      sendTimer = 0;
      const btn = $('btnSendCode') as HTMLButtonElement;
      btn.disabled = false;
      btn.textContent = '获取验证码';
    }
    renderAccount();
    if (pendingShared) {
      const p = pendingShared;
      pendingShared = null;
      await openShared(p);
    }
    void refreshHistory();
  } catch (e) {
    setStatus(`登录失败：${errMsg(e)}`);
  }
}

/* ────────────────────────── 分享 / 导出 ────────────────────────── */

/**
 * 分享：先确保当前报告已归档（拿到记录 id），再把全文复制到 shared/ 目录。
 * 链接里只带对象名，几十字节，不受 URL 长度限制。
 */
async function share(): Promise<void> {
  if (!current) return;
  if (!backend.signedIn()) {
    setStatus('生成分享链接需要先登录');
    return;
  }

  setStatus('生成分享链接 …');
  try {
    let id = currentId;
    if (!id) {
      const saved = await backend.saveRecord(label, current);
      id = saved.id;
      currentId = id;
    }
    const sharedPath = await backend.shareRecord(id);
    const link = buildShareLink(sharedPath);
    const ok = await copyText(link);
    setStatus(ok ? `分享链接已复制到剪贴板` : `分享链接：${link}`);
    void refreshHistory();
  } catch (e) {
    setStatus(`分享失败：${errMsg(e)}`);
  }
}

function exportJson(): void {
  if (!current) return;
  const name = `${label.replace(/[^\w.-]+/g, '_') || 'report'}-${new Date().toISOString().slice(0, 10)}.json`;
  download(name, JSON.stringify(current, null, 2));
  setStatus(`已导出 ${name}`);
}

/* ────────────────────────── 事件 ────────────────────────── */

$('btnBefore').addEventListener('click', () =>
  loadFromUrl(resolveAsset('samples/before.json'), '示例 · 优化前').catch((e) => setStatus(String(e)))
);
$('btnAfter').addEventListener('click', () =>
  loadFromUrl(resolveAsset('samples/after.json'), '示例 · 优化后').catch((e) => setStatus(String(e)))
);
$('btnBaseline').addEventListener('click', setBaseline);
$('btnSendCode').addEventListener('click', () => void sendCode());
$('btnLogin').addEventListener('click', () => void submitLogin());
$('phoneInput').addEventListener('input', () => setPhoneError(''));
$('codeInput').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') void submitLogin();
});
$('btnShare').addEventListener('click', () => void share());
$('btnExport').addEventListener('click', exportJson);
$('btnTrace').addEventListener('click', () => trace(($('traceInput') as HTMLInputElement).value));
$('traceInput').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') trace(($('traceInput') as HTMLInputElement).value);
});

$('fileInput').addEventListener('change', (e) => {
  const target = e.target as HTMLInputElement;
  if (target.files && target.files[0]) void loadFromFile(target.files[0]);
});

const drop = $('drop');
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const dt = e as DragEvent;
  if (dt.dataTransfer?.files?.[0]) void loadFromFile(dt.dataTransfer.files[0]);
});

/* ────────────────────────── 启动 ────────────────────────── */

function errMsg(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m.trim() ? m : String(e);
}

/** 打开分享链接：从 shared/ 目录取回报告全文 */
async function openShared(sharedPath: string): Promise<void> {
  try {
    const report = await backend.loadShared(sharedPath);
    await adopt(report, report.root ? `分享 · ${short(report.root)}` : '分享的报告');
    setStatus(`已打开分享链接 · ${report.summary.assetCount} 个产物`);
  } catch (e) {
    setStatus(`打开分享链接失败：${errMsg(e)}`);
  }
}

async function boot(): Promise<void> {
  try {
    await backend.init();
  } catch (e) {
    setStatus(`云服务初始化失败：${errMsg(e)}（分析功能仍可离线使用）`);
  }
  /* 会话刷新 / 退出都从这里回来，UI 只管重画 */
  backend.onAccountChange(() => {
    renderAccount();
    void refreshHistory();
  });
  renderAccount();

  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const sharedPath = hash.get('s');

  if (sharedPath) {
    if (!backend.signedIn()) {
      pendingShared = sharedPath;
      setStatus('这条分享链接需要登录后才能打开');
    } else {
      await openShared(sharedPath);
      void refreshHistory();
      return;
    }
  }

  try {
    await loadFromUrl(resolveAsset('samples/before.json'), '示例 · 优化前');
  } catch {
    setStatus('示例数据未加载，可直接上传自己的 report.json');
  }

  /* 恢复上次设过的对比基线（基线标记存在记录行上，换设备也会跟着同步） */
  const baseRec = records.find((r) => r.isBaseline);
  if (baseRec) {
    try {
      baseline = await backend.loadReport(baseRec);
      baselineId = baseRec.id;
      $('btnBaseline').textContent = `基线：${baseRec.label}`;
      renderCompare();
    } catch {
      baseline = null;
      baselineId = null;
    }
  }

  void refreshHistory();
}

void boot();

/* 便于冒烟测试断言页面状态 */
Object.assign(window as unknown as Record<string, unknown>, {
  __bg: {
    get current(): Report | null {
      return current;
    },
    get baseline(): Report | null {
      return baseline;
    },
    get label(): string {
      return label;
    },
    get signedIn(): boolean {
      return backend.signedIn();
    },
    records: (): Promise<AnalysisRecord[]> => backend.listRecords(),
    snapshot: () => records
  }
});
