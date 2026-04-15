"""
Cortex — FastAPI Main Server
All HTTP routes, CORS, file upload, /v1 OpenAI compat, SSE streaming.
Port: 8000
"""
import os
import json
import time
import glob
import pathlib
import base64
import mimetypes
import asyncio
import subprocess
import shutil
import sqlite3
import uuid
import re
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any
from fastapi import FastAPI, UploadFile, File, Request, HTTPException, BackgroundTasks, WebSocket, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from api.state import (
    init_db, create_session, get_session, list_sessions, 
    delete_session, clear_all_sessions, add_event, update_session_title, search_sessions,
    index_project_file, search_project_context, clear_project_index,
    set_session_pinned, list_pinned_sessions,
    set_preference, get_preference, list_preferences,
    DB_PATH,
)
from api.memory import init_memory_db
from api.config import init_cortex_workspace, router as cortex_config_router
from api.environments import init_environments_db, router as environments_router
from api.plugins import initialize_plugins, router as plugins_router
from api.skills import router as skills_router
from api.hardware import router as hardware_router
from api.checkpoints import init_checkpoints_db, router as checkpoints_router
from api.connectors import init_connectors_db, router as connectors_router
from config.models import (
    MODEL_ROUTER, get_model_for_role, update_router, 
    check_ollama_health, fetch_ollama_models, recommend_models, fetch_unified_models,
    OLLAMA_BASE, BENCHMARK_DB
)
from agents.orchestrator import (
    run_build, run_chat, run_aider, openai_chat_completion, 
    PROJECT_TEMPLATES, get_router_metrics, reset_router_metrics, record_router_feedback
)
from agents.skill_runner import init_skill_registry

# ─── Lifespan ─────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await init_memory_db()
    init_cortex_workspace()
    await init_environments_db()
    await init_checkpoints_db()
    await init_connectors_db()
    await init_skill_registry()
    await initialize_plugins(app)
    persisted = await get_preference("agent_settings", None)
    if isinstance(persisted, dict):
        _agent_settings.update(persisted)
    yield

app = FastAPI(
    title="Cortex",
    description="Local AI Coding Agent API",
    version="5.0.0",
    lifespan=lifespan,
)

app.include_router(cortex_config_router)
app.include_router(environments_router)
app.include_router(plugins_router)
app.include_router(skills_router)
app.include_router(hardware_router)
app.include_router(checkpoints_router)
app.include_router(connectors_router)

@app.middleware("http")
async def request_observability(request: Request, call_next):
    """Attach request IDs and timing headers for local observability."""
    req_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    start = time.time()
    response = await call_next(request)
    response.headers["x-request-id"] = req_id
    response.headers["x-process-time-ms"] = str(int((time.time() - start) * 1000))
    return response

# ─── CORS ─────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Request Models ──────────────────────────────────────────────
class BuildRequest(BaseModel):
    task: str
    project_path: str
    self_heal: bool = False

class ChatRequest(BaseModel):
    task: str
    mode: str = "auto"
    session_id: Optional[str] = None
    attachments: Optional[list] = None
    approved_actions: bool = False
    latency_budget_ms: Optional[int] = None
    quality_tier: str = "balanced"

class AiderRequest(BaseModel):
    instruction: str
    project_path: str
    approved_actions: bool = False

class RecommendRequest(BaseModel):
    vram_gb: float
    ram_gb: float
    priority: str = "balanced"

class RouterUpdateRequest(BaseModel):
    router: dict

class OpenAIChatRequest(BaseModel):
    model: Optional[str] = None
    messages: list
    stream: bool = True
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None

class PinRequest(BaseModel):
    pinned: bool

class AgentSettingsRequest(BaseModel):
    auto_approve: str = "ask"  # always_ask / always_proceed / ask_new_only
    max_files: int = 50
    max_retries: int = 1
    self_heal_count: int = 3
    review_on_build: bool = False
    test_on_build: bool = False
    context_limit: int = 32768
    local_only: bool = False
    protected_paths: List[str] = Field(default_factory=list)

class FeedbackRequest(BaseModel):
    message_id: str
    feedback: str  # 'up' or 'down'

class ToolConfigRequest(BaseModel):
    tools: list

class IndexRequest(BaseModel):
    project_path: str

class ProjectSearchRequest(BaseModel):
    project_path: str
    query: str
    limit: int = 5

class RagContextRequest(BaseModel):
    project_path: str
    query: str
    limit: int = 8
    snippet_chars: int = 360

class ConfigToolsRequest(BaseModel):
    tools: List[Dict[str, Any]] = Field(..., description="List of tool configurations")

class FileWriteRequest(BaseModel):
    path: str
    content: str

class GitCommitRequest(BaseModel):
    path: str
    message: str
    commit_all: bool = True

class GitPathRequest(BaseModel):
    path: str

class GitFileActionRequest(BaseModel):
    path: str
    file_path: str

class GitRefRequest(BaseModel):
    path: str
    ref: str

class PreferenceUpdateRequest(BaseModel):
    key: str
    value: Any

class QueueTaskRequest(BaseModel):
    task: str
    mode: str = "chat"
    project_path: Optional[str] = None

# ─── In-Memory Stores ────────────────────────────────────────────
_agent_settings = {
    "auto_approve": "ask",
    "max_files": 50,
    "max_retries": 1,
    "self_heal_count": 3,
    "review_on_build": False,
    "test_on_build": False,
    "context_limit": 32768,
    "local_only": False,
    "protected_paths": [],
}
_notifications: list = []
_task_queue: list = []
_rag_index_jobs: Dict[str, Dict[str, Any]] = {}

