# Cortex Run Guide (Windows)

This guide was validated on April 15, 2026 in this workspace.

## 1) Prerequisites

- Ollama installed and running
- Node.js 18+ (Node 24 also works)
- Python 3.10+

Optional quick checks:

- `python --version`
- `node --version`
- `npm --version`
- `curl http://localhost:11434/api/tags`

## 2) First-time setup

From the repository root:

- `INSTALL.bat`

This installs Python dependencies from `server/requirements.txt` and Node dependencies in `dashboard`.

## 3) Run in development mode (recommended)

Use one command from the repository root:

- `START_DEV.bat`

Starts:

- Backend API: http://localhost:8000
- Frontend dashboard: http://localhost:3001
- OpenAI-compatible endpoint: http://localhost:8000/v1

## 4) Run in production mode

From the repository root:

- `START.bat`

Starts the same services on the same ports, but with production frontend serving.

## 5) Manual run (if you prefer two terminals)

Terminal A (backend):

1. `cd server`
2. `python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload`

Terminal B (frontend):

1. `cd dashboard`
2. `npm run dev -- -p 3001`

## 6) Verify services

- Backend health: http://localhost:8000/health
- Frontend: http://localhost:3001

A healthy backend returns JSON with `"status": "healthy"` and connected Ollama status.

## 7) Troubleshooting

### Missing module error on backend start

If you see an import error similar to `No module named 'duckduckgo_search'`:

1. Make sure you are in repo root.
2. Reinstall backend deps:
   - `cd server`
   - `pip install -r requirements.txt`

### Ollama not connected

If `/health` shows Ollama disconnected:

1. Start Ollama: `ollama serve`
2. Pull at least one model (example): `ollama pull qwen3-coder:latest`
3. Re-check: http://localhost:8000/health

### Port already in use

If 8000 or 3001 is in use, stop old processes and rerun startup scripts.

## 8) Recommended startup order

1. Start Ollama first.
2. Run `START_DEV.bat`.
3. Open dashboard at http://localhost:3001.
4. Confirm backend health at http://localhost:8000/health.
