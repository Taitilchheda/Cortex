# SKILLS.md — Cortex Skill Registry

> Skills are reusable, callable modules that agents invoke mid-task to perform discrete operations. Unlike agents (which orchestrate entire sessions), skills are atomic functions — they do one thing, return a result, and exit.
>
> Skills can be built-in (shipped with Cortex), user-defined (in `.cortex/skills/`), or installed via plugins.

---

## Skill Interface

Every skill is a Python async callable with this signature:

```python
# Standard skill interface
async def skill_name(
    context: SkillContext,     # session ID, project path, current files
    **kwargs                   # skill-specific parameters
) -> SkillResult:
    ...

@dataclass
class SkillContext:
    session_id:   str
    project_path: str
    written_files: dict[str, str]  # path -> content of already-written files
    model:        str              # the model currently active for this agent
    memory:       list[dict]       # relevant graph memory nodes

@dataclass
class SkillResult:
    success:  bool
    output:   str | dict | list    # skill-specific output
    events:   list[dict]           # SSE events to stream to the UI
    error:    str | None
```

Skills are registered in `server/agents/skill_runner.py` and invoked by agents using:
```python
result = await skill_runner.invoke("skill_name", context, param1=value1)
```

---

## Built-in Skills

### 1. `web_search`
Search the web for documentation, library usage, or recent API changes.

```yaml
name: web_search
trigger: agent detects unfamiliar library or API
provider: SearXNG (self-hosted) | Tavily API | DuckDuckGo fallback
input:
  query: str
  num_results: int  # default 5
  focus: "docs" | "examples" | "issues" | "general"
output:
  results: list[{title, url, snippet}]
  summary: str  # 2-3 sentence synthesis of top results
use_case: >
  Agent writing a FastAPI endpoint encounters 'pydantic v2 model_validator'.
  Triggers web_search("pydantic v2 model_validator example") to get correct
  v2 syntax before generating code. Prevents hallucination on recently-changed APIs.
config:
  TAVILY_API_KEY: optional (set in .env) — falls back to SearXNG if not set
  SEARXNG_URL: optional — self-hosted SearXNG instance URL
```

---

### 2. `read_file`
Read a file from the project or from the Cortex file system.

```yaml
name: read_file
trigger: agent needs to inspect an existing file before modifying it
input:
  path: str         # relative to project_path
  lines: [int, int] # optional line range [start, end]
output:
  content: str
  line_count: int
  language: str     # detected from extension
use_case: >
  Before the backend specialist writes a new endpoint, it reads the existing
  router.py to understand current route structure and avoid conflicts.
```

---

### 3. `run_command`
Execute a shell command in the project directory. Requires user approval unless whitelisted.

```yaml
name: run_command
trigger: self-healing loop, or agent needs to verify output
input:
  command: str        # the command to run
  cwd: str            # working directory (defaults to project_path)
  timeout: int        # seconds, default 60
  requires_approval: bool  # default true for non-whitelisted commands
output:
  stdout: str
  stderr: str
  exit_code: int
  success: bool
whitelist:
  - "npm run build"
  - "npm test"
  - "pytest"
  - "go build"
  - "cargo check"
  - "tsc --noEmit"
  - "python -m py_compile"
use_case: >
  Self-healing loop runs 'npm run build', captures the error, routes
  the failing file back to the frontend specialist with the error as context.
```

---

### 4. `embed_and_search`
Embed a query and search the project's vector index for semantically relevant files.

```yaml
name: embed_and_search
trigger: agent needs context from the existing codebase before writing
input:
  query: str
  top_k: int          # default 5
  filter_ext: list[str]  # optional, e.g. [".py", ".ts"]
output:
  results: list[{path, score, snippet}]
use_case: >
  Before the ML specialist writes a new model class, it searches for
  "existing model definitions" and retrieves relevant base classes to extend.
model: nomic-embed-text (via Ollama — already installed)
requires: project must be indexed (POST /projects/index called first)
```

---

