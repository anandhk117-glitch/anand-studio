@echo off
title Anand Studio
set PATH=%PATH%;C:\Program Files\Git\cmd
netstat -ano | findstr ":3001 .*LISTENING" >nul || start "FreeLLMAPI" /min cmd /c "cd /d C:\putaniloka-tools\freellmapi && node server\dist\index.js"
timeout /t 3 >nul
cd /d "%~dp0"
start "" http://localhost:4600
node server\server.js
pause

