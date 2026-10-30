@echo off
title Anand Studio
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it with:  winget install OpenJS.NodeJS.LTS
  echo Then double-click this file again.
  pause
  exit /b 1
)
start "" http://localhost:4600
node server\server.js
pause
