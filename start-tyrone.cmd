@echo off
title Tyrone Command Center
cd /d "%~dp0"
echo Starting Dashboard Server...
start /b node server.js
echo.
echo Dashboard running at http://localhost:3847
echo Press Ctrl+C to stop
pause >nul
