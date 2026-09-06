@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Clop ai
echo Запуск Clop ai...
node index.js
pause
