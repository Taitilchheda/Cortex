import aiosqlite
import os
from typing import List, Dict, Any

# Keep memory in the same SQLite file used by session state.
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "mission_control.db")

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
        await db.execute("""
            CREATE TABLE IF NOT EXISTS specialist_memory (
                role TEXT PRIMARY KEY,
                summary TEXT NOT NULL,
                updated_at REAL NOT NULL
            )
        """)
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
    try:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            async with db.execute("SELECT * FROM memory ORDER BY updated_at DESC LIMIT ?", (limit,)) as cursor:
                rows = await cursor.fetchall()
                return [dict(r) for r in rows]
    except Exception:
        return []

async def search_memories(query: str, limit: int = 5) -> List[Dict[str, Any]]:
    try:
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
    except Exception:
        return []

async def get_memory_context(task: str) -> str:
    """
    Search memories relevant to the task and format for prompt injection.
    """
    # Simple keyword extraction for now
    mems = await get_memories(10)
    if not mems:
        return ""
    
    ctx = "\n--- Long-Term Memory (Learned Context) ---\n"
    for m in mems:
        ctx += f"- {m['key']}: {m['value']}\n"
    return ctx + "--- End Memory ---\n"


async def upsert_specialist_memory(role: str, summary: str) -> None:
    """Persist a compact per-role specialist summary for cross-session recall."""
    role_name = (role or "").strip().lower()
    text = (summary or "").strip()
    if not role_name or not text:
        return
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO specialist_memory (role, summary, updated_at)
            VALUES (?, ?, strftime('%s','now'))
            ON CONFLICT(role) DO UPDATE SET
                summary = excluded.summary,
                updated_at = excluded.updated_at
            """,
            (role_name, text[:3000]),
        )
        await db.commit()


async def get_specialist_memory_context(roles: List[str], limit: int = 5) -> str:
    """Return specialist memory snippets for the requested roles."""
    wanted = [str(r).strip().lower() for r in roles if str(r).strip()]
    wanted = list(dict.fromkeys(wanted))
    if not wanted:
        return ""

    placeholders = ",".join(["?"] * len(wanted))
    query = (
        "SELECT role, summary, updated_at FROM specialist_memory "
        f"WHERE role IN ({placeholders}) ORDER BY updated_at DESC LIMIT ?"
    )

    try:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            params = [*wanted, int(limit)]
            async with db.execute(query, params) as cursor:
                rows = await cursor.fetchall()
    except Exception:
        return ""

    if not rows:
        return ""

    chunks = ["--- Specialist Memory (Persistent) ---"]
    for row in rows:
        chunks.append(f"- [{row['role']}] {row['summary']}")
    chunks.append("--- End Specialist Memory ---")
    return "\n".join(chunks) + "\n"
