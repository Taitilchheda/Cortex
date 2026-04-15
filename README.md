# Cortex

Cortex is a fully local, privacy-first AI coding workstation built with a Next.js dashboard, a FastAPI backend, and Ollama model execution.

## What Is New (April 2026)

- Reliability hardening for code generation:
    - Architect plan parsing now tolerates malformed JSON-like output and falls back to a safe default plan.
    - Specialist generation now includes retry + model failover + guaranteed emergency fallback templates.
    - Merge-time missing-content cascades are prevented by non-empty fallback content.
- New Connectors system:
    - OAuth setup and login flow for GitHub and Google Drive.
    - Additional providers: Kaggle, Google Colab, Custom Agent, and MCP.
    - New Connectors panel in the dashboard.
- New RAG Context Engine:
    - Project indexing status, progress, ETA, and ranked snippet retrieval.
    - New RAG panel in the dashboard.
- New Git Visualizer:
    - Backend endpoint for lane-based commit graph data.
    - UI visualizer integrated in Git dashboard.
- Updated packaging and repo hygiene:
    - Expanded ignore rules for local runtime artifacts.
    - New packaging reference guide in docs.

## Core Capabilities

- Local-first multi-agent orchestration (architect, coder, debugger, reviewer, and role-routed chat).
- Streaming build and chat workflows with session/event persistence.
- Build pipeline with architect planning + file-level specialist generation.
- Refactor workflow with Aider integration.
- Connectors, queueing, project indexing, and telemetry panels.

## Quick Start

### Prerequisites

1. Ollama installed and running.
2. Python 3.10+.
3. Node.js 18+.

### Install

```bash
git clone https://github.com/Taitilchheda/Cortex.git
cd Cortex
INSTALL.bat
```

### Run

```bash
START_DEV.bat
```

Default endpoints:

- Frontend: http://localhost:3001
- Backend: http://localhost:8000

## New User Documentation

- Beginner usage walkthrough: [docs/USER_GUIDE.md](docs/USER_GUIDE.md)
- Platform-specific run and troubleshooting guide: [docs/HOW_TO_RUN.md](docs/HOW_TO_RUN.md)
- Packaging guide: [docs/PACKAGING_GUIDE.md](docs/PACKAGING_GUIDE.md)
- Roadmap: [ROADMAP.md](ROADMAP.md)

## Key API Additions

- Connectors:
    - `GET /connectors/providers`
    - `GET/POST /connectors/oauth/server-setup`
    - `POST /connectors/oauth/start`
    - `GET /connectors/oauth/callback`
- RAG:
    - `POST /rag/index`
    - `GET /rag/status`
    - `POST /rag/context`
- Git:
    - `GET /git/visualizer`

## Validation Commands

```bash
cd server
python -m pytest -q

cd ../dashboard
npx tsc --noEmit
npm run lint
```

## Project Layout

```text
Cortex/
├── dashboard/                 # Next.js frontend
│   └── app/
│       ├── components/        # Chat/build UI, connectors, git, RAG panels
│       └── lib/               # API client and shared types
├── server/                    # FastAPI backend
│   ├── agents/                # Orchestration and generation pipeline
│   ├── api/                   # Sessions, connectors, memory, config, state
│   └── connectors/            # Provider implementations
├── docs/
│   ├── HOW_TO_RUN.md
│   ├── USER_GUIDE.md
│   └── PACKAGING_GUIDE.md
└── START_DEV.bat
```

## License

MIT