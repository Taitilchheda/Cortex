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
    set_session_pinned, list_pinned_sessions
)
from api.memory import init_memory_db
from config.models import (
    MODEL_ROUTER, get_model_for_role, update_router, 
    check_ollama_health, fetch_ollama_models, recommend_models,
    OLLAMA_BASE, BENCHMARK_DB
)
from agents.orchestrator import (
    run_build, run_chat, run_aider, openai_chat_completion, 
    PROJECT_TEMPLATES
)

# ─── Lifespan ─────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await init_memory_db()
    yield

app = FastAPI(
    title="Cortex",
    description="Local AI Coding Agent API",
    version="5.0.0",
    lifespan=lifespan,
)

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
    mode: str = "coder"
    session_id: Optional[str] = None
    attachments: Optional[list] = None

class AiderRequest(BaseModel):
    instruction: str
    project_path: str

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

class ConfigToolsRequest(BaseModel):
    tools: List[Dict[str, Any]] = Field(..., description="List of tool configurations")

class FileWriteRequest(BaseModel):
    path: str
    content: str

class GitCommitRequest(BaseModel):
    path: str
    message: str

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
}
_notifications: list = []

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
        async for event in run_aider(req.instruction, req.project_path, session_id):
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
    if not os.path.exists(req.project_path):
        raise HTTPException(status_code=404, detail="Project path not found")
    
    background_tasks.add_task(reindex_project_task, req.project_path)
    return {"status": "indexing_started", "path": req.project_path}

@app.post("/project/search")
async def project_search_endpoint(req: ProjectSearchRequest):
    """Search the project index for code snippets."""
    results = await search_project_context(req.project_path, req.query, req.limit)
    return {"results": results}

@app.post("/configure/tools")
async def configure_tools_endpoint(req: ConfigToolsRequest):
    """Persistent tool configuration for the agent."""
    # Future Scope: Store in DB. For now, just a stub.
    return {"status": "configured", "tools": req.tools}

async def reindex_project_task(project_path: str):
    """Background task to walk and index a project."""
    await clear_project_index(project_path)
    ignore_dirs = {'.git', 'node_modules', '__pycache__', 'dist', 'build', '.next'}
    ignore_exts = {'.exe', '.dll', '.so', '.png', '.jpg', '.jpeg', '.gif', '.zip', '.pdf', '.docx'}
    
    file_count = 0
    for root, dirs, files in os.walk(project_path):
        dirs[:] = [d for d in dirs if d not in ignore_dirs]
        for name in files:
            ext = os.path.splitext(name)[1].lower()
            if ext in ignore_exts:
                continue
            
            full_path = os.path.join(root, name)
            try:
                # Limit file size for indexing (e.g., 500KB)
                if os.path.getsize(full_path) > 500 * 1024:
                    continue
                
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as f:
                    content = f.read()
                    await index_project_file(project_path, full_path, content)
                    file_count += 1
            except Exception:
                continue
    
    # Optional: push a socket notification or log event when done
    print(f"Index complete: {file_count} files for {project_path}")

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
    return _agent_settings

@app.post("/settings/tools")
async def update_tool_config(req: ToolConfigRequest):
    """Configure which tools the agent can access"""
    _agent_settings["enabled_tools"] = req.tools
    return {"status": "success", "tools_configured": len(req.tools)}

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

    raw = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    ).stdout.splitlines()

    staged = []
    modified = []
    for line in raw:
        if len(line) < 4:
            continue
        x = line[0]
        y = line[1]
        p = line[3:]
        if x != " ":
            staged.append(p)
        if y != " ":
            modified.append(p)

    commits_raw = subprocess.run(
        ["git", "log", "--oneline", "-n", "5"],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=10,
    ).stdout.splitlines()
    recent_commits = []
    for c in commits_raw:
        if not c.strip():
            continue
        parts = c.split(" ", 1)
        if len(parts) == 2:
            recent_commits.append({"hash": parts[0], "msg": parts[1], "date": "recent"})

    return {
        "branch": branch,
        "modified": modified,
        "staged": staged,
        "recent_commits": recent_commits,
    }

@app.post("/git/commit")
async def git_commit(req: GitCommitRequest):
    """Commit currently staged changes."""
    repo_path = os.path.abspath(req.path)
    if not os.path.isdir(os.path.join(repo_path, ".git")):
        raise HTTPException(status_code=400, detail="Not a git repository")
    if not req.message.strip():
        raise HTTPException(status_code=400, detail="Commit message is required")

    add_proc = subprocess.run(
        ["git", "add", "."],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if add_proc.returncode != 0:
        raise HTTPException(status_code=500, detail=add_proc.stderr or "git add failed")

    commit_proc = subprocess.run(
        ["git", "commit", "-m", req.message],
        cwd=repo_path,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if commit_proc.returncode != 0:
        raise HTTPException(status_code=400, detail=commit_proc.stderr or commit_proc.stdout or "git commit failed")

    return {"status": "committed", "message": req.message}

@app.post("/sessions/{session_id}/feedback")
async def submit_feedback(session_id: str, req: FeedbackRequest):
    """Store thumbs up/down feedback for a specific agent message"""
    await add_event(session_id, "feedback", {
        "message_id": req.message_id,
        "feedback": req.feedback,
    })
    return {"status": "success"}

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
