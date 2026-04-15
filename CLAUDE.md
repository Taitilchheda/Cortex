# CLAUDE.md — Cortex Project

> This file tells Claude Code (and any AI agent) how to understand, navigate, and contribute to the Cortex codebase. Read this before touching any file.

---

## What Cortex Is

Cortex is a **fully local, privacy-first AI coding workstation** that runs 100% on-device via Ollama. It is a web application — Next.js 14 frontend + FastAPI backend — that orchestrates multiple local LLM models as specialised coding agents. No code ever leaves the user's machine.

**The core loop:**
1. User describes a project in natural language
2. Architect agent (qwen3-coder) produces a structured file plan
3. Task dispatcher classifies each file → assigns to a domain specialist (frontend / backend / ML / docs)
4. VRAM-aware selector picks the best available model for that specialist
5. Specialist generates the file with a domain-tuned prompt
6. Merger+validator checks cross-file consistency
7. Files are written to disk; self-healing loop runs build/test and patches failures

---

## Repository Structure

```
Cortex/
├── CLAUDE.md               ← You are here
├── AGENTS.md               ← Agent definitions, capabilities, routing rules
├── SKILLS.md               ← Reusable skill modules agents can invoke
├── .cortex/
│   ├── config.json         ← User's model routing, feature flags, env prefs
│   ├── memory/             ← Graph memory checkpoints (Obsidian-compatible)
│   ├── plugins/            ← User-installed agent plugins
│   └── skills/             ← User-defined custom skills
│
├── server/                 ← FastAPI backend (Python 3.10+)
│   ├── main.py             ← All HTTP routes, SSE streaming, file upload
│   ├── agents/
│   │   ├── orchestrator.py ← Master build pipeline, phase coordination
│   │   ├── dispatcher.py   ← 3-stage file classifier (rules → embed → LLM)
│   │   ├── vram_selector.py← VRAM monitor, model pool picker
│   │   ├── specialist.py   ← Domain-tuned prompt builder per specialist type
│   │   ├── file_writer.py  ← Non-streaming generation, content extraction, retry
│   │   ├── merger.py       ← Cross-file consistency validator + patcher
│   │   ├── reviewer.py     ← Post-build code review agent
│   │   ├── heal_loop.py    ← Self-healing build/test/fix loop
│   │   └── skill_runner.py ← Executes skills from SKILLS.md or .cortex/skills/
│   ├── config/
│   │   ├── models.py       ← MODEL_ROUTER (legacy v1 compat)
│   │   └── pools.py        ← SPECIALIST_POOLS, MODEL_BENCHMARKS (v2)
│   ├── api/
│   │   ├── state.py        ← SQLite session store, event history
│   │   ├── memory.py       ← Graph memory read/write (Obsidian MD format)
│   │   ├── checkpoints.py  ← Checkpoint create/restore/list
│   │   ├── plugins.py      ← Plugin loader, sandboxed execution
│   │   └── environments.py ← Multi-environment session sync
│   └── requirements.txt
│
├── dashboard/              ← Next.js 14 frontend
│   └── app/
│       ├── page.tsx        ← Main workspace orchestrator
│       ├── lib/
│       │   ├── api.ts      ← All fetch calls to :8000
│       │   ├── types.ts    ← TypeScript interfaces
│       │   └── utils.ts    ← Markdown parser, syntax highlight, uid
│       └── components/
│           ├── Header.tsx
│           ├── Sidebar.tsx
│           ├── MessageBubble.tsx
│           ├── InputBar.tsx
│           ├── AgentOutput.tsx
│           ├── RightPanel.tsx
│           ├── FileExplorer.tsx
│           ├── EnvironmentSwitcher.tsx  ← Multi-env continuity
│           ├── CheckpointPanel.tsx      ← Graph memory checkpoints
│           └── PluginManager.tsx        ← Agent/skill/plugin UI
│
├── INSTALL.bat
├── START.bat
├── START_DEV.bat
└── DIAGNOSE.bat
```

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend framework | Next.js + React | 14 / 18 |
| Language | TypeScript | 5 |
| Styling | Tailwind CSS | 3.4 |
| Backend framework | FastAPI + uvicorn | 0.115 / 0.30 |
| Backend language | Python | 3.10+ |
| Database | SQLite via aiosqlite | latest |
| Local inference | Ollama | latest |
| HTTP client | httpx (async) | 0.27+ |
| Validation | Pydantic | 2.8+ |
| Streaming | Server-Sent Events (SSE) → upgrading to WebSocket | — |

---

## How to Run Locally

```bash
# Backend (port 8000)
cd server
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload

# Frontend (port 3001)
cd dashboard
npm install
npm run dev
```

Or use `START_DEV.bat` which runs both. Ollama must be running separately (`ollama serve`).

---

