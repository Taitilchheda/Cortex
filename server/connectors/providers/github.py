"""
GitHub connector provider.
Phase A: connect/test/list metadata stubs with live health check.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

import httpx

from connectors.base import ConnectorContext, ConnectorProvider, ConnectorResult
from connectors.secrets import resolve_secret


class GitHubConnector(ConnectorProvider):
    key = "github"
    name = "GitHub"
    supports_read = True
    supports_write = False
    description = "Connect a user's GitHub account using OAuth redirect and consent."
    auth_type = "oauth2"

    async def connect(self, ctx: ConnectorContext) -> ConnectorResult:
        token = resolve_secret(ctx.config, "token", "GITHUB_TOKEN_ENV")
        if not token:
            return ConnectorResult(
                ok=False,
                status="needs_auth",
                error="GitHub authorization required. Use Login with GitHub in the Connectors panel.",
            )
        return ConnectorResult(ok=True, status="connected", message="GitHub token configured")

    async def disconnect(self, ctx: ConnectorContext) -> ConnectorResult:
        return ConnectorResult(ok=True, status="disconnected", message="GitHub connector disconnected")

    async def test(self, ctx: ConnectorContext) -> ConnectorResult:
        token = resolve_secret(ctx.config, "token", "GITHUB_TOKEN_ENV")
        if not token:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing GitHub token")

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "cortex-connectors",
        }
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get("https://api.github.com/user", headers=headers)
            if resp.status_code != 200:
                return ConnectorResult(ok=False, status="error", error=f"GitHub HTTP {resp.status_code}")
            payload = resp.json() if resp.text else {}
            return ConnectorResult(
                ok=True,
                status="ok",
                data={"login": payload.get("login"), "id": payload.get("id")},
                message="GitHub connectivity verified",
            )
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))

    async def list_items(self, ctx: ConnectorContext, cursor: Optional[str] = None) -> ConnectorResult:
        token = resolve_secret(ctx.config, "token", "GITHUB_TOKEN_ENV")
        if not token:
            return ConnectorResult(ok=False, status="needs_auth", error="Missing GitHub token")

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "cortex-connectors",
        }
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get("https://api.github.com/user/repos?per_page=20&sort=updated", headers=headers)
            if resp.status_code != 200:
                return ConnectorResult(ok=False, status="error", error=f"GitHub HTTP {resp.status_code}")
            repos = resp.json() if isinstance(resp.json(), list) else []
            items = [
                {
                    "id": r.get("id"),
                    "name": r.get("name"),
                    "full_name": r.get("full_name"),
                    "private": r.get("private"),
                    "url": r.get("html_url"),
                    "updated_at": r.get("updated_at"),
                }
                for r in repos if isinstance(r, dict)
            ]
            return ConnectorResult(ok=True, status="ok", data={"items": items, "cursor": cursor})
        except Exception as exc:
            return ConnectorResult(ok=False, status="error", error=str(exc))
