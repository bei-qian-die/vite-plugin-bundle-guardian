#!/usr/bin/env node
/**
 * 一键启动开发环墶
 *
 * 这个仓库有「两条腿」：
 *   ① 工具链（packages/*）—— 改插件源码要 tsc --watch 持续编译出 dist
 *   ② 靶场（playground）  —— Vue3 dev server，用来直观地验证插件行为
 *
 * 麻烦在于：Vite 只在启动时加载一次插件，所以 packages/vite/dist 变了之后
 * dev server 必须重启才能生效。这个脚本把「编译 + 重启」串起来，
 * 并且所有子进程的日志带彩色前缀，Ctrl+C 一次全部收干净。
 *
 * 用法：
 *   node scripts/dev.mjs                # 全部启动（默认 before 模式）
 *   node scripts/dev.mjs --mode after   # 用治理后的靶场
 *   node scripts/dev.mjs --no-cli       # 不 watch cli 包（dev 场景一般用不到）
 *   node scripts/dev.mjs --no-playground # 只编译，不起前端
 *   node scripts/dev.mjs --open         # 自动打开浏览器
 *   node scripts/dev.mjs --skip-build   # 跳过首次全量构建（dist 已就绪时更快）
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ────────────── 参数 ────────────── */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const MODE = value('mode', 'before');
const WATCH_CLI = !flag('no-cli');
const RUN_PLAYGROUND = !flag('no-playground');
const AUTO_OPEN = flag('open');
const SKIP_BUILD = flag('skip-build');

if (!['before', 'after'].includes(MODE)) {
  console.error(`✖ --mode 只支持 before / after，收到：${MODE}`);
  process.exit(2);
}

/* ────────────── 终端输出 ────────────── */

const USE_COLOR = process.stdout.isTTY !== false && process.env.NO_COLOR === undefined;
const C = {
  reset: USE_COLOR ? '\x1b[0m' : '',
  dim: USE_COLOR ? '\x1b[2m' : '',
  bold: USE_COLOR ? '\x1b[1m' : '',
  core: USE_COLOR ? '\x1b[36m' : '',
  vite: USE_COLOR ? '\x1b[35m' : '',
  cli: USE_COLOR ? '\x1b[33m' : '',
  playground: USE_COLOR ? '\x1b[32m' : '',
  red: USE_COLOR ? '\x1b[31m' : '',
};

const PREFIX = {
  core: `${C.core}[core]${C.reset}      `,
  vite: `${C.vite}[vite]${C.reset}      `,
  cli: `${C.cli}[cli]${C.reset}       `,
  playground: `${C.playground}[playground]${C.reset}`,
};

/**
 * 清屏 / 光标移动类 ANSI 序列（SGR 颜色码要保留，所以只匹配 J/H/A-K/f/s/u 这类）
 * tsc --watch 每次重编译都会发 \x1b[2J\x1b[3J\x1b[H 清屏 ——
 * 多个子进程的日志混在一起时，一个清屏会把别人的输出全冲掉，必须滤掉。
 */
const CLEAR_ANSI = /\x1b\[(?:\d+;)*[JHfABCDsuKr]/g;

/** 把子进程的输出按行加上前缀再打出来 */
function pipe(stream, prefix) {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk.replace(CLEAR_ANSI, '');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      console.log(`${prefix}${line}`);
    }
  });
}

/* ────────────── 进程管理 ────────────── */

const children = new Map();

/**
 * 启动一个常驻子进程。
 *
 * detached 只在非 Windows 上开：Unix 需要进程组才能 `kill(-pid)` 整棵杀掉；
 * 但 Windows 一旦 detached，stdio pipe 就收不到数据（实测踩过），
 * 好在 Windows 有 `taskkill /T` 可以按进程树杀，不需要进程组。
 */
function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
    windowsHide: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });

  child.on('error', (err) => {
    console.log(`${PREFIX[name]}${C.red}启动失败：${err.message}${C.reset}`);
  });

  child.on('exit', (code, signal) => {
    // 主动 kill 引起的退出不算异常
    if (children.get(name) !== child) return;
    children.delete(name);
    const why = signal ? `被 ${signal} 终止` : `退出码 ${code}`;
    console.log(`${PREFIX[name]}${C.dim}${why}${C.reset}`);
  });

  pipe(child.stdout, PREFIX[name]);
  pipe(child.stderr, PREFIX[name]);
  children.set(name, child);
  return child;
}

function killTree(name) {
  const child = children.get(name);
  if (!child) return;
  children.delete(name);
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    /* 进程已经没了 */
  }
}

