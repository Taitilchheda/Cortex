@echo off
title Cortex — Diagnostics
echo ╔══════════════════════════════════════════════╗
echo ║  Cortex — Diagnostic Tool            ║
echo ╚══════════════════════════════════════════════╝
echo.

echo ── System ──
echo OS: %OS%
echo User: %USERNAME%
echo Project: %~dp0
echo.

echo ── Python ──
python --version 2>nul || echo NOT FOUND
echo.

echo ── Node.js ──
node --version 2>nul || echo NOT FOUND
echo.

echo ── npm ──
npm --version 2>nul || echo NOT FOUND
echo.

echo ── Ollama ──
curl -s http://localhost:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo STATUS: NOT RUNNING
    echo Fix: Run "ollama serve" in a separate terminal
) else (
    echo STATUS: CONNECTED
    echo Models:
    curl -s http://localhost:11434/api/tags 2>nul | python -c "import sys,json; d=json.load(sys.stdin); [print(f'  - {m[\"name\"]} ({m[\"size\"]/(1024**3):.1f}GB)') for m in d.get('models',[])]" 2>nul || echo   (could not parse model list)
)
echo.

echo ── Agent Server ──
curl -s http://localhost:8000/ >nul 2>&1
if errorlevel 1 (
    echo STATUS: NOT RUNNING
    echo Fix: Run START_DEV.bat or START.bat
) else (
    echo STATUS: RUNNING
    curl -s http://localhost:8000/health 2>nul | python -c "import sys,json; d=json.load(sys.stdin); print(f'  Ollama: {d.get(\"ollama\",{}).get(\"status\",\"unknown\")}'); print(f'  Models: {d.get(\"model_count\",0)}'); print(f'  Sessions: {d.get(\"active_sessions\",0)}')" 2>nul || echo   (could not parse health)
)
echo.

echo ── Dashboard ──
curl -s http://localhost:3001/ >nul 2>&1
if errorlevel 1 (
    echo STATUS: NOT RUNNING
) else (
    echo STATUS: RUNNING on :3001
)
echo.

echo ── Python Packages ──
pip show fastapi uvicorn httpx pydantic aiosqlite 2>nul | findstr "Name Version" || echo   Some packages missing
echo.

pause