# ─── SSE Helper ──────────────────────────────────────────────────
def sse_format(event_type: str, data: dict) -> str:
    return f"data: {json.dumps({'type': event_type, **data})}\n\n"

# ─── Health & Status Routes ──────────────────────────────────────
@app.get("/")
async def root():
    """Root — server info, Ollama status, endpoint map."""
    ollama = await check_ollama_health()
    return {
        "name": "Cortex",
        "version": "5.0.0",
        "status": "running",
        "ollama": ollama,
        "endpoints": {
            "health": "/health",
            "status": "/status",
            "build": "/agent/build",
            "chat": "/agent/chat",
            "aider": "/agent/aider",
            "sessions": "/sessions",
            "upload": "/files/upload",
            "config": "/config/router",
            "recommend": "/system/recommend",
            "openai": "/v1/chat/completions",
            "models": "/v1/models",
            "templates": "/templates",
            "connectors": "/connectors",
            "rag_context": "/rag/context",
            "git_visualizer": "/git/visualizer",
        }
    }

@app.get("/health")
async def health():
    """Full health check: Ollama connection, model list, active sessions."""
    ollama = await check_ollama_health()
    models = await fetch_ollama_models()
    sessions = await list_sessions()
    return {
        "status": "healthy" if ollama.get("status") == "connected" else "degraded",
        "ollama": ollama,
        "installed_models": [m.get("name") for m in models],
        "model_count": len(models),
        "active_sessions": len(sessions),
        "router": MODEL_ROUTER,
    }

@app.get("/health/contracts")
async def health_contracts():
    """Contract-level capability check used by frontend diagnostics."""
    return {
        "status": "ok",
        "contracts": {
            "files_tree_shape": {"path": "string", "tree": "array", "files": "array"},
            "sessions_shape": {"sessions": "array"},
            "pinned_shape": {"pinned": "array"},
            "notifications_shape": {"notifications": "array"},
        },
    }

@app.get("/health/features")
async def health_features():
    """Runtime feature readiness checks."""
    memory_ok = False
    try:
        conn = sqlite3.connect(os.path.join(os.path.dirname(__file__), "mission_control.db"))
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='memory'")
        memory_ok = cur.fetchone() is not None
        conn.close()
    except Exception:
        memory_ok = False

    return {
        "status": "ok",
        "features": {
            "memory": memory_ok,
            "web_search": True,
            "git": shutil.which("git") is not None,
            "local_only": _agent_settings.get("local_only", False),
            "queue": True,
            "preferences": True,
            "ollama_connected": (await check_ollama_health()).get("status") == "connected",
        },
    }

@app.get("/status")
async def status():
    """Session summaries + last 50 log events."""
    sessions = await list_sessions()
    return {
        "sessions": sessions[:50],
        "session_count": len(sessions),
        "router": MODEL_ROUTER,
        "uptime": time.time(),
    }


@app.get("/router/metrics")
async def router_metrics():
    return {"metrics": get_router_metrics()}


@app.post("/router/metrics/reset")
async def router_metrics_reset():
    return {"metrics": reset_router_metrics()}

# ─── Agent Endpoints ─────────────────────────────────────────────
@app.post("/agent/build")
async def agent_build(req: BuildRequest):
    """Full build pipeline. Streams SSE events."""
    session = await create_session("build", req.task[:100], req.project_path)
    session_id = session["id"]
    push_notification("Build Started", f"Building: {req.task[:60]}...", "info")

    async def event_stream():
        yield sse_format("session", {"session_id": session_id})
        file_count = 0
        async for event in run_build(req.task, req.project_path, session_id, req.self_heal):
            evt_data = event["data"]
            # Propagate planned_files from architect_done to frontend
            if event["type"] == "log" and evt_data.get("phase") == "architect_done":
                plan = evt_data.get("plan", {})
                planned = len(plan.get("files", []))
                evt_data["planned_files"] = planned
            if event["type"] == "file_created":
                file_count += 1
            if event["type"] == "log" and evt_data.get("phase") == "complete":
                push_notification("Build Complete", f"{file_count} files generated", "success")
            yield sse_format(event["type"], evt_data)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Session-Id": session_id,
        }
    )

@app.post("/agent/chat")
async def agent_chat(req: ChatRequest):
    """Chat with role routing + image support."""
    session_id = req.session_id
    if not session_id:
        session = await create_session("chat", req.task[:100])
        session_id = session["id"]

    async def event_stream():
        yield sse_format("session", {"session_id": session_id})
        async for event in run_chat(
            req.task,
            req.mode,
            session_id,
            req.attachments,
            _agent_settings.get("local_only", False),
            req.approved_actions or (_agent_settings.get("auto_approve") == "always_proceed"),
            req.latency_budget_ms,
            req.quality_tier,
        ):
            yield sse_format(event["type"], event["data"])

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Session-Id": session_id,
        }
    )

@app.post("/agent/aider")
async def agent_aider(req: AiderRequest):
    """Bulk refactor via aider CLI. Streams."""
    session = await create_session("refactor", req.instruction[:100], req.project_path)
    session_id = session["id"]

    async def event_stream():
        auto_approved = req.approved_actions or (_agent_settings.get("auto_approve") == "always_proceed")
        async for event in run_aider(req.instruction, req.project_path, session_id, auto_approved):
            yield sse_format(event["type"], event["data"])

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
    )

