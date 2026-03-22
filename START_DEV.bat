@echo off
title Mission Control — Development
echo ╔══════════════════════════════════════════════╗
echo ║  Mission Control — Development Mode           ║
echo ╚══════════════════════════════════════════════╝
echo.

REM Start FastAPI server with hot reload
echo Starting agent server on :8000 (hot reload)...
start "MC-Server-Dev" cmd /c "cd /d "%~dp0server" && python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload"

REM Start Next.js dev server
echo Starting dashboard on :3001 (hot reload)...
start "MC-Dashboard-Dev" cmd /c "cd /d "%~dp0dashboard" && npm run dev -- -p 3001"

timeout /t 3 >nul

echo.
echo ✓ Server: http://localhost:8000 (hot reload)
echo ✓ Dashboard: http://localhost:3001 (hot reload)
echo ✓ OpenAI API: http://localhost:8000/v1
echo.
echo Press any key to stop both services...
pause >nul

taskkill /fi "windowtitle eq MC-Server-Dev" /f >nul 2>&1
taskkill /fi "windowtitle eq MC-Dashboard-Dev" /f >nul 2>&1
