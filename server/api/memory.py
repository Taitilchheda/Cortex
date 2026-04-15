import aiosqlite
import os
import json
from typing import List, Dict, Any, Optional
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "cortex.db")

async def init_memory_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS memory (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key TEXT UNIQUE,
                value TEXT,
                source TEXT,
                importance INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # FTS5 for search
        await db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(key, value, content='memory', content_rowid='id')")
        await db.commit()

async def add_memory(key: str, value: str, source: str = "user"):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            INSERT INTO memory (key, value, source, updated_at) 
            VALUES (?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
        """, (key, value, source))
        # Sync FTS
        await db.execute("INSERT OR REPLACE INTO memory_fts(rowid, key, value) SELECT id, key, value FROM memory WHERE key=?", (key,))
        await db.commit()

async def get_memories(limit: int = 5) -> List[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM memory ORDER BY updated_at DESC LIMIT ?", (limit,)) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

async def search_memories(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("""
            SELECT m.* FROM memory m 
            JOIN memory_fts f ON m.id = f.rowid 
            WHERE memory_fts MATCH ? 
            ORDER BY rank LIMIT ?
        """, (query, limit)) as cursor:
            rows = await cursor.fetchall()
            return [dict(r) for r in rows]

async def get_memory_context(task: str) -> str:
    """
    Search memories relevant to the task and format for prompt injection.
    """
    # Simple keyword extraction for now
    mems = await get_memories(10) # Fallback to recent
    if not mems: return ""
    
    ctx = "\n--- Long-Term Memory (Learned Context) ---\n"
    for m in mems:
        ctx += f"- {m['key']}: {m['value']}\n"
    return ctx + "--- End Memory ---\n"
