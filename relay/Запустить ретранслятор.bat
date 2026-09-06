@echo off
chcp 65001 > nul
title Clop ai — ретранслятор GPT
cd /d "%~dp0.."

echo Ретранслятор GPT. Пока это окно открыто, модели Терра и Соль работают.
echo Закроете окно — они перестанут отвечать. Свернуть можно.
echo.

:снова
node relay\agent.mjs
echo.
echo Ретранслятор остановился. Перезапуск через 10 секунд, Ctrl+C — выйти.
timeout /t 10 > nul
goto снова