# ─── OpenAI Compatible API ───────────────────────────────────────
@app.get("/v1")
async def v1_info():
    """OpenAI-compat info: base_url, api_key hint."""
    return {
        "base_url": "http://localhost:8000/v1",
        "api_key": "local",
        "note": "Any API key string works. This is a local server.",
        "endpoints": ["/v1/models", "/v1/chat/completions"],
    }

@app.get("/v1/models")
async def v1_models():
    """OpenAI-compatible model list from Ollama."""
    models = await fetch_ollama_models()
    return {
        "object": "list",
        "data": [
            {
                "id": m.get("name", ""),
                "object": "model",
                "owned_by": "ollama-local",
                "permission": [],
            }
            for m in models
        ]
    }


@app.get("/models/catalog")
async def unified_models_catalog():
    """Unified model catalog scaffold: local + cloud + OpenRouter (if configured)."""
    models = await fetch_unified_models()
    return {"models": models, "count": len(models)}

@app.post("/v1/chat/completions")
async def v1_chat_completions(req: OpenAIChatRequest):
    """OpenAI-compat. Use as Cline/Antigravity provider backend."""
    if req.stream:
        async def stream():
            async for chunk in openai_chat_completion(req.messages, req.model, stream=True):
                yield f"data: {chunk}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache"},
        )
    else:
        result = None
        async for chunk in openai_chat_completion(req.messages, req.model, stream=False):
            result = json.loads(chunk)
        return JSONResponse(result)

