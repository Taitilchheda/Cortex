"""
Connector sync orchestration helpers.
Phase A exposes a predictable no-op sync contract per connector.
"""
from __future__ import annotations

from typing import Any, Dict

from connectors.base import ConnectorContext, ConnectorProvider, ConnectorResult


async def run_sync(provider: ConnectorProvider, ctx: ConnectorContext) -> ConnectorResult:
    """
    Run a provider sync pass.

    Phase A behavior:
    - call list_items() as a lightweight sync primitive
    - return item count for indexing follow-up
    """
    listed = await provider.list_items(ctx, cursor=None)
    items = listed.data.get("items", []) if isinstance(listed.data, dict) else []
    return ConnectorResult(
        ok=bool(listed.ok),
        status="ok" if listed.ok else "error",
        message="Sync completed" if listed.ok else "Sync failed",
        data={
            "items": items,
            "count": len(items) if isinstance(items, list) else 0,
            "provider_status": listed.status,
        },
        error=listed.error,
    )
