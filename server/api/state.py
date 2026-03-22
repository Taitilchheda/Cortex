"""
Mission Control — Session State Manager
SQLite-backed persistent session storage with full event history for replay.
Implements Future Scope: persistent sessions that survive server restarts.
"""
import json
import uuid
import time
import os
import aiosqlite
from typing import Dict, List, Optional, Any

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "mission_control.db")

async def init_db():
    """Initialize SQLite database with sessions and events tables."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL DEFAULT 'chat',
                title TEXT DEFAULT '',
                project_path TEXT DEFAULT '',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                file_count INTEGER DEFAULT 0,
                token_usage TEXT DEFAULT '{}',
                metadata TEXT DEFAULT '{}'
            )
        """)
        await db.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                event_type TEXT NOT NULL,
                data TEXT NOT NULL,
                timestamp REAL NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            )
        """)
        await db.execute("CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id)")
        await db.commit()

async def create_session(session_type: str = "chat", title: str = "", project_path: str = "") -> dict:
    """Create a new session and return its metadata."""
    session_id = str(uuid.uuid4())
    now = time.time()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO sessions (id, type, title, project_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, session_type, title, project_path, now, now)
        )
        await db.commit()
    return {
        "id": session_id,
        "type": session_type,
        "title": title,
        "project_path": project_path,
        "created_at": now,
        "updated_at": now,
        "file_count": 0,
        "token_usage": {},
        "events": [],
    }

async def add_event(session_id: str, event_type: str, data: dict) -> None:
    """Append an event to a session's history."""
    now = time.time()
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO events (session_id, event_type, data, timestamp) VALUES (?, ?, ?, ?)",
            (session_id, event_type, json.dumps(data), now)
        )
        await db.execute("UPDATE sessions SET updated_at = ? WHERE id = ?", (now, session_id))
        
        if event_type == "file_created":
            await db.execute(
                "UPDATE sessions SET file_count = file_count + 1 WHERE id = ?",
                (session_id,)
            )
        await db.commit()

async def update_token_usage(session_id: str, prompt_tokens: int, completion_tokens: int, model: str) -> None:
    """Track token usage per session (Future Scope: token tracking)."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("SELECT token_usage FROM sessions WHERE id = ?", (session_id,))
        row = await cursor.fetchone()
        if row:
            usage = json.loads(row[0]) if row[0] else {}
            usage["total_prompt"] = usage.get("total_prompt", 0) + prompt_tokens
            usage["total_completion"] = usage.get("total_completion", 0) + completion_tokens
            usage["total_tokens"] = usage.get("total_tokens", 0) + prompt_tokens + completion_tokens
            if "by_model" not in usage:
                usage["by_model"] = {}
            if model not in usage["by_model"]:
                usage["by_model"][model] = {"prompt": 0, "completion": 0}
            usage["by_model"][model]["prompt"] += prompt_tokens
            usage["by_model"][model]["completion"] += completion_tokens
            await db.execute(
                "UPDATE sessions SET token_usage = ? WHERE id = ?",
                (json.dumps(usage), session_id)
            )
            await db.commit()

async def get_session(session_id: str) -> Optional[dict]:
    """Get a full session with its complete event history for replay."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM sessions WHERE id = ?", (session_id,))
        row = await cursor.fetchone()
        if not row:
            return None
        session = dict(row)
        session["token_usage"] = json.loads(session.get("token_usage", "{}"))
        session["metadata"] = json.loads(session.get("metadata", "{}"))

        cursor = await db.execute(
            "SELECT event_type, data, timestamp FROM events WHERE session_id = ? ORDER BY id",
            (session_id,)
        )
        events = []
        async for event_row in cursor:
            events.append({
                "type": event_row[0],
                "data": json.loads(event_row[1]),
                "timestamp": event_row[2],
            })
        session["events"] = events
        return session

async def list_sessions() -> list:
    """List all sessions (no event history, just summaries)."""
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM sessions ORDER BY updated_at DESC")
        sessions = []
        async for row in cursor:
            s = dict(row)
            s["token_usage"] = json.loads(s.get("token_usage", "{}"))
            s["metadata"] = json.loads(s.get("metadata", "{}"))
            sessions.append(s)
        return sessions

async def delete_session(session_id: str) -> bool:
    """Delete a specific session and its events."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
        await db.execute("DELETE FROM events WHERE session_id = ?", (session_id,))
        await db.commit()
        return cursor.rowcount > 0

async def clear_all_sessions() -> int:
    """Clear all sessions. Returns count deleted."""
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("SELECT COUNT(*) FROM sessions")
        count = (await cursor.fetchone())[0]
        await db.execute("DELETE FROM events")
        await db.execute("DELETE FROM sessions")
        await db.commit()
        return count

async def update_session_title(session_id: str, title: str) -> None:
    """Update a session's title."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE sessions SET title = ? WHERE id = ?", (title, session_id))
        await db.commit()
