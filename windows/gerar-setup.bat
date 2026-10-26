@echo off
rem Gera build\MestreScan-PC-Setup.exe (precisa do Inno Setup 6: winget install JRSoftware.InnoSetup)
cd /d "%~dp0"
set ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" set ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe
if not exist "%ISCC%" (
  echo Inno Setup 6 nao encontrado. Instale com: winget install JRSoftware.InnoSetup
  pause
  exit /b 1
)
"%ISCC%" MestreScan-PC.iss
