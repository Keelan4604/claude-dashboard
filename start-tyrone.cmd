@echo off
echo Starting Tyrone always-on system...
echo.
echo [1] Dashboard server (port 3847)
echo [2] Token watcher (time-based optimizer)
echo [3] Session loop (auto-starts idle sessions)
echo [4] Usage scraper (CDP, requires Chrome on port 9222)
echo [5] HA-iCUE bridge (scene.off -> sons of the forst)
echo.

cd /d "C:\Users\Keela\Desktop\claude-dashboard"

:: Launch Chrome with remote debugging if not already running
tasklist /FI "IMAGENAME eq chrome.exe" 2>NUL | find /I "chrome.exe" >NUL
if %ERRORLEVEL% NEQ 0 (
    echo Starting Chrome with remote debugging on port 9222...
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
    timeout /t 3 >nul
)

start /b node server.js
start /b node token-watcher.js
start /b node session-loop.js
start /b node usage-scraper.js
start /b node ha-icue-bridge.js

echo All systems running. Press Ctrl+C to stop.
pause >nul
