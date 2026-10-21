@echo off
chcp 65001 >nul 2>nul
REM 治理后的靶场（dayjs / lodash-es / echarts 按需 / EP 按需）
REM 等价于： dev.bat after
setlocal EnableDelayedExpansion
cd /d "%~dp0"
call dev.bat after %*
