"""
Cortex v3 foundation: CEP packet schema + handoff API skeleton.
"""
import json
import subprocess
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api.config import get_cortex_paths
from api.state import DB_PATH, get_session


router = APIRouter(prefix="/environments", tags=["environments"])


class CEPPacket(BaseModel):
    version: str = "1.0"
    session_id: str
    project: Dict[str, Any]
    conversation: Dict[str, Any]
    agent: Dict[str, Any]
    environment: Dict[str, Any]


class PushRequest(BaseModel):
    target: str = Field(..., description="Target tool, e.g. vscode/claude_code/openclaw")
    session_id: str


async def init_environments_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS env_handoffs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                source_tool TEXT NOT NULL,
                target_tool TEXT NOT NULL,
                packet TEXT NOT NULL,
                accepted INTEGER DEFAULT 0,
                ts REAL NOT NULL
            )
            """
        )
        await db.execute("CREATE INDEX IF NOT EXISTS idx_env_handoffs_accepted_ts ON env_handoffs(accepted, ts DESC)")
        await db.commit()


def _safe_git_branch(project_path: str) -> str:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=project_path,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if proc.returncode == 0:
            return (proc.stdout or "").strip() or "unknown"
    except Exception:
        pass
    return "unknown"


async def _write_latest_packet(packet: Dict[str, Any]) -> None:
    paths = get_cortex_paths()
    latest_path = paths["environments_latest"]
    latest_path.write_text(json.dumps(packet, indent=2), encoding="utf-8")


def build_restore_preview(packet: Dict[str, Any]) -> Dict[str, Any]:
    project = packet.get("project", {}) if isinstance(packet, dict) else {}
    conversation = packet.get("conversation", {}) if isinstance(packet, dict) else {}
    agent = packet.get("agent", {}) if isinstance(packet, dict) else {}
    environment = packet.get("environment", {}) if isinstance(packet, dict) else {}

    open_files = project.get("open_files", [])
    breakpoints = project.get("breakpoints", [])
    messages = conversation.get("messages", [])
    files_written = agent.get("files_written", [])

    preview = {
        "version": packet.get("version", "unknown"),
        "session_id": packet.get("session_id"),
        "source_tool": environment.get("source_tool", "unknown"),
        "target_tool": environment.get("target_tool", "unknown"),
        "project_path": project.get("path", ""),
        "git_branch": project.get("git_branch", "unknown"),
        "active_task": conversation.get("active_task", ""),
        "summary": {
            "message_count": len(messages) if isinstance(messages, list) else 0,
            "open_file_count": len(open_files) if isinstance(open_files, list) else 0,
            "breakpoint_count": len(breakpoints) if isinstance(breakpoints, list) else 0,
            "files_written_count": len(files_written) if isinstance(files_written, list) else 0,
        },
        "restore_actions": [
            "restore_conversation_context",
            "restore_project_context",
            "apply_agent_plan_state",
        ],
    }

    warnings: List[str] = []
    if not preview["project_path"]:
        warnings.append("Missing project path in CEP packet")
    if preview["summary"]["message_count"] == 0:
        warnings.append("No conversation messages available for restore")
    preview["warnings"] = warnings
    return preview


async def _get_pending_packet(session_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    await init_environments_db()
    async with aiosqlite.connect(DB_PATH) as db:
        if session_id:
            cursor = await db.execute(
                "SELECT packet FROM env_handoffs WHERE accepted = 0 AND session_id = ? ORDER BY ts DESC LIMIT 1",
                (session_id,),
            )
        else:
            cursor = await db.execute(
                "SELECT packet FROM env_handoffs WHERE accepted = 0 ORDER BY ts DESC LIMIT 1"
            )
        row = await cursor.fetchone()
    if not row:
        return None
    return json.loads(row[0])


async def build_cep_packet(session_id: str, target: str) -> Dict[str, Any]:
    session = await get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    project_path = session.get("project_path") or ""
    events: List[Dict[str, Any]] = session.get("events", [])

    messages: List[Dict[str, Any]] = []
    for ev in events[-120:]:
        if ev.get("type") == "chat_start" and ev.get("data", {}).get("task"):
            messages.append({
                "role": "user",
                "content": ev["data"]["task"],
                "ts": ev.get("timestamp"),
            })
        elif ev.get("type") == "chat_response" and ev.get("data", {}).get("content"):
            messages.append({
                "role": "assistant",
                "content": ev["data"]["content"],
                "ts": ev.get("timestamp"),
            })

    active_task = ""
    for msg in reversed(messages):
        if msg["role"] == "user":
            active_task = msg["content"]
            break

    files_written: List[str] = []
    for ev in events:
        if ev.get("type") == "file_created":
            p = ev.get("data", {}).get("path")
            if p:
                files_written.append(p)

    packet: Dict[str, Any] = {
        "version": "1.0",
        "session_id": session_id,
        "project": {
            "path": project_path,
            "git_branch": _safe_git_branch(project_path) if project_path else "unknown",
            "git_stash": None,
            "open_files": [],
            "breakpoints": [],
        },
        "conversation": {
            "messages": messages[-60:],
            "active_task": active_task,
            "recent_decisions": [],
        },
        "agent": {
            "phase": "idle",
            "plan": None,
            "files_written": files_written,
            "files_remaining": [],
            "specialist_context": {
                "frontend": "",
                "backend": "",
            },
        },
        "environment": {
            "source_tool": "cortex",
            "target_tool": target,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "cortex_url": "http://localhost:8000",
        },
    }

    return packet


@router.post("/receive")
async def receive_handoff(packet: CEPPacket):
    await init_environments_db()
    packet_dict = packet.model_dump()
    source_tool = packet_dict.get("environment", {}).get("source_tool", "unknown")
    target_tool = packet_dict.get("environment", {}).get("target_tool", "cortex")

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO env_handoffs (session_id, source_tool, target_tool, packet, accepted, ts) VALUES (?, ?, ?, ?, 0, ?)",
            (packet.session_id, source_tool, target_tool, json.dumps(packet_dict), time.time()),
        )
        await db.commit()

    await _write_latest_packet(packet_dict)
    return {"status": "received", "session_id": packet.session_id, "source": source_tool}


@router.get("/latest")
async def latest_handoff():
    return await _get_pending_packet()


@router.get("/latest/preview")
async def latest_handoff_preview():
    packet = await _get_pending_packet()
    if not packet:
        return None
    return {"preview": build_restore_preview(packet), "packet": packet}


@router.post("/push")
async def push_to_tool(req: PushRequest):
    await init_environments_db()
    packet = await build_cep_packet(req.session_id, req.target)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO env_handoffs (session_id, source_tool, target_tool, packet, accepted, ts) VALUES (?, ?, ?, ?, 0, ?)",
            (req.session_id, "cortex", req.target, json.dumps(packet), time.time()),
        )
        await db.commit()

    await _write_latest_packet(packet)
    # Adapter delivery is intentionally deferred in foundation phase.
    return {"status": "queued", "target": req.target, "session_id": req.session_id}


@router.get("/{session_id}/preview")
async def session_handoff_preview(session_id: str):
    packet = await _get_pending_packet(session_id)
    if not packet:
        raise HTTPException(status_code=404, detail="No pending handoff for session")
    return {"preview": build_restore_preview(packet), "packet": packet}


@router.post("/{session_id}/accept")
async def accept_handoff(session_id: str):
    await init_environments_db()
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute(
            "UPDATE env_handoffs SET accepted = 1 WHERE session_id = ? AND accepted = 0",
            (session_id,),
        )
        await db.commit()

    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="No pending handoff for session")
    return {"status": "accepted", "session_id": session_id}
