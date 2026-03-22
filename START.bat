@echo off
title Cortex — Production
echo ╔══════════════════════════════════════════════╗
echo ║  Cortex — Production Mode            ║
echo ╚══════════════════════════════════════════════╝
echo.

REM Start FastAPI server
echo Starting agent server on :8000...
start "Cortex Server" cmd /c "cd /d "%~dp0server" && python -m uvicorn main:app --host 0.0.0.0 --port 8000"

REM Start Next.js
echo Starting dashboard on :3001...
cd /d "%~dp0dashboard"
start "Cortex Dashboard" cmd /c "npm start -- -p 3001"

timeout /t 3 >nul

echo.
echo ✓ Server: http://localhost:8000
echo ✓ Dashboard: http://localhost:3001
echo ✓ OpenAI API: http://localhost:8000/v1
echo.
echo Press any key to stop both services...
pause >nul

taskkill /fi "windowtitle eq Cortex Server" /f >nul 2>&1
taskkill /fi "windowtitle eq Cortex Dashboard" /f >nul 2>&1