function shutdown(reason) {
  console.log(`\n${C.dim}收到 ${reason}，正在关闭所有子进程…${C.reset}`);
  for (const name of [...children.keys()]) killTree(name);
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* ────────────── 启动流程 ────────────── */

function runOnce(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    pipe(child.stdout, `${C.dim}[build]${C.reset}     `);
    pipe(child.stderr, `${C.dim}[build]${C.reset}     `);
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

async function main() {
  console.log(
    `\n${C.bold}██ bundle-guardian dev${C.reset}\n` +
      `${C.dim}工具链 watch 编译 + playground(${MODE}) 热重启 · Ctrl+C 全部退出${C.reset}\n`
  );

  // ① 先做一次全量构建：否则 dev server 起来时插件的 dist 还不存在，会直接报错
  if (!SKIP_BUILD) {
    console.log(`${C.dim}首次全量构建中…${C.reset}`);
    const code = await runOnce('pnpm', ['build']);
    if (code !== 0) {
      console.log(`${C.red}✖ 首次构建失败（退出码 ${code}），先修好编译错误再启动${C.reset}`);
      process.exit(code);
    }
    console.log(`${C.dim}构建完成，启动监听…${C.reset}\n`);
  }

  // ② 工具链 watch
  // 直接调 tsc 而不是 `pnpm -F ... run dev`：少一层 shell 包装，
  // 输出能实时透出来（pnpm 在管道里会吞掉 tsc 的 watch 输出），启动也更快。
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    console.log(`${C.red}✖ 找不到 typescript：${tsc}，请先 pnpm install${C.reset}`);
    process.exit(2);
  }
  const watchPkg = (name, pkgDir) =>
    start(name, process.execPath, [
      tsc,
      '-p',
      path.join('packages', pkgDir, 'tsconfig.build.json'),
      '--watch',
      '--preserveWatchOutput',
    ]);

  watchPkg('core', 'core');
  watchPkg('vite', 'vite');
  if (WATCH_CLI) watchPkg('cli', 'cli');

  if (!RUN_PLAYGROUND) {
    console.log(`${C.dim}--no-playground：只编译，不启动前端${C.reset}`);
    return;
  }

  // ③ 靶场 dev server
  // 同样绕开 pnpm：`pnpm run dev -- --mode x` 会把 "--" 原样传给 vite，参数会重复。
  // 直接调 vite 二进制，参数完全可控。
  const viteBin = path.join(ROOT, 'playground', 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) {
    console.log(`${C.red}✖ 找不到 vite：${viteBin}，请先 pnpm install${C.reset}`);
    process.exit(2);
  }

  const startPlayground = () => {
    killTree('playground');
    start('playground', process.execPath, [viteBin, '--mode', MODE], {
      cwd: path.join(ROOT, 'playground'),
    });
  };
  startPlayground();
  const bootedAt = Date.now();

  // ④ 插件产物变了就重启 dev server（Vite 只在启动时加载插件）
  const watched = [
    path.join(ROOT, 'packages/vite/dist'),
    path.join(ROOT, 'packages/core/dist'),
  ].filter((dir) => fs.existsSync(dir));

  let timer = null;
  const QUIET_MS = 6000; // tsc --watch 启动时会重写一遍 dist，这段时间内不重启
  for (const dir of watched) {
    try {
      fs.watch(dir, { recursive: true }, (_event, filename) => {
        if (!filename || !filename.endsWith('.js')) return;
        if (Date.now() - bootedAt < QUIET_MS) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          console.log(`\n${C.dim}插件产物已更新 → 重启 dev server${C.reset}`);
          startPlayground();
        }, 400);
      });
    } catch {
      /* 某些环境不支持递归监听，忽略即可 */
    }
  }

  const port = 5173;
  // 稍等一拍再打印，避免这条提示混在子进程启动日志里
  await new Promise((r) => setTimeout(r, 800));
  console.log(
    `\n${C.bold}就绪${C.reset}\n` +
      `  靶场      ${C.playground}http://localhost:${port}/${C.reset}\n` +
      `  体积面板  ${C.playground}http://localhost:${port}/__guardian${C.reset}\n` +
      `  （dev 态没有产物，面板会提示先跑一次 build；要看数据请用 pnpm build:before）\n`
  );

  if (AUTO_OPEN) {
    const command =
      process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = command === 'cmd' ? ['/c', 'start', '', `http://localhost:${port}/`] : [`http://localhost:${port}/`];
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

main().catch((err) => {
  console.error(`${C.red}✖ ${err.message}${C.reset}`);
  shutdown('error');
});
