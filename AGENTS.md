# AGENTS.md — Cortex Agent Registry

> Defines every agent in the Cortex system: what it does, what model pool it uses, what inputs it expects, what events it emits, and how it fits into the build pipeline.

---

## Agent Architecture Overview

```
User Prompt
    │
    ▼
┌─────────────────────────────────────────────────────┐
│  Orchestrator (server/agents/orchestrator.py)       │
│  Coordinates all agents, manages session state,     │
│  decides parallel vs sequential execution           │
└──────────────────┬──────────────────────────────────┘
                   │
      ┌────────────┼────────────┐
      ▼            ▼            ▼
 Architect    Dispatcher    Skill Runner
 Agent        (classifies   (optional tools
 (plans)      each file)    invoked mid-task)
      │            │
      │       ┌────┴──────────────────────────────┐
      │       ▼                                   │
      │  ┌──────────────────────────────────────┐ │
      │  │     Specialist Agents                │ │
      │  │  FE Agent | BE Agent | ML Agent      │ │
      │  │  Docs Agent | Debug Agent            │ │
      │  └──────────────────────────────────────┘ │
      │            │                               │
      │       ┌────▼────────────────────┐          │
      │       │  Merger + Validator     │          │
      │       └────┬────────────────────┘          │
      │            │                               │
      │       ┌────▼────────────────────┐          │
      └──────▶│  File Writer            │◀─────────┘
              └────┬────────────────────┘
                   │
              ┌────▼────────────────────┐
              │  Self-Healing Loop      │
              │  (build → test → patch) │
              └────┬────────────────────┘
                   │
              ┌────▼────────────────────┐
              │  Reviewer Agent         │
              │  (post-build analysis)  │
              └─────────────────────────┘
```

---

## 1. Architect Agent

**File:** `server/agents/orchestrator.py` → `run_architect()`
**Purpose:** Produces the complete file plan from the user's prompt. Thinks holistically about the entire project before any code is written.

### Model pool
```python
'architect': ['qwen3-coder:latest', 'deepseek-coder-v2:16b', 'qwen2.5-coder:7b']
```

### Input
```python
{
    "task": str,           # user's natural language description
    "project_path": str,   # where to write files
    "context": {           # optional additional context
        "existing_files": list[str],   # files already in project_path
        "memory_notes": list[str],     # relevant graph memory entries
        "image_b64": str | None        # attached design mockup
    }
}
```

### Output (streamed SSE events)
```python
{"type": "architect_stream", "session_id": str, "delta": str}
{"type": "log", "phase": "architect_done", "message": "Plan: N files · 'project-name'",
 "plan": {
     "project_name": str,
     "tech_stack": list[str],
     "files": [{"path": str, "description": str, "priority": int}]
 }}
```

### Prompt strategy
The architect receives: user task + existing file tree + relevant memory notes + design image (if attached). It must output a JSON plan inside a code fence. If it outputs prose before the JSON, the plan parser extracts the fence content.

---

## 2. Task Dispatcher

**File:** `server/agents/dispatcher.py` → `dispatch()`
**Purpose:** Classifies every file in the architect's plan into a specialist domain. Three-stage pipeline — fastest stage first.

### Classification stages

| Stage | Method | Latency | Coverage |
|---|---|---|---|
| 1 | Rule-based (extension + path + filename) | < 1ms | ~85% of files |
| 2 | Embedding similarity (nomic-embed-text) | ~200ms | ~12% of files |
| 3 | LLM classification (qwen2.5:7b, 1-word output) | ~3s | ~3% of files |

### Output domains
- `frontend` — React, TypeScript, CSS, HTML, SVG, Tailwind, animations
- `backend` — Python, Go, Rust, APIs, databases, auth, business logic
- `ml` — PyTorch, HuggingFace, pandas, training loops, data pipelines
- `docs` — README, YAML, TOML, Dockerfile, GitHub Actions, .env

### Events emitted
```python
{"type": "file_classified", "session_id": str, "path": str, "specialist": str, "stage": int}
```

---

## 3. Frontend Specialist Agent

**File:** `server/agents/specialist.py` → `run_frontend_specialist()`
**Trigger:** Any file classified as `frontend` by the dispatcher

