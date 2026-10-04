@echo off
chcp 65001 >nul
node "%~dp0server\index.js" --open %*
pause