### 5. `read_memory`
Retrieve relevant entries from the graph memory store.

```yaml
name: read_memory
trigger: start of any session, or when agent needs to recall past decisions
input:
  query: str
  top_k: int           # default 5
  tags: list[str]      # optional filter by tags
  checkpoint_id: str   # optional: load specific checkpoint's memory
output:
  nodes: list[{id, label, content, timestamp, tags, links}]
use_case: >
  User says "continue from yesterday's auth work". The orchestrator calls
  read_memory("JWT authentication Cortex session") and retrieves the checkpoint
  from the last auth session, restoring the conversation and file context.
storage: .cortex/memory/ — Obsidian-compatible Markdown files
```

---

### 6. `write_memory`
Create or update a node in the graph memory store.

```yaml
name: write_memory
trigger: significant milestone reached, checkpoint requested, session ends
input:
  label: str
  content: str       # Markdown-formatted memory content
  tags: list[str]
  links: list[str]   # IDs of related memory nodes to link to
  checkpoint_data: dict | None  # full checkpoint if this is a save point
output:
  node_id: str
  file_path: str     # path of the created .md file in .cortex/memory/
use_case: >
  After writing auth.py, the agent calls write_memory with a summary:
  "Implemented JWT auth using python-jose. Token expiry: 30min access,
  7-day refresh. User model: {id, email, role}. Connected to /api/auth/login."
  This is linked to the session checkpoint for future retrieval.
format: Obsidian-compatible frontmatter YAML + Markdown body
```

---

### 7. `git_snapshot`
Create a git stash or commit of the current project state before a major change.

```yaml
name: git_snapshot
trigger: before aider refactor, before self-healing patches, before environment switch
input:
  label: str          # stash/commit message
  mode: "stash" | "commit"
  branch: str | None  # if commit: which branch
output:
  ref: str            # stash hash or commit SHA
  files_included: int
use_case: >
  Before the self-healing loop patches failing files, it calls git_snapshot
  with mode="stash" so the user can restore the pre-patch state if needed.
requires: project_path must be a git repository
```

---

### 8. `validate_syntax`
Run a fast syntax check on a file without executing it.

```yaml
name: validate_syntax
trigger: file_writer after generating content, before writing to disk
input:
  content: str
  language: str   # "python" | "typescript" | "json" | "yaml" | "rust" | "go"
  file_path: str
output:
  valid: bool
  errors: list[{line, col, message}]
use_case: >
  After generating a Python file, validate_syntax runs ast.parse() on the
  content. If it fails, the file_writer triggers a retry with the syntax
  error appended to the prompt before writing to disk.
validators:
  python: ast.parse()
  typescript: tsc --noEmit (via subprocess)
  json: json.loads()
  yaml: yaml.safe_load()
  rust: rustfmt --check (if installed)
  go: gofmt -e (if installed)
```

---

### 9. `generate_env_example`
Collect all environment variable references from the project and generate .env.example.

```yaml
name: generate_env_example
trigger: merger+validator after all files are written
input:
  file_contents: dict[str, str]  # all generated files
output:
  env_example: str   # content of .env.example
  vars_found: list[{name, file, suggested_value, comment}]
use_case: >
  After a full build, the merger scans all files for os.getenv(), process.env.X,
  pydantic-settings field definitions, and docker-compose environment: sections.
  Generates a complete .env.example with placeholder values and inline comments.
```

---

### 10. `fetch_ollama_models`
Query the local Ollama instance for installed models with real sizes and metadata.

```yaml
name: fetch_ollama_models
trigger: startup, model advisor request, VRAM selector
input: none
output:
  models: list[{name, size_bytes, size_gb, family, parameters, quantization, modified_at}]
  ollama_version: str
  total_size_gb: float
use_case: >
  VRAM selector calls fetch_ollama_models before every build to get current
  real sizes (not estimates) from the Ollama API. Ensures accurate VRAM fitting.
endpoint: GET http://localhost:11434/api/tags
```

---

