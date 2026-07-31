@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install the LTS version from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies. This can take a few minutes...
  npm install
  if errorlevel 1 (
    echo Dependency install failed. Check the message above.
    pause
    exit /b 1
  )
)
npm run gui
pause
