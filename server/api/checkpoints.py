"""
Checkpoint API for saving/restoring Cortex session snapshots.
"""
from __future__ import annotations

import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api.config import get_cortex_paths
from api.state import DB_PATH, get_session


router = APIRouter(prefix="/checkpoints", tags=["checkpoints"])


class SaveCheckpointRequest(BaseModel):
    session_id: str
    label: Optional[str] = None
    tags: List[str] = Field(default_factory=list)


class RestoreCheckpointRequest(BaseModel):
    include_messages: bool = True


async def init_checkpoints_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS checkpoints (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                label TEXT NOT NULL,
                file_path TEXT NOT NULL,
                payload TEXT NOT NULL,
                ts REAL NOT NULL
            )
            """
        )
        await db.execute("CREATE INDEX IF NOT EXISTS idx_checkpoints_ts ON checkpoints(ts DESC)")
        await db.commit()


def _checkpoint_file_path(checkpoint_id: str) -> Path:
    memory_dir = get_cortex_paths()["memory"]
    return memory_dir / f"checkpoint-{checkpoint_id}.md"


def _to_markdown(payload: Dict[str, Any], label: str, tags: List[str]) -> str:
    now_iso = datetime.now(timezone.utc).isoformat()
    tags_str = ", ".join(tags)
    session = payload.get("session", {})
    project = payload.get("project", {})

    lines = [
        "---",
        f"id: {payload.get('id', '')}",
        f"label: \"{label}\"",
        f"timestamp: {now_iso}",
        f"tags: [{tags_str}]",
        "---",
        "",
        f"# Session: {session.get('task', 'Checkpoint')}",
        "",
        "## Context",
        f"Project path: {project.get('path', '')}",
        f"Git branch: {project.get('git_branch', 'unknown')}",
        f"Phase: {session.get('phase', 'unknown')}",
        "",
        "## Files Written",
    ]

    files_written = session.get("files_written", [])
    if isinstance(files_written, list) and files_written:
        for item in files_written[:200]:
            lines.append(f"- {item}")
    else:
        lines.append("- none")

    lines.extend(["", "## Session Payload", "", "```json", json.dumps(payload, indent=2), "```", ""])
    return "\n".join(lines)


async def _build_checkpoint_payload(session_id: str, label: str) -> Dict[str, Any]:
    session = await get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    events = session.get("events", [])
    files_written: List[str] = []
    for event in events:
        if event.get("type") == "file_created":
            path = event.get("data", {}).get("rel_path") or event.get("data", {}).get("path")
            if path:
                files_written.append(str(path))

    task = ""
    for event in events:
        if event.get("type") in {"build_start", "chat_start"}:
            task = str(event.get("data", {}).get("task", ""))
            if task:
                break

    checkpoint_id = uuid.uuid4().hex[:12]
    return {
        "id": checkpoint_id,
        "label": label,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "session": {
            "task": task,
            "messages": events,
            "files_written": files_written,
            "plan": None,
            "phase": "checkpoint_saved",
            "specialist_context": {},
        },
        "project": {
            "path": session.get("project_path", ""),
            "git_stash": None,
            "git_branch": "unknown",
            "open_files": [],
            "cursor_positions": {},
        },
        "graph_links": [],
    }


@router.post("/save")
async def save_checkpoint(req: SaveCheckpointRequest):
    await init_checkpoints_db()
    label = req.label or f"checkpoint-{req.session_id[:8]}"
    payload = await _build_checkpoint_payload(req.session_id, label)

    checkpoint_id = str(payload["id"])
    md_path = _checkpoint_file_path(checkpoint_id)
    md_path.write_text(_to_markdown(payload, label, req.tags), encoding="utf-8")

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO checkpoints (id, session_id, label, file_path, payload, ts) VALUES (?, ?, ?, ?, ?, ?)",
            (
                checkpoint_id,
                req.session_id,
                label,
                str(md_path),
                json.dumps(payload),
                time.time(),
            ),
        )
        await db.commit()

    return {
        "checkpoint_id": checkpoint_id,
        "label": label,
        "file_path": str(md_path),
        "timestamp": payload.get("timestamp"),
    }


@router.get("")
async def list_checkpoints():
    await init_checkpoints_db()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT id, session_id, label, file_path, ts FROM checkpoints ORDER BY ts DESC")
        rows = await cursor.fetchall()
    return {
        "checkpoints": [
            {
                "id": row["id"],
                "session_id": row["session_id"],
                "label": row["label"],
                "file_path": row["file_path"],
                "ts": row["ts"],
            }
            for row in rows
        ]
    }


@router.get("/{checkpoint_id}")
async def get_checkpoint(checkpoint_id: str):
    await init_checkpoints_db()
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("SELECT payload, file_path FROM checkpoints WHERE id = ?", (checkpoint_id,))
        row = await cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Checkpoint not found")

    payload = json.loads(row[0])
    file_path = str(row[1])
    markdown = ""
    try:
        markdown = Path(file_path).read_text(encoding="utf-8")
    except Exception:
        markdown = ""

    return {"checkpoint": payload, "markdown": markdown, "file_path": file_path}


@router.post("/{checkpoint_id}/restore")
async def restore_checkpoint(checkpoint_id: str, req: RestoreCheckpointRequest):
    await init_checkpoints_db()
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("SELECT payload FROM checkpoints WHERE id = ?", (checkpoint_id,))
        row = await cursor.fetchone()

    if not row:
        raise HTTPException(status_code=404, detail="Checkpoint not found")

    payload = json.loads(row[0])
    session_payload = payload.get("session", {}) if isinstance(payload, dict) else {}
    if not req.include_messages and isinstance(session_payload, dict):
        session_payload = dict(session_payload)
        session_payload["messages"] = []

    return {
        "status": "restored",
        "checkpoint_id": checkpoint_id,
        "session": session_payload,
        "project": payload.get("project", {}),
    }
