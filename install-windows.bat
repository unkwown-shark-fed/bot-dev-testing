@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required before installing this desktop launcher.
  echo Download the LTS version from https://nodejs.org/ and run this installer again.
  pause
  exit /b 1
)
echo Installing bot desktop GUI dependencies...
npm install
if errorlevel 1 (
  echo Dependency install failed. Check the message above.
  pause
  exit /b 1
)
set "SHORTCUT_NAME=Discord Utility Bot GUI.lnk"
set "TARGET=%~dp0run-bot-gui.bat"
set "DESKTOP=%USERPROFILE%\Desktop\%SHORTCUT_NAME%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut('%DESKTOP%'); $s.TargetPath='%TARGET%'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%SystemRoot%\System32\shell32.dll,13'; $s.Save()"
echo.
echo Installed. Use the "Discord Utility Bot GUI" shortcut on your Desktop to open the app.
pause
