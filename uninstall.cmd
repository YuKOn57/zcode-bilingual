@echo off
chcp 65001 >nul
title zcode-bilingual uninstall
node "%~dp0scripts\run.mjs" uninstall
echo.
pause
