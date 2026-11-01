@echo off
rem Runs the stockai server; output goes to stockai-server.log.
set "PATH=%USERPROFILE%\node-v22.23.4-win-x64;%PATH%"
cd /d "%USERPROFILE%\stock"
node --disable-warning=ExperimentalWarning apps/web/server/main.ts --no-schedule >> stockai-server.log 2>&1