# ─── File & Config Endpoints ─────────────────────────────────────
@app.post("/files/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload file. Returns metadata + content for context injection."""
    content = await file.read()
    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    is_image = mime.startswith("image/")
    
    result = {
        "name": file.filename,
        "mime": mime,
        "is_image": is_image,
        "size": len(content),
    }

    if is_image:
        result["data"] = base64.b64encode(content).decode('utf-8')
    else:
        try:
            result["content"] = content.decode('utf-8')
        except UnicodeDecodeError:
            result["data"] = base64.b64encode(content).decode('utf-8')

    return result

@app.post("/system/recommend")
async def system_recommend(req: RecommendRequest):
    """Real model recommendations from Ollama sizes."""
    return await recommend_models(req.vram_gb, req.ram_gb, req.priority)

@app.get("/config/router")
async def get_router():
    """Returns current MODEL_ROUTER mapping."""
    return {"router": MODEL_ROUTER}

@app.post("/config/router")
async def set_router(req: RouterUpdateRequest):
    """Live model routing update, no restart needed."""
    updated = update_router(req.router)
    return {"router": updated, "message": "Router updated successfully"}

# ─── Session Endpoints ───────────────────────────────────────────
@app.get("/sessions")
async def list_sess():
    """List all sessions by recency (updated_at)."""
    return {"sessions": await list_sessions()}

@app.get("/sessions/pinned")
async def get_pinned():
    """Get list of pinned session IDs."""
    return {"pinned": await list_pinned_sessions()}

@app.post("/project/index")
async def project_index_endpoint(req: IndexRequest, background_tasks: BackgroundTasks):
    """Recursively index a project directory for RAG."""
    project_root = os.path.abspath(req.project_path)
    if not os.path.isdir(project_root):
        raise HTTPException(status_code=404, detail="Project path not found")

    existing = _rag_index_jobs.get(project_root, {})
    if existing.get("status") == "in_progress":
        return {
            "status": "already_running",
            "path": project_root,
            "progress_percent": existing.get("progress_percent", 0.0),
            "eta_seconds": existing.get("eta_seconds"),
        }

    _rag_index_jobs[project_root] = {
        "status": "queued",
        "project_path": project_root,
        "started_at": time.time(),
        "finished_at": None,
        "total_candidates": 0,
        "processed_candidates": 0,
        "indexed_files": 0,
        "skipped_files": 0,
        "progress_percent": 0.0,
        "elapsed_seconds": 0.0,
        "eta_seconds": None,
        "message": "Queued for indexing",
    }

    background_tasks.add_task(reindex_project_task, project_root)
    return {
        "status": "indexing_started",
        "path": project_root,
        "progress_percent": 0.0,
    }

@app.post("/project/search")
async def project_search_endpoint(req: ProjectSearchRequest):
    """Search the project index for code snippets."""
    results = await search_project_context(req.project_path, req.query, req.limit)
    return {"results": results}


def _rag_snippet(content: str, query: str, max_chars: int) -> str:
    text = str(content or "")
    if not text:
        return ""
    q = str(query or "").strip().lower()
    if not q:
        return text[:max_chars]

    tokens = [t for t in re.findall(r"[A-Za-z0-9_]+", q) if len(t) > 1][:12]
    if not tokens:
        return text[:max_chars]

    lines = text.splitlines()
    if not lines:
        return text[:max_chars]

    scored: List[tuple[float, int]] = []
    for idx, line in enumerate(lines):
        lower = line.lower()
        score = 0.0
        for token in tokens:
            count = lower.count(token)
            if count > 0:
                score += 1.0 + min(count, 5) * 0.2
        if score > 0:
            scored.append((score, idx))

    if not scored:
        return text[:max_chars]

    scored.sort(key=lambda x: x[0], reverse=True)
    best_idx = scored[0][1]
    start_idx = max(0, best_idx - 2)
    end_idx = min(len(lines), best_idx + 3)
    snippet = "\n".join(lines[start_idx:end_idx])

    if len(snippet) > max_chars:
        snippet = snippet[:max_chars]
    if start_idx > 0:
        snippet = "...\n" + snippet
    if end_idx < len(lines):
        snippet = snippet + "\n..."
    return snippet


def _rag_score(content: str, query: str, path: str = "") -> float:
    text = str(content or "").lower()
    path_l = str(path or "").lower()
    tokens = [t for t in re.findall(r"[a-zA-Z0-9_]+", str(query or "").lower()) if len(t) > 1]
    if not text or not tokens:
        return 0.0
    score = 0.0
    for token in tokens:
        occurrences = text.count(token)
        if occurrences > 0:
            score += 1.0 + min(occurrences, 8) * 0.2
        if token in path_l:
            score += 0.8
    return round(score, 3)


def _rag_eta_seconds(processed: int, total: int, elapsed: float) -> Optional[float]:
    if processed <= 0 or total <= 0:
        return None
    remaining = max(total - processed, 0)
    if remaining == 0:
        return 0.0
    rate = processed / max(elapsed, 0.001)
    if rate <= 0:
        return None
    return round(remaining / rate, 1)


def _rag_job_progress(processed: int, total: int) -> float:
    if total <= 0:
        return 0.0
    return round(min(max((processed / total) * 100.0, 0.0), 100.0), 2)


@app.post("/rag/index")
async def rag_index_endpoint(req: IndexRequest, background_tasks: BackgroundTasks):
    """Start background indexing for the RAG context engine."""
    project_root = os.path.abspath(req.project_path)
    if not os.path.isdir(project_root):
        raise HTTPException(status_code=404, detail="Project path not found")

    existing = _rag_index_jobs.get(project_root, {})
    if existing.get("status") == "in_progress":
        return {
            "status": "already_running",
            "engine": "project_index",
            "project_path": project_root,
            "progress_percent": existing.get("progress_percent", 0.0),
            "eta_seconds": existing.get("eta_seconds"),
        }

    _rag_index_jobs[project_root] = {
        "status": "queued",
        "project_path": project_root,
        "started_at": time.time(),
        "finished_at": None,
        "total_candidates": 0,
        "processed_candidates": 0,
        "indexed_files": 0,
        "skipped_files": 0,
        "progress_percent": 0.0,
        "elapsed_seconds": 0.0,
        "eta_seconds": None,
        "message": "Queued for indexing",
    }

    background_tasks.add_task(reindex_project_task, project_root)
    return {
        "status": "indexing_started",
        "engine": "project_index",
        "project_path": project_root,
        "progress_percent": 0.0,
    }


@app.get("/rag/status")
async def rag_status_endpoint(project_path: str):
    """Return index coverage details for a project root."""
    project_root = os.path.abspath(project_path)
    if not os.path.isdir(project_root):
        raise HTTPException(status_code=404, detail="Project path not found")

    indexed_files = 0
    try:
        conn = sqlite3.connect(DB_PATH)
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM project_index WHERE project_root = ?", (project_root,))
        row = cur.fetchone()
        indexed_files = int(row[0]) if row and row[0] is not None else 0
        conn.close()
    except Exception:
        indexed_files = 0

    job = _rag_index_jobs.get(project_root, {})
    processed = int(job.get("processed_candidates", 0))
    total = int(job.get("total_candidates", 0))
    status = str(job.get("status", "idle"))
    progress_percent = float(job.get("progress_percent", _rag_job_progress(processed, total)))
    elapsed_seconds = float(job.get("elapsed_seconds", 0.0))
    eta_seconds = job.get("eta_seconds")
    finished_at = job.get("finished_at")

    if status == "idle" and indexed_files > 0:
        progress_percent = 100.0

    return {
        "engine": "fts5",
        "project_path": project_root,
        "status": status,
        "indexed_files": indexed_files,
        "total_candidates": total,
        "processed_candidates": processed,
        "skipped_files": int(job.get("skipped_files", 0)),
        "progress_percent": progress_percent,
        "elapsed_seconds": elapsed_seconds,
        "eta_seconds": eta_seconds,
        "is_indexing": status in {"queued", "in_progress"},
        "started_at": job.get("started_at"),
        "finished_at": finished_at,
        "message": job.get("message", ""),
    }


@app.post("/rag/context")
async def rag_context_endpoint(req: RagContextRequest):
    """Retrieve ranked context snippets from the local project index."""
    project_root = os.path.abspath(req.project_path)
    if not os.path.isdir(project_root):
        raise HTTPException(status_code=404, detail="Project path not found")

    query = (req.query or "").strip()
    if not query:
        raise HTTPException(status_code=400, detail="Query is required")

    limit = max(1, min(int(req.limit or 8), 30))
    snippet_chars = max(120, min(int(req.snippet_chars or 360), 1200))

    raw = await search_project_context(project_root, query, max(limit * 2, limit))
    ranked = []
    for item in raw:
        path = item.get("path", "")
        content = item.get("content", "")
        ranked.append({
            "path": path,
            "score": _rag_score(content, query, path),
            "snippet": _rag_snippet(content, query, snippet_chars),
            "bytes": len(content.encode("utf-8", errors="ignore")),
        })

    ranked.sort(key=lambda r: r.get("score", 0), reverse=True)
    results = ranked[:limit]

    return {
        "engine": "fts5+heuristic-rank",
        "project_path": project_root,
        "query": query,
        "count": len(results),
        "results": results,
    }

@app.post("/configure/tools")
async def configure_tools_endpoint(req: ConfigToolsRequest):
    """Persistent tool configuration for the agent."""
    # Future Scope: Store in DB. For now, just a stub.
    return {"status": "configured", "tools": req.tools}

async def reindex_project_task(project_path: str):
    """Background task to walk and index a project."""
    project_root = os.path.abspath(project_path)
    ignore_dirs = {'.git', 'node_modules', '__pycache__', 'dist', 'build', '.next', '.venv', 'venv'}
    ignore_exts = {
        '.exe', '.dll', '.so', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.pdf', '.docx',
        '.mp4', '.mov', '.webm', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.bin'
    }
    max_file_bytes = 500 * 1024

    started_at = time.time()

    try:
        candidates: List[str] = []
        for root, dirs, files in os.walk(project_root):
            dirs[:] = [d for d in dirs if d not in ignore_dirs]
            for name in files:
                ext = os.path.splitext(name)[1].lower()
                if ext in ignore_exts:
                    continue
                candidates.append(os.path.join(root, name))

        _rag_index_jobs[project_root] = {
            "status": "in_progress",
            "project_path": project_root,
            "started_at": started_at,
            "finished_at": None,
            "total_candidates": len(candidates),
            "processed_candidates": 0,
            "indexed_files": 0,
            "skipped_files": 0,
            "progress_percent": 0.0,
            "elapsed_seconds": 0.0,
            "eta_seconds": None,
            "message": "Indexing files",
        }

        await clear_project_index(project_root)

        file_count = 0
        skipped = 0
        for idx, full_path in enumerate(candidates, start=1):
            try:
                if os.path.getsize(full_path) > max_file_bytes:
                    skipped += 1
                else:
                    with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
                        content = f.read()
                    await index_project_file(project_root, full_path, content)
                    file_count += 1
            except Exception:
                skipped += 1

            elapsed = round(time.time() - started_at, 2)
            _rag_index_jobs[project_root].update({
                "processed_candidates": idx,
                "indexed_files": file_count,
                "skipped_files": skipped,
                "progress_percent": _rag_job_progress(idx, len(candidates)),
                "elapsed_seconds": elapsed,
                "eta_seconds": _rag_eta_seconds(idx, len(candidates), elapsed),
            })

        elapsed = round(time.time() - started_at, 2)
        _rag_index_jobs[project_root].update({
            "status": "complete",
            "finished_at": time.time(),
            "indexed_files": file_count,
            "skipped_files": skipped,
            "processed_candidates": len(candidates),
            "progress_percent": 100.0,
            "elapsed_seconds": elapsed,
            "eta_seconds": 0.0,
            "message": f"Index complete: {file_count} files",
        })
        print(f"Index complete: {file_count} files for {project_root}")
    except Exception as exc:
        elapsed = round(time.time() - started_at, 2)
        failed_state = _rag_index_jobs.get(project_root, {})
        failed_state.update({
            "status": "error",
            "finished_at": time.time(),
            "elapsed_seconds": elapsed,
            "eta_seconds": None,
            "message": str(exc),
        })
        _rag_index_jobs[project_root] = failed_state

@app.get("/sessions/search")
async def sess_search(q: str):
    """Search sessions by full-text search on content."""
    if not q:
        return {"sessions": []}
    return {"sessions": await search_sessions(q)}

@app.get("/sessions/{session_id}")
async def get_sess(session_id: str):
    """Full session including complete event history for replay."""
    session = await get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session

@app.delete("/sessions/{session_id}")
async def delete_session_endpoint(session_id: str):
    """Delete a specific session."""
    deleted = await delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"message": "Session deleted"}

