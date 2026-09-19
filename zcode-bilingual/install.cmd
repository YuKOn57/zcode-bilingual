@echo off
chcp 65001 >nul
title zcode-bilingual install
node "%~dp0scripts\run.mjs" install
echo.
pause
