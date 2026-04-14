@echo off
echo Starting Tyrone always-on system...
echo.
echo [1] Dashboard server (port 3847)
echo [2] Token watcher (time-based optimizer)
echo [3] Session loop (auto-starts idle sessions)
echo [4] Usage scraper (dedicated Chrome profile, self-managed)
echo.

cd /d "C:\Users\Keela\Desktop\claude-dashboard"

start /b node server.js
start /b node token-watcher.js
start /b node session-loop.js
start /b node usage-scraper.js

echo All systems running. Press Ctrl+C to stop.
pause >nul
