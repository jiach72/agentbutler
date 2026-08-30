@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. >&2
  exit /b 1
)
node "%~dp0..\dist\main.js" %*