@app.delete("/sessions")
async def clear_sessions():
    """Clear all sessions."""
    count = await clear_all_sessions()
    return {"message": f"Cleared {count} sessions"}

# ─── Session Pin ─────────────────────────────────────────────────
@app.post("/sessions/{session_id}/pin")
async def pin_session(session_id: str, req: PinRequest):
    """Pin or unpin a session."""
    updated = await set_session_pinned(session_id, req.pinned)
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"session_id": session_id, "pinned": req.pinned}

# ─── File Explorer ───────────────────────────────────────────────
@app.get("/files/tree")
async def file_tree(path: str, depth: int = 3):
    """Get file tree for a project directory (real filesystem)."""
    if not os.path.isdir(path):
        raise HTTPException(status_code=404, detail=f"Directory not found: {path}")

    def scan_dir(dir_path: str, current_depth: int) -> list:
        if current_depth > depth:
            return []
        items = []
        try:
            for entry in sorted(os.scandir(dir_path), key=lambda e: (not e.is_dir(), e.name.lower())):
                if entry.name.startswith('.') and entry.name not in ('.env', '.gitignore', '.eslintrc'):
                    continue
                if entry.name in ('node_modules', '__pycache__', '.next', '.git', 'venv', '.venv'):
                    continue
                item = {
                    "name": entry.name,
                    "path": entry.path.replace("\\", "/"),
                    "is_dir": entry.is_dir(),
                }
                if entry.is_file():
                    try:
                        stat = entry.stat()
                        item["size"] = stat.st_size
                        item["modified"] = stat.st_mtime
                    except OSError:
                        item["size"] = 0
                if entry.is_dir() and current_depth < depth:
                    item["children"] = scan_dir(entry.path, current_depth + 1)
                items.append(item)
        except PermissionError:
            pass
        return items

    tree = scan_dir(path, 1)
    # Include both keys for backward compatibility.
    return {"path": path, "tree": tree, "files": tree}

@app.get("/files/read")
async def read_file(path: str):
    """Read a file's content (for preview panel)."""
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="File not found")
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read(100000)  # Cap at 100KB
        return {"path": path, "content": content, "size": os.path.getsize(path)}
    except UnicodeDecodeError:
        return {"path": path, "content": "[Binary file]", "size": os.path.getsize(path), "binary": True}

