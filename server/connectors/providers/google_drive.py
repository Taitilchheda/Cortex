"""
Google Drive connector provider.
Phase A: token validation and lightweight Drive listing.
"""
from __future__ import annotations

from typing import Optional

import httpx

from connectors.base import ConnectorContext, ConnectorProvider, ConnectorResult
from connectors.secrets import resolve_secret


class GoogleDriveConnector(ConnectorProvider):
    key = "google_drive"
    name = "Google Drive"
    supports_read = True
    supports_write = False

    async def connect(self, ctx: ConnectorContext) -> ConnectorResult:
        token = resolve_secret(ctx.config, "access_token", "GOOGLE_DRIVE_TOKEN_ENV")
        if not token:
            return ConnectorResult(
                ok=False,
                status="needs_auth",
                error="Missing Google Drive access token.",
            )
        return ConnectorResult(ok=True, status="connected", message="Google Drive token configured")

    async def disconnect(self, ctx: ConnectorContext) -> ConnectorResult:
        return ConnectorResult(ok=True, status="disconnected", message="Google Drive connector disconnected")

    async def test(self, ctx: ConnectorContext) -> ConnectorResult:
        token = resolve_secret(ctx.config, "access_token", "GOOGLE_DRIVE_TOKEN_ENV")
        if not token:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing Google Drive access token")

        headers = {"Authorization": f"Bearer {token}"}
        url = "https://www.googleapis.com/drive/v3/about?fields=user,storageQuota"
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(url, headers=headers)
            if resp.status_code != 200:
                return ConnectorResult(ok=False, status="error", error=f"Google Drive HTTP {resp.status_code}")
            payload = resp.json() if resp.text else {}
            return ConnectorResult(
                ok=True,
                status="ok",
                data={
                    "user": (payload.get("user") or {}).get("emailAddress"),
                    "quota": payload.get("storageQuota"),
                },
                message="Google Drive connectivity verified",
            )
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))

    async def list_items(self, ctx: ConnectorContext, cursor: Optional[str] = None) -> ConnectorResult:
        token = resolve_secret(ctx.config, "access_token", "GOOGLE_DRIVE_TOKEN_ENV")
        if not token:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing Google Drive access token")

        headers = {"Authorization": f"Bearer {token}"}
        params = {
            "pageSize": 25,
            "fields": "nextPageToken,files(id,name,mimeType,modifiedTime,size)",
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
                    "size": f.get("size"),
                }
                for f in files if isinstance(f, dict)
            ]
            return ConnectorResult(
                ok=True,
                status="ok",
                data={"items": items, "cursor": payload.get("nextPageToken")},
            )
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))
