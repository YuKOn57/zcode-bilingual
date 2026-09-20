@echo off
chcp 65001 >nul
title zcode-bilingual restore
node "%~dp0scripts\run.mjs" restore
echo.
pause
