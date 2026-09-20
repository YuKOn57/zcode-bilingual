@echo off
chcp 65001 >nul
title zcode-bilingual apply
node "%~dp0scripts\run.mjs" apply
echo.
pause
