@echo off
chcp 65001 >nul
title zcode-bilingual status
node "%~dp0scripts\run.mjs" status
echo.
pause
