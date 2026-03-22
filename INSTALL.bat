@echo off
title Cortex — Installation
echo ╔══════════════════════════════════════════════╗
echo ║  Cortex — First-Time Installation   ║
echo ╚══════════════════════════════════════════════╝
echo.

REM Check Python
echo [1/4] Checking Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Install Python 3.10+ from python.org
    echo Make sure to check "Add to PATH" during installation.
    pause
    exit /b 1
)
python --version
echo ✓ Python found

REM Check Node
echo.
echo [2/4] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Install Node.js 18+ LTS from nodejs.org
    pause
    exit /b 1
)
node --version
echo ✓ Node.js found

REM Install Python deps
echo.
echo [3/4] Installing Python dependencies...
cd /d "%~dp0server"
pip install -r requirements.txt
if errorlevel 1 (
    echo WARNING: Some pip packages may have had issues.
    echo Continuing anyway...
)
echo ✓ Python dependencies installed

REM Install Node deps + build
echo.
echo [4/4] Installing Node.js dependencies and building dashboard...
cd /d "%~dp0dashboard"
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)
call npm run build
echo ✓ Dashboard built

echo.
echo ╔══════════════════════════════════════════════╗
echo ║  Installation Complete!                       ║
echo ║                                               ║
echo ║  Next steps:                                  ║
echo ║  1. Make sure Ollama is running               ║
echo ║  2. Pull required models (see README)         ║
echo ║  3. Run START_DEV.bat or START.bat            ║
echo ╚══════════════════════════════════════════════╝
pause
