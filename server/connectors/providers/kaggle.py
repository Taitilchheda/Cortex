"""
Kaggle connector provider.
Uses Kaggle API credentials (username + API key) dynamically supplied per connector.
"""
from __future__ import annotations

from typing import Optional

import httpx

from connectors.base import ConnectorContext, ConnectorProvider, ConnectorResult
from connectors.secrets import resolve_secret


class KaggleConnector(ConnectorProvider):
    key = "kaggle"
    name = "Kaggle"
    supports_read = True
    supports_write = False
    description = "Connect to Kaggle datasets/notebooks using user API credentials."

    @property
    def config_fields(self):
        return [
            {
                "key": "username",
                "label": "Kaggle Username",
                "type": "text",
                "required": True,
                "placeholder": "your-kaggle-username",
            },
            {
                "key": "api_key",
                "label": "Kaggle API Key",
                "type": "password",
                "required": True,
                "secret": True,
                "placeholder": "kaggle_api_key",
            },
        ]

    def _auth(self, ctx: ConnectorContext) -> tuple[str, str] | None:
        username = str(ctx.config.get("username", "") or "").strip()
        api_key = resolve_secret(ctx.config, "api_key", "KAGGLE_KEY_ENV")
        if not username or not api_key:
            return None
        return username, api_key

    async def connect(self, ctx: ConnectorContext) -> ConnectorResult:
        auth = self._auth(ctx)
        if not auth:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing Kaggle username/api_key")
        return ConnectorResult(ok=True, status="connected", message="Kaggle credentials configured")

    async def disconnect(self, ctx: ConnectorContext) -> ConnectorResult:
        return ConnectorResult(ok=True, status="disconnected", message="Kaggle connector disconnected")

    async def test(self, ctx: ConnectorContext) -> ConnectorResult:
        auth = self._auth(ctx)
        if not auth:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing Kaggle username/api_key")

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://www.kaggle.com/api/v1/datasets/list",
                    params={"search": "python", "page": 1},
                    auth=auth,
                )
            if resp.status_code != 200:
                return ConnectorResult(ok=False, status="error", error=f"Kaggle HTTP {resp.status_code}")
            data = resp.json() if resp.text else []
            return ConnectorResult(ok=True, status="ok", message="Kaggle connectivity verified", data={"sample_count": len(data)})
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))

    async def list_items(self, ctx: ConnectorContext, cursor: Optional[str] = None) -> ConnectorResult:
        auth = self._auth(ctx)
        if not auth:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing Kaggle username/api_key")

        page = 1
        try:
            if cursor:
                page = max(1, int(cursor))
        except ValueError:
            page = 1

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(
                    "https://www.kaggle.com/api/v1/datasets/list",
                    params={"search": "", "page": page},
                    auth=auth,
                )
            if resp.status_code != 200:
                return ConnectorResult(ok=False, status="error", error=f"Kaggle HTTP {resp.status_code}")

            rows = resp.json() if resp.text else []
            items = []
            for r in rows if isinstance(rows, list) else []:
                if not isinstance(r, dict):
                    continue
                ref = r.get("ref") or r.get("id")
                items.append(
                    {
                        "id": ref,
                        "name": ref,
                        "title": r.get("title"),
                        "last_updated": r.get("lastUpdated"),
                        "download_count": r.get("downloadCount"),
                    }
                )

            next_cursor = str(page + 1) if len(items) >= 20 else None
            return ConnectorResult(ok=True, status="ok", data={"items": items, "cursor": next_cursor})
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))
