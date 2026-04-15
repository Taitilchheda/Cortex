"""
Google Colab connector provider.
Uses Google Drive API to discover Colab notebooks (.ipynb) for the user.
"""
from __future__ import annotations

from typing import Optional

import httpx

from connectors.base import ConnectorContext, ConnectorProvider, ConnectorResult
from connectors.secrets import resolve_secret


class ColabConnector(ConnectorProvider):
    key = "colab"
    name = "Google Colab"
    supports_read = True
    supports_write = False
    description = "Connect to a user's Colab workspace via Google Drive notebook files."

    @property
    def config_fields(self):
        return [
            {
                "key": "access_token",
                "label": "Google OAuth Access Token",
                "type": "password",
                "required": True,
                "secret": True,
                "placeholder": "ya29...",
            }
        ]

    async def connect(self, ctx: ConnectorContext) -> ConnectorResult:
        token = resolve_secret(ctx.config, "access_token", "GOOGLE_COLAB_TOKEN_ENV")
        if not token:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing Google access token")
        return ConnectorResult(ok=True, status="connected", message="Colab token configured")

    async def disconnect(self, ctx: ConnectorContext) -> ConnectorResult:
        return ConnectorResult(ok=True, status="disconnected", message="Colab connector disconnected")

    async def test(self, ctx: ConnectorContext) -> ConnectorResult:
        token = resolve_secret(ctx.config, "access_token", "GOOGLE_COLAB_TOKEN_ENV")
        if not token:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing Google access token")

        headers = {"Authorization": f"Bearer {token}"}
        params = {
            "pageSize": 1,
            "fields": "files(id,name,mimeType)",
            "q": "mimeType='application/vnd.google.colaboratory' or name contains '.ipynb'",
        }
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get("https://www.googleapis.com/drive/v3/files", headers=headers, params=params)
            if resp.status_code != 200:
                return ConnectorResult(ok=False, status="error", error=f"Google Drive HTTP {resp.status_code}")
            payload = resp.json() if resp.text else {}
            return ConnectorResult(
                ok=True,
                status="ok",
                message="Colab notebook access verified",
                data={"sample_count": len((payload.get("files") or []))},
            )
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))

    async def list_items(self, ctx: ConnectorContext, cursor: Optional[str] = None) -> ConnectorResult:
        token = resolve_secret(ctx.config, "access_token", "GOOGLE_COLAB_TOKEN_ENV")
        if not token:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing Google access token")

        headers = {"Authorization": f"Bearer {token}"}
        params = {
            "pageSize": 25,
            "fields": "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)",
            "q": "mimeType='application/vnd.google.colaboratory' or name contains '.ipynb'",
        }
        if cursor:
            params["pageToken"] = cursor

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get("https://www.googleapis.com/drive/v3/files", headers=headers, params=params)
            if resp.status_code != 200:
                return ConnectorResult(ok=False, status="error", error=f"Google Drive HTTP {resp.status_code}")
            payload = resp.json() if resp.text else {}
            files = payload.get("files", []) if isinstance(payload, dict) else []
            items = [
                {
                    "id": f.get("id"),
                    "name": f.get("name"),
                    "mime": f.get("mimeType"),
                    "modified_at": f.get("modifiedTime"),
                    "url": f.get("webViewLink"),
                }
                for f in files if isinstance(f, dict)
            ]
            return ConnectorResult(ok=True, status="ok", data={"items": items, "cursor": payload.get("nextPageToken")})
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))
