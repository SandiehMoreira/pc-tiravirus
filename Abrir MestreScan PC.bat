@echo off
chcp 65001 >nul
title MestreScan PC
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\instalar.ps1"
if errorlevel 1 (
  echo.
  echo Algo deu errado. Tire um print desta janela.
  pause
)
