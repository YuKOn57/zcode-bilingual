@echo off
chcp 65001 >nul
title zcode-bilingual one-click apply
setlocal
set /a waited=0

echo.
echo zcode-bilingual: waiting for ZCode to exit...
echo (Now quit ZCode completely - including the tray icon, if any.)
echo The patch will be applied automatically once it has exited.
echo.

:wait
tasklist /fi "imagename eq ZCode.exe" 2>nul | find /i "ZCode.exe" >nul
if errorlevel 1 goto doapply
set /a waited+=2
if %waited% geq 1800 (
  echo.
  echo [!] Waited 30 minutes but ZCode is still running.
  echo     Quit ZCode completely, then double-click this file again.
  echo.
  pause
  exit /b 1
)
timeout /t 2 /nobreak >nul
goto wait

:doapply
echo.
echo ZCode has exited. Applying the translation patch...
echo.
node "%~dp0scripts\run.mjs" apply
echo.
pause