### 11. `fetch_cloud_models`
Query available cloud models from Ollama's cloud offering or OpenRouter.

```yaml
name: fetch_cloud_models
trigger: user opens model picker, user has cloud account configured
input:
  provider: "ollama_cloud" | "openrouter"
  filter_free: bool  # show only free-tier models
output:
  models: list[{name, provider, context_window, cost_per_1m_tokens, free_tier_limit, capabilities}]
use_case: >
  User has an Ollama account with access to glm-4:cloud. fetch_cloud_models
  retrieves the available cloud models and their free-tier limits. The VRAM
  selector can then offer cloud models as high-quality options that use zero
  local VRAM.
cloud_models_example:
  - name: "glm-4:cloud"
    free_tier: "100 requests/day"
    context: 128000
  - name: "qwen-max:cloud"
    free_tier: "50k tokens/day"
```

---

### 12. `diff_files`
Compute and display a unified diff between two versions of a file.

```yaml
name: diff_files
trigger: merger patches a file, aider refactor completes, user requests diff view
input:
  original: str    # original file content
  modified: str    # modified file content
  file_path: str
output:
  unified_diff: str
  additions: int
  deletions: int
  hunks: list[{start_line, end_line, added, removed}]
use_case: >
  When the merger patches a type mismatch, diff_files shows the user exactly
  what changed and streams it to the diff viewer in the dashboard.
```

---

## User-Defined Skills

Users can add custom skills to `.cortex/skills/`. Each skill is a Python file with this structure:

```python
# .cortex/skills/my_skill.py

from server.agents.skill_runner import SkillContext, SkillResult

SKILL_METADATA = {
    "name": "my_skill",
    "description": "What this skill does in one sentence",
    "version": "1.0.0",
    "trigger": "When to invoke this skill",
    "input_schema": {
        "param1": "str — description",
        "param2": "int — description",
    }
}

async def run(context: SkillContext, param1: str, param2: int = 5) -> SkillResult:
    # Your skill logic here
    return SkillResult(
        success=True,
        output={"result": "..."},
        events=[
            {"type": "log", "phase": "skill", "message": f"my_skill ran with {param1}"}
        ],
        error=None
    )
```

Cortex auto-discovers files in `.cortex/skills/` at startup and registers them alongside built-in skills.

---

## Skill Selection Guidelines

When should an agent invoke a skill vs. just doing it inline?

| Task | Use a skill | Reason |
|---|---|---|
| Search the web | `web_search` | Consistent API abstraction, fallback providers |
| Read an existing file | `read_file` | Consistent path resolution, error handling |
| Run a shell command | `run_command` | User approval gate, whitelist enforcement |
| Search codebase | `embed_and_search` | Requires vector index, not trivial inline |
| Save context | `write_memory` | Graph format, Obsidian compatibility |
| Check syntax | `validate_syntax` | Reused in file_writer, merger, and heal loop |
| Check env vars | `generate_env_example` | Shared between merger and docs specialist |

Agents should NOT use a skill for:
- Generating code (that is the agent's own job via the model)
- Deciding which specialist to route a file to (that is the dispatcher's job)
- Writing files to disk (always use file_writer.py)

---

## Recommended Skill Stack for Cortex

For a fully-featured installation, ensure these are configured:

| Skill | Requirement | Priority |
|---|---|---|
| `fetch_ollama_models` | Ollama running | Essential |
| `validate_syntax` | Python stdlib (ast) | Essential |
| `run_command` | Shell access | Essential |
| `read_file` | File system access | Essential |
| `embed_and_search` | nomic-embed-text in Ollama | High |
| `read_memory` / `write_memory` | .cortex/memory/ directory | High |
| `git_snapshot` | git installed in project | High |
| `web_search` | Tavily API key OR SearXNG | Medium |
| `fetch_cloud_models` | Ollama account OR OpenRouter key | Medium |
| `diff_files` | Python difflib (stdlib) | Medium |
| `generate_env_example` | None | Medium |

---

*Last updated: March 2026 — Cortex v2.0*