### Model pool
```python
'frontend': ['qwen2.5-coder:7b', 'llama3.1:8b', 'qwen2.5:7b']
```
Vision-capable upgrade: if image attached → prefer `qwen2.5-vl:7b` or `llava:7b`

### Domain expertise
- React functional components (TypeScript, never class components)
- Tailwind CSS (no inline styles, use config tokens)
- Accessibility (aria-label, role, keyboard nav)
- Responsive layouts (mobile-first, sm/md/lg breakpoints)
- Animation (Framer Motion, CSS transitions, CSS animations)
- Form handling, modals, sidebars, navigation

### Context injected into prompt
- Existing component list (already written files)
- TypeScript type definitions from types/index.ts
- Tailwind config colour tokens
- Design image (if attached — multimodal)

### Capabilities
- `generate_component` — write a full React component file
- `generate_page` — write a Next.js page
- `generate_styles` — write CSS/Tailwind config
- `design_to_code` — convert image mockup to component (requires vision model)

---

## 4. Backend Specialist Agent

**File:** `server/agents/specialist.py` → `run_backend_specialist()`
**Trigger:** Any file classified as `backend` by the dispatcher

### Model pool
```python
'backend': ['deepseek-coder-v2:16b', 'qwen3-coder:latest', 'deepseek-coder:6.7b', 'qwen2.5-coder:7b']
```

### Domain expertise
- FastAPI routes with Pydantic validation and typed responses
- SQLAlchemy ORM + Alembic migrations
- Authentication (JWT, OAuth2, session management)
- Async Python (always async/await, never blocking)
- REST and GraphQL API design
- Database query optimisation
- Security (input sanitisation, rate limiting, CORS)

### Context injected
- Existing API routes (already written endpoints)
- Pydantic model definitions
- Database schema (if db/ files already written)
- Environment variables referenced elsewhere

---

## 5. ML / Data Specialist Agent

**File:** `server/agents/specialist.py` → `run_ml_specialist()`
**Trigger:** Any file classified as `ml` by the dispatcher

### Model pool
```python
'ml': ['deepseek-r1:7b', 'qwen3-coder:latest', 'deepseek-coder-v2:16b']
```

**Why deepseek-r1 first:** Chain-of-thought reasoning handles the mathematical logic in ML code — loss function derivations, gradient flow, tensor shape tracking — far better than pure code completion models.

### Domain expertise
- PyTorch model definitions and training loops
- HuggingFace Transformers (tokenizers, models, trainers)
- pandas / numpy data processing pipelines
- scikit-learn classical ML pipelines
- MLflow / Weights & Biases experiment tracking
- ONNX export and model optimisation
- Reproducibility (random seeds, deterministic ops)

### Invariants this agent enforces
- All functions `async` where I/O is involved
- `torch.no_grad()` + `model.eval()` in every inference function
- Shape comments after every tensor op: `# (batch, seq_len, d_model)`
- `set_seed()` at top of every training script

---

## 6. Docs / Config Specialist Agent

**File:** `server/agents/specialist.py` → `run_docs_specialist()`
**Trigger:** Any file classified as `docs` by the dispatcher

### Model pool
```python
'docs': ['llama3.1:8b', 'qwen2.5:7b', 'deepseek-r1:7b']
```

**Why llama3.1 first:** Produces the clearest human-readable documentation. Using a 16B coder model for a README is wasteful.

### Domain expertise
- README with standard structure (title → install → usage → config → API → license)
- GitHub Actions CI/CD workflows (correct YAML syntax, proper job dependencies)
- Docker and docker-compose (pinned tags, minimal layers, non-root user)
- .env.example (every env var with placeholder + comment)
- CONTRIBUTING.md, CODE_OF_CONDUCT.md
- OpenAPI/Swagger documentation strings

---

## 7. Debug Agent

**File:** `server/agents/orchestrator.py` → `run_debug_agent()`
**Trigger:** User invokes `/debug` mode, or self-healing loop sends a specific error

### Model pool
```python
'debug': ['deepseek-r1:7b', 'qwen3-coder:latest', 'llama3.1:8b']
```

**Why deepseek-r1:** Reasoning traces are essential for debugging. The model shows its work step by step, making it far more reliable for root cause analysis.

### Capabilities
- `trace_error` — given a stack trace, identify root cause and affected files
- `suggest_fix` — produce a targeted patch for the failing file only
- `explain_code` — natural language explanation of any code section
- `review_logic` — identify logical bugs (off-by-one, race conditions, null checks)

