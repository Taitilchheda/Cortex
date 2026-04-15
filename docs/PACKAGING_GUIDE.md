# Packaging Guide (Open Source Release)

This guide shows how to package Cortex in a polished, open-source way similar to local AI desktop tools.

## Release Targets

1. `Developer mode` (current): run frontend + backend separately.
2. `Portable local bundle`: one command starts backend + frontend.
3. `Desktop app`: single installer (`.exe/.dmg/.AppImage`) with embedded UI shell.
4. `Docker bundle`: reproducible environment for contributors.

## Recommended Project Layout

Keep source and generated files cleanly separated:

```text
Cortex/
  dashboard/           # Next.js frontend source
  server/              # FastAPI backend source
  docs/                # user + contributor docs
  scripts/             # build/release helper scripts
  tools/               # vendored binaries (if needed)
  .cortex/             # local runtime state (ignored)
```

## Packaging Strategy A: Portable OSS Bundle (Fastest)

Use this first for GitHub releases.

### Step 1: Build frontend

```powershell
Set-Location dashboard
npm ci
npm run build
```

### Step 2: Freeze backend dependencies

```powershell
Set-Location ../server
../.venv/Scripts/python.exe -m pip freeze > requirements-lock.txt
```

### Step 3: Add launcher script (`START_RELEASE.bat`)

Launch backend and frontend in one click:

```bat
@echo off
start cmd /k "cd /d %~dp0server && ..\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000"
start cmd /k "cd /d %~dp0dashboard && npm run start -- -p 3001"
```

### Step 4: Publish GitHub release artifacts

- Source zip
- `requirements-lock.txt`
- Optional portable archive with prebuilt frontend

## Packaging Strategy B: Desktop Installer (Like Claude-style Local App)

Use a desktop shell around the web UI.

### Option 1: Tauri (recommended for performance)

1. Wrap frontend with Tauri WebView.
2. Launch FastAPI as a sidecar process.
3. Ship native installers via Tauri build.

High-level tasks:

1. Add `src-tauri/` in project root.
2. Configure sidecar binary or Python launcher in `tauri.conf.json`.
3. Build frontend static assets for the desktop shell.
4. Use Tauri updater for versioned releases.

### Option 2: Electron

1. Electron main process starts backend subprocess.
2. BrowserWindow points to local frontend URL.
3. Use `electron-builder` to generate installers.

## Packaging Strategy C: Docker (Contributor-friendly)

Create `docker-compose.yml` with two services:

1. `server` (FastAPI)
2. `dashboard` (Next.js standalone)

Advantages:

- deterministic local setup
- clean dependency isolation
- CI-friendly

## CI/CD Release Pipeline (Professional OSS)

Use GitHub Actions with these jobs:

1. Lint + type checks.
2. Backend tests (`pytest`).
3. Frontend build.
4. Package artifacts.
5. Attach artifacts to release tags (`v*`).

## Open Source Hygiene Checklist

Before each release:

1. Ensure generated/runtime files are ignored (`.next`, `__pycache__`, `.cortex/environments`, DB journals).
2. Keep secrets only in `.env` (never committed).
3. Include:
   - `README.md`
   - `LICENSE`
   - `CONTRIBUTING.md` (if available)
   - `docs/HOW_TO_RUN.md`
4. Run validation:
   - backend tests
   - frontend lint/typecheck
5. Tag semantic versions (`vX.Y.Z`).

## Recommended Next Step

Implement Strategy A first (portable release), then move to Tauri for a polished one-click installer that feels closest to OpenClaw/Claude-style desktop UX.
