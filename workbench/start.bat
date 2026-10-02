@echo off
chcp 936 >nul
cd /d "%~dp0"
title 大浪恋爱工作台

echo.
echo  ============================================
echo   大浪恋爱工作台 · 一键启动
echo  ============================================
echo.

netstat -ano | findstr ":3178" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo  [工作台已在运行] 直接打开页面 ...
  start "" http://127.0.0.1:5178
  exit /b 0
)

REM 探测 node / npm 是否在 PATH（很多用户装了 Node 但没把 npm 加进系统 PATH）
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo.
  echo  [错误] 未检测到 Node.js。
  echo  请先安装 Node 22.12 或更高版本：https://nodejs.org
  echo  安装时勾选 "Add to PATH"，装完重新双击本 start.bat。
  echo.
  pause
  exit /b 1
)
where npm >nul 2>nul
if %errorlevel% neq 0 (
  echo.
  echo  [错误] 检测到 node 但 npm 不在 PATH。
  echo  请重新运行 Node 安装程序，勾选 "Add to PATH"；
  echo  或手动把 Node 安装目录加入系统环境变量 PATH 后重试。
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo  [首次运行] 正在安装依赖（只需一次，约 1-2 分钟）...
  call npm install
  if %errorlevel% neq 0 (
    echo.
    echo  [错误] 依赖安装失败。请检查网络后重试，或手动运行：npm install
    echo.
    pause
    exit /b 1
  )
)

echo  [启动服务] 后端 3178 + 前端 5178 ...
start "dalang-workbench" cmd /k "set DALANG_MODE=local && npm run dev"

timeout /t 4 /nobreak >nul
start "" http://127.0.0.1:5178

echo.
echo  已打开 http://127.0.0.1:5178 （浏览器若未自动加载，手动刷新一次）
echo  首次使用：打开页面右上角「模型设置」，填中转站 Key + 向量库 Key，保存一次即可。
echo  服务运行在「dalang-workbench」窗口；关闭它 = 停止服务。
echo  下次再打开：双击本 start.bat 即可。
echo.
pause
