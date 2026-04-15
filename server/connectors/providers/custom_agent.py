"""
Custom agent connector provider.
Connects to user-hosted agent endpoints for dynamic bring-your-own-agent integrations.
"""
from __future__ import annotations

from typing import Optional

import httpx

from connectors.base import ConnectorContext, ConnectorProvider, ConnectorResult


class CustomAgentConnector(ConnectorProvider):
    key = "custom_agent"
    name = "Custom Agent"
    supports_read = True
    supports_write = True
    description = "Connect to custom user-hosted agent APIs (local or remote)."

    @property
    def config_fields(self):
        return [
            {
                "key": "endpoint",
                "label": "Agent API Base URL",
                "type": "text",
                "required": True,
                "placeholder": "http://localhost:7070",
            },
            {
                "key": "api_key",
                "label": "API Key (optional)",
                "type": "password",
                "required": False,
                "secret": True,
                "placeholder": "optional bearer token",
            },
        ]

    def _headers(self, ctx: ConnectorContext) -> dict:
        headers = {"Accept": "application/json"}
        api_key = str(ctx.config.get("api_key", "") or "").strip()
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return headers

    def _endpoint(self, ctx: ConnectorContext) -> str:
        return str(ctx.config.get("endpoint", "") or "").strip().rstrip("/")

    async def connect(self, ctx: ConnectorContext) -> ConnectorResult:
        endpoint = self._endpoint(ctx)
        if not endpoint:
            return ConnectorResult(ok=False, status="invalid", error="Missing endpoint")
        return ConnectorResult(ok=True, status="connected", message="Custom agent endpoint configured")

    async def disconnect(self, ctx: ConnectorContext) -> ConnectorResult:
        return ConnectorResult(ok=True, status="disconnected", message="Custom agent connector disconnected")

    async def test(self, ctx: ConnectorContext) -> ConnectorResult:
        endpoint = self._endpoint(ctx)
        if not endpoint:
            return ConnectorResult(ok=False, status="invalid", error="Missing endpoint")

        headers = self._headers(ctx)
        probe_urls = [f"{endpoint}/health", f"{endpoint}/status", endpoint]
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                last_code = None
                for url in probe_urls:
                    resp = await client.get(url, headers=headers)
                    last_code = resp.status_code
                    if resp.status_code in (200, 204):
                        return ConnectorResult(ok=True, status="ok", message="Custom agent endpoint reachable", data={"url": url})
            return ConnectorResult(ok=False, status="error", error=f"Agent endpoint HTTP {last_code}")
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))

    async def list_items(self, ctx: ConnectorContext, cursor: Optional[str] = None) -> ConnectorResult:
        endpoint = self._endpoint(ctx)
        if not endpoint:
            return ConnectorResult(ok=False, status="invalid", error="Missing endpoint")

        headers = self._headers(ctx)
        list_urls = [f"{endpoint}/agents", f"{endpoint}/v1/agents"]

        try:
            async with httpx.AsyncClient(timeout=8) as client:
                for url in list_urls:
                    resp = await client.get(url, headers=headers)
                    if resp.status_code != 200:
                        continue
                    payload = resp.json() if resp.text else {}
                    rows = payload.get("agents") if isinstance(payload, dict) else payload
                    if not isinstance(rows, list):
                        rows = []
                    items = []
                    for row in rows:
                        if not isinstance(row, dict):
                            continue
                        items.append(
                            {
                                "id": row.get("id") or row.get("name"),
                                "name": row.get("name") or row.get("id") or "agent",
                                "description": row.get("description"),
                                "model": row.get("model"),
                            }
                        )
                    return ConnectorResult(ok=True, status="ok", data={"items": items, "cursor": cursor})

            return ConnectorResult(
                ok=True,
                status="ok",
                data={
                    "items": [
                        {
                            "id": endpoint,
                            "name": endpoint,
                            "description": "Endpoint configured (no /agents route found)",
                        }
                    ],
                    "cursor": cursor,
                },
            )
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))