@app.post("/files/write")
async def write_file(req: FileWriteRequest):
    """Write file content to disk with basic path-safety checks."""
    if not req.path:
        raise HTTPException(status_code=400, detail="Path is required")
    safe_path = os.path.abspath(req.path)
    # Disallow writing directly into Python/site-packages or Windows directories.
    lowered = safe_path.lower()
    if "site-packages" in lowered or lowered.startswith("c:\\windows"):
        raise HTTPException(status_code=400, detail="Unsafe write path")
    protected_paths = _agent_settings.get("protected_paths", [])
    for p in protected_paths:
        if p and lowered.startswith(os.path.abspath(p).lower()):
            raise HTTPException(status_code=403, detail=f"Path is protected by policy: {p}")

    os.makedirs(os.path.dirname(safe_path), exist_ok=True)
    with open(safe_path, "w", encoding="utf-8") as f:
        f.write(req.content)
    return {"path": safe_path, "written": True, "size": os.path.getsize(safe_path)}

# ─── Agent Settings ──────────────────────────────────────────────
@app.get("/settings/agent")
async def get_agent_settings():
    """Get current agent behaviour settings."""
    return _agent_settings

@app.post("/settings/agent")
async def update_agent_settings(req: AgentSettingsRequest):
    """Update agent behaviour settings."""
    global _agent_settings
    _agent_settings = req.model_dump()
    await set_preference("agent_settings", _agent_settings)
    return _agent_settings

@app.post("/settings/tools")
async def update_tool_config(req: ToolConfigRequest):
    """Configure which tools the agent can access"""
    _agent_settings["enabled_tools"] = req.tools
    await set_preference("enabled_tools", req.tools)
    return {"status": "success", "tools_configured": len(req.tools)}

@app.get("/settings/preferences")
async def get_preferences():
    """Return all persisted preferences."""
    return {"preferences": await list_preferences()}

@app.post("/settings/preferences")
async def set_preferences(req: PreferenceUpdateRequest):
    """Persist a preference value."""
    await set_preference(req.key, req.value)
    return {"status": "ok", "key": req.key}

@app.get("/tools/registry")
async def tools_registry():
    """Discover available tool capabilities and current enablement."""
    available = [
        {"key": "web_search", "name": "Web Search", "enabled": True},
        {"key": "rag_index", "name": "Project Index", "enabled": True},
        {"key": "code_review", "name": "Code Review", "enabled": True},
        {"key": "git_ops", "name": "Git Operations", "enabled": True},
    ]
    configured = _agent_settings.get("enabled_tools", [])
    if isinstance(configured, list) and configured:
        keys = {t if isinstance(t, str) else t.get("key") for t in configured}
        for tool in available:
            tool["enabled"] = tool["key"] in keys
    return {"tools": available}

@app.get("/queue")
async def queue_list():
    """List queued tasks."""
    return {"tasks": _task_queue}

@app.post("/queue")
async def queue_add(req: QueueTaskRequest):
    """Add a task to the background queue."""
    task_id = str(uuid.uuid4())
    entry = {
        "id": task_id,
        "task": req.task,
        "mode": req.mode,
        "project_path": req.project_path,
        "status": "pending",
        "created_at": time.time(),
    }
    _task_queue.append(entry)
    return {"status": "queued", "task": entry}

@app.delete("/queue/{task_id}")
async def queue_delete(task_id: str):
    """Delete/cancel a pending queued task."""
    global _task_queue
    before = len(_task_queue)
    _task_queue = [t for t in _task_queue if t.get("id") != task_id]
    if len(_task_queue) == before:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"status": "deleted", "task_id": task_id}

