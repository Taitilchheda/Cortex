"""
Connectors API (Phase A foundation).
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Dict, List, Optional

import aiosqlite
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api.state import DB_PATH
from connectors.base import ConnectorContext
from connectors.registry import get_provider, list_provider_metadata
from connectors.secrets import redact_config
from connectors.sync import run_sync


router = APIRouter(prefix="/connectors", tags=["connectors"])


class ConnectorCreateRequest(BaseModel):
    type: str
    name: str
    mode: str = "read_only"
    config: Dict[str, Any] = Field(default_factory=dict)
    scopes: List[str] = Field(default_factory=list)


class ConnectorUpdateRequest(BaseModel):
    name: Optional[str] = None
    mode: Optional[str] = None
    config: Optional[Dict[str, Any]] = None
    scopes: Optional[List[str]] = None


class ConnectorActionRequest(BaseModel):
    action: str
    payload: Dict[str, Any] = Field(default_factory=dict)


async def init_connectors_db() -> None:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS connectors (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'disconnected',
                mode TEXT NOT NULL DEFAULT 'read_only',
                config_json TEXT NOT NULL DEFAULT '{}',
                scopes_json TEXT NOT NULL DEFAULT '[]',
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )
        await db.execute(
            """
            CREATE TABLE IF NOT EXISTS connector_runs (
                id TEXT PRIMARY KEY,
                connector_id TEXT NOT NULL,
                action TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at REAL NOT NULL,
                finished_at REAL,
                duration_ms INTEGER,
                error TEXT,
                result_json TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY (connector_id) REFERENCES connectors(id) ON DELETE CASCADE
            )
            """
        )
        await db.execute("CREATE INDEX IF NOT EXISTS idx_connector_runs_connector ON connector_runs(connector_id)")
        await db.execute("CREATE INDEX IF NOT EXISTS idx_connector_runs_started ON connector_runs(started_at DESC)")
        await db.commit()


async def _fetch_connector(connector_id: str) -> Optional[Dict[str, Any]]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM connectors WHERE id = ?", (connector_id,))
        row = await cursor.fetchone()
        if not row:
            return None
        item = dict(row)
        item["config"] = json.loads(item.get("config_json") or "{}")
        item["scopes"] = json.loads(item.get("scopes_json") or "[]")
        item.pop("config_json", None)
        item.pop("scopes_json", None)
        return item


async def _write_run(connector_id: str, action: str, status: str, started_at: float, error: str = "", result: Optional[dict] = None) -> None:
    finished = time.time()
    duration_ms = int((finished - started_at) * 1000)
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO connector_runs (id, connector_id, action, status, started_at, finished_at, duration_ms, error, result_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                connector_id,
                action,
                status,
                started_at,
                finished,
                duration_ms,
                error,
                json.dumps(result or {}),
            ),
        )
        await db.commit()


def _provider_ctx(connector: Dict[str, Any]) -> ConnectorContext:
    return ConnectorContext(
        connector_id=connector["id"],
        connector_type=connector["type"],
        mode=connector.get("mode", "read_only"),
        config=connector.get("config", {}) or {},
    )


@router.get("/providers")
async def connectors_providers():
    return {"providers": list_provider_metadata()}


@router.get("")
async def list_connectors():
    await init_connectors_db()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM connectors ORDER BY updated_at DESC")
        rows = []
        async for row in cursor:
            item = dict(row)
            item["config"] = redact_config(json.loads(item.get("config_json") or "{}"))
            item["scopes"] = json.loads(item.get("scopes_json") or "[]")
            item.pop("config_json", None)
            item.pop("scopes_json", None)
            rows.append(item)
    return {"connectors": rows}


@router.post("")
async def create_connector(req: ConnectorCreateRequest):
    await init_connectors_db()
    provider = get_provider(req.type)
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unknown connector type: {req.type}")

    now = time.time()
    connector_id = str(uuid.uuid4())
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO connectors (id, type, name, status, mode, config_json, scopes_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                connector_id,
                req.type,
                req.name,
                "disconnected",
                req.mode,
                json.dumps(req.config),
                json.dumps(req.scopes),
                now,
                now,
            ),
        )
        await db.commit()

    created = await _fetch_connector(connector_id)
    return {"connector": {**(created or {}), "config": redact_config((created or {}).get("config", {}))}}


@router.get("/{connector_id}")
async def get_connector(connector_id: str):
    await init_connectors_db()
    row = await _fetch_connector(connector_id)
    if not row:
        raise HTTPException(status_code=404, detail="Connector not found")
    row["config"] = redact_config(row.get("config", {}))
    return {"connector": row}


@router.patch("/{connector_id}")
async def update_connector(connector_id: str, req: ConnectorUpdateRequest):
    await init_connectors_db()
    row = await _fetch_connector(connector_id)
    if not row:
        raise HTTPException(status_code=404, detail="Connector not found")

    name = req.name if req.name is not None else row["name"]
    mode = req.mode if req.mode is not None else row.get("mode", "read_only")
    config = req.config if req.config is not None else row.get("config", {})
    scopes = req.scopes if req.scopes is not None else row.get("scopes", [])

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            UPDATE connectors
            SET name = ?, mode = ?, config_json = ?, scopes_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (name, mode, json.dumps(config), json.dumps(scopes), time.time(), connector_id),
        )
        await db.commit()

    updated = await _fetch_connector(connector_id)
    if not updated:
        raise HTTPException(status_code=404, detail="Connector not found")
    updated["config"] = redact_config(updated.get("config", {}))
    return {"connector": updated}


@router.delete("/{connector_id}")
async def delete_connector(connector_id: str):
    await init_connectors_db()
    async with aiosqlite.connect(DB_PATH) as db:
        cursor = await db.execute("DELETE FROM connectors WHERE id = ?", (connector_id,))
        await db.execute("DELETE FROM connector_runs WHERE connector_id = ?", (connector_id,))
        await db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Connector not found")
    return {"status": "deleted", "connector_id": connector_id}


@router.post("/{connector_id}/connect")
async def connector_connect(connector_id: str):
    await init_connectors_db()
    row = await _fetch_connector(connector_id)
    if not row:
        raise HTTPException(status_code=404, detail="Connector not found")

    provider = get_provider(row["type"])
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unsupported connector type: {row['type']}")

    started = time.time()
    result = await provider.connect(_provider_ctx(row))
    await _write_run(connector_id, "connect", "success" if result.ok else "failed", started, error=result.error or "", result=result.data)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE connectors SET status = ?, updated_at = ? WHERE id = ?",
            ("connected" if result.ok else "degraded", time.time(), connector_id),
        )
        await db.commit()

    return {"result": result.__dict__}


@router.post("/{connector_id}/disconnect")
async def connector_disconnect(connector_id: str):
    await init_connectors_db()
    row = await _fetch_connector(connector_id)
    if not row:
        raise HTTPException(status_code=404, detail="Connector not found")

    provider = get_provider(row["type"])
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unsupported connector type: {row['type']}")

    started = time.time()
    result = await provider.disconnect(_provider_ctx(row))
    await _write_run(connector_id, "disconnect", "success" if result.ok else "failed", started, error=result.error or "", result=result.data)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE connectors SET status = ?, updated_at = ? WHERE id = ?",
            ("disconnected", time.time(), connector_id),
        )
        await db.commit()

    return {"result": result.__dict__}


@router.post("/{connector_id}/test")
async def connector_test(connector_id: str):
    await init_connectors_db()
    row = await _fetch_connector(connector_id)
    if not row:
        raise HTTPException(status_code=404, detail="Connector not found")

    provider = get_provider(row["type"])
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unsupported connector type: {row['type']}")

    started = time.time()
    result = await provider.test(_provider_ctx(row))
    await _write_run(connector_id, "test", "success" if result.ok else "failed", started, error=result.error or "", result=result.data)

    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE connectors SET status = ?, updated_at = ? WHERE id = ?",
            (("connected" if result.ok else "degraded"), time.time(), connector_id),
        )
        await db.commit()

    return {"result": result.__dict__}


@router.post("/{connector_id}/sync")
async def connector_sync(connector_id: str):
    await init_connectors_db()
    row = await _fetch_connector(connector_id)
    if not row:
        raise HTTPException(status_code=404, detail="Connector not found")

    provider = get_provider(row["type"])
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unsupported connector type: {row['type']}")

    started = time.time()
    result = await run_sync(provider, _provider_ctx(row))
    await _write_run(connector_id, "sync", "success" if result.ok else "failed", started, error=result.error or "", result=result.data)
    return {"result": result.__dict__}


@router.get("/{connector_id}/items")
async def connector_items(connector_id: str):
    await init_connectors_db()
    row = await _fetch_connector(connector_id)
    if not row:
        raise HTTPException(status_code=404, detail="Connector not found")

    provider = get_provider(row["type"])
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unsupported connector type: {row['type']}")

    result = await provider.list_items(_provider_ctx(row), cursor=None)
    return {"result": result.__dict__}


@router.get("/{connector_id}/runs")
async def connector_runs(connector_id: str):
    await init_connectors_db()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM connector_runs WHERE connector_id = ? ORDER BY started_at DESC LIMIT 100",
            (connector_id,),
        )
        runs = []
        async for row in cursor:
            item = dict(row)
            item["result"] = json.loads(item.get("result_json") or "{}")
            item.pop("result_json", None)
            runs.append(item)
    return {"runs": runs}


@router.get("/{connector_id}/health")
async def connector_health(connector_id: str):
    await init_connectors_db()
    row = await _fetch_connector(connector_id)
    if not row:
        raise HTTPException(status_code=404, detail="Connector not found")

    provider = get_provider(row["type"])
    if not provider:
        raise HTTPException(status_code=400, detail=f"Unsupported connector type: {row['type']}")

    tested = await provider.test(_provider_ctx(row))
    return {
        "connector_id": connector_id,
        "type": row["type"],
        "status": row.get("status", "unknown"),
        "health": tested.__dict__,
    }
