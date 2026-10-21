# 一键启动脚本 · 实现笔记

`scripts/dev.mjs`（`pnpm dev`）负责把「工具链 watch 编译」和「playground dev server」
同时拉起来，并在插件产物变化时自动重启前端。

这篇记录三个**只有踩过才知道**的坑，以及对应的解法。

---

## 1. Windows 上 `detached: true` 会让 stdio pipe 收不到数据

最初为了能 `kill(-pid)` 整棵杀掉进程树，我给所有子进程设了 `detached: true`。
结果在 Windows 上，子进程的 stdout 一个字节都收不到 —— 日志全空。

最小复现：

```
=== plain    ===  OUT: "Starting compilation in watch mode..."
=== detached ===  （没有任何输出）
```

解法是**按平台区分**：

```ts
detached: process.platform !== 'win32',
```

- Unix：需要进程组才能 `process.kill(-pid)` 杀整棵树 → 开 detached
- Windows：detached 会断掉 pipe，改用 `taskkill /pid <pid> /T /F` 按进程树杀，不需要 detached

## 2. tsc --watch 的清屏序列会把别人的日志冲掉

tsc 每次重编译都会发 `\x1b[2J\x1b[3J\x1b[H`。单进程时这是「刷新屏幕」的正常行为，
但四个子进程共用一块终端时，一个清屏会把其它三路日志全部抹掉。

解法：只剥掉**光标/清屏类**序列，保留 SGR 颜色码（`\x1b[…m`）：

```ts
const CLEAR_ANSI = /\x1b\[(?:\d+;)*[JHfABCDsuKr]/g;
```

## 3. `pnpm run dev -- --mode x` 会把 `--` 原样传下去

实测拿到的是 `vite --mode before "--" "--mode" "before"` —— 参数重复，vite 还会报未知参数。

解法：**绕开包管理器，直接调二进制**。

```ts
// 工具链
start('core', process.execPath, [tscBin, '-p', 'packages/core/tsconfig.build.json', '--watch', '--pretty', 'false'])
// 前端
start('playground', process.execPath, [viteBin, '--mode', mode], { cwd: 'playground' })
```

顺带还有两个好处：少一层 shell 包装，启动更快；输出能实时透出来
（pnpm 在管道里会吞掉 tsc 的 watch 输出）。

---

## 为什么需要「自动重启」

Vite **只在启动时加载一次插件**。也就是说：

```
改 packages/vite/src/index.ts → tsc 重新编译 dist → dev server 毫无反应
```

必须重启 dev server 才能看到改动。脚本用 `fs.watch(dist, {recursive:true})` 监听，
400ms 防抖后重启。

还有个细节：`tsc --watch` **启动时就会重写一遍 dist**（即使代码没变），
所以启动后 6 秒内要忽略变化，否则刚起来就白重启一次。

---

## 参数

| 参数 | 作用 |
| --- | --- |
| `--mode after` | 用治理后的靶场（默认 before） |
| `--no-cli` | 不 watch cli 包（dev 场景一般用不到） |
| `--no-playground` | 只编译工具链 |
| `--open` | 自动打开浏览器 |
| `--skip-build` | 跳过首次全量构建（dist 已就绪时更快） |

## Windows 双击启动

根目录的 `dev.bat` / `dev-after.bat` 是给不想开终端的场景准备的，
它只做环境自查（node / pnpm / node_modules）+ 转发参数给 `dev.mjs`。

写 bat 时有两个坑：

4. **换行必须是 CRLF**。用 Unix 风格的 LF 保存，bat 里的多行括号块（`if ... (` 到 `)`）
   会解析错乱。`dev.mjs` 是纯 JS 不受影响，但 bat 一定要转。
5. **中文要用 UTF-8 + `chcp 65001`**。默认 GBK 代码页下，UTF-8 的中文会全部乱码；
   反过来，如果文件被存成 GBK 而代码页切成了 65001，同样乱码 —— 两者要配套。

另外 bat 里做参数解析要小心 `shift` 循环：循环跑完之后 `%1` 恒为空，
所以「双击才 pause」的判断必须在 shift **之前**先存下来。
这里为了避免踩坑，直接用「只有 before / after 会被当模式，%2 之后原样透传」的简化写法。
