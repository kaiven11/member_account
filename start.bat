@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"

echo ========================================
echo   MemberManager 会员账号管理平台
echo ========================================

if not exist node_modules (
  echo 首次运行, 安装依赖...
  call npm install
)

echo.
echo 启动服务 (端口 4002)...
echo 访问: http://localhost:4002
echo.
node server.js

pause