@app.get("/git/status")
async def git_status(path: str):
    """Return git status details for the given repository path."""
    repo_path = os.path.abspath(path)
    if not os.path.isdir(repo_path):
        raise HTTPException(status_code=404, detail="Path not found")
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")

    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    ).stdout.strip()

    repo_root_proc = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    )
    repo_root = repo_root_proc.stdout.strip() or repo_path

    upstream_proc = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    )
    upstream = upstream_proc.stdout.strip() if upstream_proc.returncode == 0 else None

    ahead = 0
    behind = 0
    if upstream:
        ahead_behind_proc = subprocess.run(
            ["git", "rev-list", "--left-right", "--count", f"HEAD...{upstream}"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if ahead_behind_proc.returncode == 0:
            parts = ahead_behind_proc.stdout.strip().split()
            if len(parts) == 2:
                try:
                    ahead = int(parts[0])
                    behind = int(parts[1])
                except ValueError:
                    ahead = 0
                    behind = 0

    raw = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    ).stdout.splitlines()

    staged = []
    modified = []
    untracked = []
    conflicts = []
    changes = []

    conflict_pairs = {
        ("D", "D"),
        ("A", "U"),
        ("U", "D"),
        ("U", "A"),
        ("D", "U"),
        ("A", "A"),
        ("U", "U"),
    }

    def status_bucket(x: str, y: str) -> str:
        if x == "?" and y == "?":
            return "untracked"
        if (x, y) in conflict_pairs or x == "U" or y == "U":
            return "conflict"
        if x != " " and y != " ":
            return "staged+modified"
        if x != " ":
            return "staged"
        if y != " ":
            return "modified"
        return "clean"

    for line in raw:
        if len(line) < 4:
            continue
        x = line[0]
        y = line[1]
        p = line[3:]
        if " -> " in p:
            p = p.split(" -> ", 1)[1]
        bucket = status_bucket(x, y)
        changes.append({
            "path": p,
            "staged_status": x,
            "unstaged_status": y,
            "status": bucket,
        })
        if x not in (" ", "?"):
            staged.append(p)
        if y not in (" ", "?"):
            modified.append(p)
        if x == "?" and y == "?":
            untracked.append(p)
        if (x, y) in conflict_pairs or x == "U" or y == "U":
            conflicts.append(p)

    commit_graph_raw = subprocess.run(
        [
            "git",
            "log",
            "--graph",
            "--date=relative",
            "--pretty=format:%h%x1f%an%x1f%ar%x1f%s%x1f%D%x1f%P",
            "-n",
            "80",
        ],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    ).stdout.splitlines()

    graph_commit_re = re.compile(r"[0-9a-f]{7,40}\x1f")
    recent_commits = []
    for c in commit_graph_raw:
        if not c.strip():
            continue
        match = graph_commit_re.search(c)
        if not match:
            continue

        graph_prefix = c[: match.start()].rstrip("\n")
        payload = c[match.start() :]
        parts = payload.split("\x1f")
        if len(parts) < 6:
            continue
        commit_hash, author, rel_date, msg, refs, parents = parts[:6]
        parent_list = [p for p in parents.split() if p]
        recent_commits.append({
            "hash": commit_hash,
            "msg": msg,
            "date": rel_date,
            "author": author,
            "refs": refs,
            "parents": parent_list,
            "is_merge": len(parent_list) > 1,
            "graph": graph_prefix,
        })

    local_branches_raw = subprocess.run(
        ["git", "for-each-ref", "--format=%(refname:short)", "refs/heads"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    ).stdout.splitlines()
    local_branches = [b.strip() for b in local_branches_raw if b.strip()]

    remote_branches_raw = subprocess.run(
        ["git", "for-each-ref", "--format=%(refname:short)", "refs/remotes"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    ).stdout.splitlines()
    remote_branches = [
        b.strip()
        for b in remote_branches_raw
        if b.strip() and not b.strip().endswith("/HEAD")
    ]

    return {
        "branch": branch,
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "detached": branch == "HEAD",
        "repo_root": repo_root,
        "local_branches": local_branches,
        "remote_branches": remote_branches,
        "modified": modified,
        "staged": staged,
        "untracked": untracked,
        "conflicts": conflicts,
        "changes": changes,
        "counts": {
            "staged": len(staged),
            "modified": len(modified),
            "untracked": len(untracked),
            "conflicts": len(conflicts),
            "total": len(changes),
        },
        "recent_commits": recent_commits,
        "last_updated": time.time(),
    }


@app.get("/git/visualizer")
async def git_visualizer(path: str, limit: int = 120):
    """Return lane-friendly commit data for frontend git graph visualization."""
    repo_path = os.path.abspath(path)
    if not os.path.isdir(repo_path):
        raise HTTPException(status_code=404, detail="Path not found")
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")

    safe_limit = max(20, min(limit, 300))
    branch = subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    ).stdout.strip()

    rows = subprocess.run(
        [
            "git",
            "log",
            "--graph",
            "--date=relative",
            "--pretty=format:%h%x1f%an%x1f%ar%x1f%s%x1f%D%x1f%P",
            "-n",
            str(safe_limit),
        ],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=15,
    ).stdout.splitlines()

    commit_re = re.compile(r"[0-9a-f]{7,40}\x1f")
    nodes = []
    max_lane = 0
    for row in rows:
        if not row.strip():
            continue
        match = commit_re.search(row)
        if not match:
            continue

        graph_prefix = row[: match.start()]
        payload = row[match.start() :]
        parts = payload.split("\x1f")
        if len(parts) < 6:
            continue

        commit_hash, author, rel_date, msg, refs, parents = parts[:6]
        star_idx = graph_prefix.find("*")
        lane = max(0, star_idx // 2) if star_idx >= 0 else 0
        max_lane = max(max_lane, lane)
        refs_list = [r.strip() for r in refs.replace("(", "").replace(")", "").split(",") if r.strip()]
        parent_list = [p for p in parents.split() if p]

        nodes.append({
            "hash": commit_hash,
            "author": author,
            "date": rel_date,
            "message": msg,
            "lane": lane,
            "refs": refs_list,
            "is_head": any("HEAD ->" in r for r in refs_list),
            "is_merge": len(parent_list) > 1,
            "parents": parent_list,
            "graph": graph_prefix.rstrip("\n"),
        })

    return {
        "branch": branch,
        "repo_path": repo_path,
        "lanes": max_lane + 1 if nodes else 1,
        "count": len(nodes),
        "nodes": nodes,
        "generated_at": time.time(),
    }


@app.post("/git/stage")
async def git_stage(req: GitFileActionRequest):
    """Stage a single file path."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")
    file_path = (req.file_path or "").strip()
    if not file_path:
        raise HTTPException(status_code=400, detail="file_path is required")

    proc = subprocess.run(
        ["git", "add", "--", file_path],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=proc.stderr or proc.stdout or "git add failed")
    return {"status": "staged", "file_path": file_path}


@app.post("/git/stage-all")
async def git_stage_all(req: GitPathRequest):
    """Stage all changes in repository."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")

    proc = subprocess.run(
        ["git", "add", "-A"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=proc.stderr or proc.stdout or "git add -A failed")
    return {"status": "staged_all"}


@app.post("/git/unstage")
async def git_unstage(req: GitFileActionRequest):
    """Unstage a single file path."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")
    file_path = (req.file_path or "").strip()
    if not file_path:
        raise HTTPException(status_code=400, detail="file_path is required")

    proc = subprocess.run(
        ["git", "restore", "--staged", "--", file_path],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if proc.returncode != 0:
        fallback = subprocess.run(
            ["git", "reset", "HEAD", "--", file_path],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=20,
        )
        if fallback.returncode != 0:
            raise HTTPException(status_code=400, detail=fallback.stderr or fallback.stdout or proc.stderr or proc.stdout or "git unstage failed")
    return {"status": "unstaged", "file_path": file_path}


@app.post("/git/unstage-all")
async def git_unstage_all(req: GitPathRequest):
    """Unstage all currently staged files."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")

    proc = subprocess.run(
        ["git", "reset"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=proc.stderr or proc.stdout or "git reset failed")
    return {"status": "unstaged_all"}


@app.post("/git/discard")
async def git_discard(req: GitFileActionRequest):
    """Discard local changes for a single file (or remove an untracked file)."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")
    file_path = (req.file_path or "").strip()
    if not file_path:
        raise HTTPException(status_code=400, detail="file_path is required")

    status_proc = subprocess.run(
        ["git", "status", "--porcelain", "--", file_path],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    )
    status_line = (status_proc.stdout or "").strip()

    if status_line.startswith("??"):
        proc = subprocess.run(
            ["git", "clean", "-f", "--", file_path],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=20,
        )
        if proc.returncode != 0:
            raise HTTPException(status_code=400, detail=proc.stderr or proc.stdout or "git clean failed")
    else:
        proc = subprocess.run(
            ["git", "restore", "--", file_path],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=20,
        )
        if proc.returncode != 0:
            raise HTTPException(status_code=400, detail=proc.stderr or proc.stdout or "git restore failed")
    return {"status": "discarded", "file_path": file_path}


@app.post("/git/checkout")
async def git_checkout(req: GitRefRequest):
    """Checkout a branch or ref."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")
    ref = (req.ref or "").strip()
    if not ref:
        raise HTTPException(status_code=400, detail="ref is required")

    proc = subprocess.run(
        ["git", "checkout", ref],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=proc.stderr or proc.stdout or "git checkout failed")
    return {"status": "checked_out", "ref": ref}


@app.post("/git/pull")
async def git_pull(req: GitPathRequest):
    """Pull remote changes (fast-forward only)."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")

    proc = subprocess.run(
        ["git", "pull", "--ff-only"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=40,
    )
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=proc.stderr or proc.stdout or "git pull failed")
    return {"status": "pulled", "output": (proc.stdout or "").strip()}


@app.post("/git/push")
async def git_push(req: GitPathRequest):
    """Push local commits to upstream."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")

    proc = subprocess.run(
        ["git", "push"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=40,
    )
    if proc.returncode != 0:
        raise HTTPException(status_code=400, detail=proc.stderr or proc.stdout or "git push failed")
    return {"status": "pushed", "output": (proc.stdout or "").strip()}

@app.post("/git/commit")
async def git_commit(req: GitCommitRequest):
    """Commit currently staged changes."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Commit message is required")

    if req.commit_all:
        add_proc = subprocess.run(
            ["git", "add", "-A"],
            cwd=repo_path,
            capture_output=True,
            text=True,
            timeout=20,
        )
        if add_proc.returncode != 0:
            raise HTTPException(status_code=500, detail=add_proc.stderr or add_proc.stdout or "git add failed")

    has_staged_proc = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if has_staged_proc.returncode == 0:
        raise HTTPException(status_code=400, detail="No staged changes to commit")
    if has_staged_proc.returncode not in (0, 1):
        raise HTTPException(status_code=500, detail=has_staged_proc.stderr or has_staged_proc.stdout or "Unable to inspect staged changes")

    commit_proc = subprocess.run(
        ["git", "commit", "-m", req.message],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if commit_proc.returncode != 0:
        raise HTTPException(status_code=400, detail=commit_proc.stderr or commit_proc.stdout or "git commit failed")

    return {"status": "committed", "message": req.message, "commit_all": req.commit_all}

@app.post("/sessions/{session_id}/feedback")
async def submit_feedback(session_id: str, req: FeedbackRequest):
    """Store thumbs up/down feedback for a specific agent message"""
    if req.feedback in {"up", "down"}:
        record_router_feedback(req.feedback)
    await add_event(session_id, "feedback", {
        "message_id": req.message_id,
        "feedback": req.feedback,
    })
    return {"status": "success", "router_metrics": get_router_metrics()}

# ─── Notifications ───────────────────────────────────────────────
@app.get("/notifications")
async def get_notifications():
    """Get recent notifications."""
    return {"notifications": _notifications[-50:]}

@app.delete("/notifications")
async def clear_notifications():
    """Clear all notifications."""
    _notifications.clear()
    return {"message": "Cleared"}

def push_notification(title: str, body: str, level: str = "info"):
    """Internal: push a notification."""
    _notifications.append({
        "id": len(_notifications),
        "title": title,
        "body": body,
        "level": level,
        "timestamp": time.time(),
        "read": False,
    })

# ─── Template Endpoints ──────────────────────────────────────────
@app.get("/templates")
async def get_templates():
    """Get available project templates."""
    return {"templates": PROJECT_TEMPLATES}

# ─── Benchmark Endpoints ─────────────────────────────────────────
@app.get("/benchmarks")
async def get_benchmarks():
    """Get coding benchmark database."""
    return {"benchmarks": BENCHMARK_DB}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
