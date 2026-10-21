@echo off
chcp 65001 >nul 2>nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

REM ===========================================================
REM  bundle-guardian 一键启动（Windows）
REM
REM  "前后端" 在本项目里的含义：
REM    后端 = packages/* 三个包的 tsc --watch 持续编译（工具链）
REM    前端 = playground 的 Vite dev server（Vue3 靶场）
REM
REM  用法：
REM    双击本文件            → before 模式（治理前的靶场）
REM    dev.bat after         → after 模式（治理后的靶场）
REM    dev.bat after --open  → 其余参数原样透传给 dev.mjs
REM
REM  小提示：
REM    · 本文件是 UTF-8 编码，开头的 chcp 65001 就是为了让中文正常显示，
REM      用记事本另存过的话请确认编码仍是 UTF-8
REM    · 5173 被占用时 Vite 会自动顺延到 5174，看实际输出即可
REM ===========================================================

echo.
echo   ██ bundle-guardian 一键启动
echo   ────────────────────────────────────────────
echo.

REM 记一下是不是双击启动（没有参数），决定最后要不要 pause
if "%~1"=="" ( set "NOARGS=1" ) else ( set "NOARGS=" )

REM ── ① 检查 Node ──────────────────────────────
where node >nul 2>nul
if errorlevel 1 (
    echo   [x] 没找到 node。请先安装 Node.js 18+ ：https://nodejs.org
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set "NODE_VER=%%v"
echo   [√] Node !NODE_VER!

REM ── ② 检查 pnpm（没有就用 corepack 兜一下）────
where pnpm >nul 2>nul
if errorlevel 1 (
    echo   [!] 没找到 pnpm，尝试用 corepack 启用...
    corepack enable >nul 2>nul
    where pnpm >nul 2>nul
    if errorlevel 1 (
        echo   [x] pnpm 不可用。请先执行： npm i -g pnpm
        echo.
        pause
        exit /b 1
    )
)
echo   [√] pnpm 已就绪

REM ── ③ 首次运行自动装依赖 ──────────────────────
if not exist "node_modules" (
    echo   [..] 首次运行，正在安装依赖，可能需要几分钟...
    call pnpm install
    if errorlevel 1 (
        echo   [x] 依赖安装失败，请查看上面的报错
        echo.
        pause
        exit /b 1
    )
)
echo   [√] 依赖已就绪

REM ── ④ 模式：只有 before / after 会被当作模式，其余参数原样透传 ──
set "MODE=before"
if /i "%~1"=="after"  set "MODE=after"
if /i "%~1"=="before" set "MODE=before"

echo.
echo   [..] 启动：工具链 watch 编译 + playground(!MODE!) dev server
echo   [..] Ctrl+C 一次退出全部进程
echo.

node scripts\dev.mjs --mode !MODE! %2 %3 %4 %5
set "EXIT_CODE=%errorlevel%"

echo.
if not "!EXIT_CODE!"=="0" (
    echo   [x] 退出码 !EXIT_CODE!，请查看上面的报错
) else (
    echo   [√] 已退出
)

REM 双击启动时停一下，否则窗口直接关掉，看不到任何报错
if defined NOARGS (
    echo.
    pause
)
exit /b !EXIT_CODE!