---

## 8. Reviewer Agent

**File:** `server/agents/reviewer.py` → `run_reviewer()`
**Trigger:** Automatically after every successful build (configurable); or manual `/review`

### Model pool
```python
'review': ['deepseek-r1:7b', 'llama3.1:8b']
```

### Output structure
```python
{
    "security_issues": [{"file": str, "line": int, "severity": str, "description": str}],
    "performance_issues": [{"file": str, "description": str}],
    "missing_error_handling": [{"file": str, "function": str, "description": str}],
    "anti_patterns": [{"file": str, "pattern": str, "suggestion": str}],
    "overall_score": int,  # 0-100
    "summary": str
}
```

---

## 9. Self-Healing Loop Agent

**File:** `server/agents/heal_loop.py` → `run_heal_loop()`
**Trigger:** After all files written; runs automatically (configurable, default: on)

### Algorithm
```
1. Detect build command (package.json scripts, Makefile, pyproject.toml)
2. Run build/test as subprocess, capture stdout + stderr
3. If success → done
4. Parse error output → identify failing file(s) + error type
5. Route failing files back to their owning specialist with error as additional context
6. Specialist rewrites only the failing file(s)
7. Repeat from step 2 (max MAX_HEAL_ITERATIONS, default 3)
```

### Events emitted
```python
{"type": "heal_attempt", "session_id": str, "iteration": int, "errors": list[str]}
{"type": "heal_patch", "session_id": str, "file": str, "specialist": str}
{"type": "heal_success", "session_id": str, "iterations_taken": int}
{"type": "heal_failed", "session_id": str, "final_errors": list[str]}
```

---

## 10. Environment Sync Agent

**File:** `server/api/environments.py` → `sync_environment()`
**Purpose:** Maintains continuity when the user switches between coding environments (VS Code, Claude Code, Cortex, OpenClaw, etc.)

### What it syncs
- Open files + cursor positions
- Git branch + uncommitted changes (as a stash)
- Active Cortex session context + conversation history
- Running agent state (if a build was in progress)
- Plugin + skill configuration

### Supported environments
| Environment | Sync method |
|---|---|
| VS Code | File watcher + .vscode/cortex-sync.json |
| Claude Code | MCP tool integration |
| OpenClaw | REST API at /environments/push, /environments/pull |
| JetBrains IDEs | Plugin (planned) |
| Cursor | File watcher + settings sync |

---

## 11. Checkpoint Agent

**File:** `server/api/checkpoints.py` → `save_checkpoint()`, `restore_checkpoint()`
**Purpose:** Saves the complete session state to a graph memory node so the user can continue from exactly this point in any environment.

### Checkpoint contents
```python
{
    "id": str,                    # nanoid
    "label": str,                 # user-provided name or auto-generated
    "timestamp": str,
    "session": {
        "task": str,
        "messages": list,         # full conversation history
        "files_written": list[str],
        "plan": dict,
        "phase": str,             # what the agent was doing
        "specialist_context": dict  # per-specialist working memory
    },
    "project": {
        "git_stash": str | None,  # stash hash if there are uncommitted changes
        "git_branch": str,
        "open_files": list[str],
        "cursor_positions": dict[str, int]
    },
    "graph_links": list[str]      # IDs of related checkpoints
}
```

### Storage format
Checkpoints are saved as Markdown files in `.cortex/memory/` in Obsidian-compatible format:
```markdown
---
id: abc123
label: "Added auth module — before refactor"
timestamp: 2026-03-21T15:30:00Z
tags: [checkpoint, auth, backend]
related: [def456, ghi789]
---

# Session: Add JWT authentication

## Context
Working on: src/api/auth.py
Phase: backend specialist writing
...
```

---

## Agent Communication Rules

1. **Agents never call each other directly.** They yield events to the orchestrator which decides next steps.
2. **All model calls go through `select_model()`.** No agent hardcodes a model name.
3. **All file writes go through `file_writer.py`.** No agent writes to disk directly.
4. **All events must include `session_id` and `ts`.** Partial events are invalid.
5. **Skills are invoked via `skill_runner.py`**, never imported directly in agent code.
6. **Plugins communicate via REST API only.** They are sandboxed from agent internals.

---

*Last updated: March 2026 — Cortex v2.0*
