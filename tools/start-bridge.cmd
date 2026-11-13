@echo off
chcp 65001 >nul
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo 未找到 Node.js，请先安装 Node 22+。
  pause
  exit /b 1
)
echo ============================================
echo  B站自动聊天 - 本地 Agent 桥接服务
echo  HTTP: http://127.0.0.1:8765
echo  Token: server\token.txt
echo  关闭本窗口即停止服务
echo ============================================
node server/bridge.mjs
pause
