@echo off
chcp 65001 >nul
title zcode-bilingual repair
node "%~dp0scripts\run.mjs" repair
echo.
pause
