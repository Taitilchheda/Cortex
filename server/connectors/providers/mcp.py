"""
MCP connector provider.
Phase A: endpoint registry and health probe.
"""
from __future__ import annotations

from typing import Optional

import httpx

from connectors.base import ConnectorContext, ConnectorProvider, ConnectorResult


class MCPConnector(ConnectorProvider):
    key = "mcp"
    name = "MCP"
    supports_read = True
    supports_write = False
    description = "Connect to an MCP server endpoint."

    @property
    def config_fields(self):
        return [
            {
                "key": "endpoint",
                "label": "MCP Endpoint URL",
                "type": "text",
                "required": True,
                "placeholder": "http://localhost:9001",
            },
            {
                "key": "api_key",
                "label": "API Key (optional)",
                "type": "password",
                "required": False,
                "secret": True,
                "placeholder": "optional",
            },
        ]

    async def connect(self, ctx: ConnectorContext) -> ConnectorResult:
        endpoint = str(ctx.config.get("endpoint", "") or "").strip()
        if not endpoint:
            return ConnectorResult(ok=False, status="invalid", error="Missing MCP endpoint in config.endpoint")
        return ConnectorResult(ok=True, status="connected", message="MCP endpoint configured")

    async def disconnect(self, ctx: ConnectorContext) -> ConnectorResult:
        return ConnectorResult(ok=True, status="disconnected", message="MCP connector disconnected")

    async def test(self, ctx: ConnectorContext) -> ConnectorResult:
        endpoint = str(ctx.config.get("endpoint", "") or "").strip()
        if not endpoint:
            return ConnectorResult(ok=False, status="invalid", error="Missing MCP endpoint")

        health_url = endpoint.rstrip("/") + "/health"
        headers = {}
        api_key = str(ctx.config.get("api_key", "") or "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            async with httpx.AsyncClient(timeout=6) as client:
                resp = await client.get(health_url, headers=headers)
            if resp.status_code not in (200, 204):
                return ConnectorResult(ok=False, status="error", error=f"MCP health HTTP {resp.status_code}")
            return ConnectorResult(ok=True, status="ok", message="MCP endpoint reachable")
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))

    async def list_items(self, ctx: ConnectorContext, cursor: Optional[str] = None) -> ConnectorResult:
        endpoint = str(ctx.config.get("endpoint", "") or "").strip()
        return ConnectorResult(
            ok=True,
            status="ok",
            data={
                "items": [
                    {
                        "id": endpoint or "mcp-endpoint",
                        "name": endpoint or "MCP endpoint",
                        "type": "server",
                    }
                ],
                "cursor": cursor,
            },
        )