## Core Conventions — Follow These Exactly

### Python (server/)
- **Always async/await** — no blocking I/O in async context. Use `asyncio.create_subprocess_exec` for subprocesses, `aiosqlite` for DB.
- **Pydantic for all schemas** — every request body and response object must be a Pydantic model.
- **Error handling** — use `HTTPException` with explicit status codes. Never let exceptions bubble to FastAPI's default handler silently.
- **Streaming** — SSE format: `yield f"data: {json.dumps(event)}\n\n"`. Every SSE event is a JSON object with at minimum `{type, session_id, ts}`.
- **File writes** — always go through `file_writer.py`. Never write files directly in orchestrator or API endpoints.
- **Imports** — relative imports within packages (`from .models import ...`). Absolute for cross-package (`from api.state import ...`).

### TypeScript (dashboard/)
- **No `any`** — all types live in `app/lib/types.ts`. Add new types there, not inline.
- **Server calls** — all fetch calls go through `app/lib/api.ts`. Never call `fetch(...)` directly in components.
- **State** — component-local state with `useState`. Global state (toasts, theme, shortcuts) with Zustand if added.
- **Streaming** — use `parseSSE()` from `app/lib/api.ts`. Never parse SSE manually in components.
- **CSS** — Tailwind utility classes only. No inline `style={{}}` except for dynamic values that Tailwind can't express.

### SSE Event Types
Every event yielded from the backend must be one of these types. Do not invent new types without updating `app/lib/types.ts` simultaneously.

| type | Fields | Meaning |
|---|---|---|
| `architect_stream` | `delta` | Token from architect planning |
| `file_classified` | `path`, `specialist` | Dispatcher assigned file to specialist |
| `file_stream` | `path`, `delta` | Token from specialist generating file |
| `file_created` | `path`, `rel_path`, `message` | File written to disk |
| `patch_applied` | `path`, `reason` | Merger patched a file |
| `checkpoint_saved` | `checkpoint_id`, `label` | Graph memory checkpoint created |
| `heal_attempt` | `iteration`, `errors` | Self-healing loop iteration started |
| `log` | `phase`, `message` | Structured status event |
| `error` | `message` | Fatal error |
| `complete` | `files_written` | Session completed |

---

## What NOT to Do

- **Never hardcode model names** in orchestrator or file_writer. Always go through `SPECIALIST_POOLS` in `config/pools.py`.
- **Never write to disk from main.py** — all file writes go through `agents/file_writer.py`.
- **Never use `os.system()`** — use `asyncio.create_subprocess_exec` for subprocesses.
- **Never store secrets in config.json** — all API keys go in `.env` and are loaded via environment variables.
- **Never call Ollama directly from the frontend** — all model calls go through the FastAPI backend.
- **Never break SSE streaming** — if a new endpoint needs streaming, follow the existing pattern in `/agent/build` exactly.

---

## Adding a New Agent

1. Create `server/agents/your_agent.py`
2. Define `async def run_your_agent(sid: str, ...) -> AsyncGenerator[dict, None]` — must be an async generator yielding SSE event dicts
3. Add a Pydantic request schema to `server/main.py`
4. Register the route in `server/main.py` following the existing `@app.post("/agent/build")` pattern
5. Add the event type to `AGENTS.md` and to `app/lib/types.ts`
6. Wire up the UI in `app/page.tsx` following the existing `handleSend` pattern

## Adding a New Skill

See `SKILLS.md` for the skill interface. Skills are Python callables that agents can invoke mid-task.

## Adding a New Plugin

See `.cortex/plugins/` — plugins are Python files with a `register(app)` function that mounts FastAPI routes. They are sandboxed and cannot import from `agents/` directly; they communicate via the REST API.

---

## Environment Variables

```bash
# .env (never commit this file)
OLLAMA_BASE_URL=http://localhost:11434        # Ollama API base
CORTEX_DB_PATH=./cortex.db                   # SQLite database path
CORTEX_MEMORY_DIR=./.cortex/memory          # Graph memory directory
OPENROUTER_API_KEY=sk-or-...                 # Optional cloud fallback
GITHUB_TOKEN=ghp_...                         # Optional: export to GitHub repo
TAVILY_API_KEY=tvly-...                      # Optional: web search tool
MAX_HEAL_ITERATIONS=3                        # Self-healing loop max retries
VRAM_OVERHEAD_FACTOR=1.15                    # Model runtime VRAM multiplier
```

---

## Testing

```bash
# Backend unit tests
cd server && pytest tests/ -v

# E2E (requires Ollama running)
cd server && pytest tests/e2e/ -v --timeout=120

# Frontend type check
cd dashboard && npx tsc --noEmit

# Frontend lint
cd dashboard && npm run lint
```

---

*Last updated: March 2026 — Cortex v2.0*
