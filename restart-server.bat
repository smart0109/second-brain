@echo off
cd /d "C:\Users\manis\social-selling-v4.1\second-brain-app"
echo Stopping any existing node processes on port 3000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000" ^| findstr "LISTENING"') do (
    echo Killing PID %%a
    taskkill /F /PID %%a 2>nul
)
timeout /t 2 /nobreak >nul
echo Starting Second Brain server on port 3000...
echo Press Ctrl+C to stop.
node server.js
pause
