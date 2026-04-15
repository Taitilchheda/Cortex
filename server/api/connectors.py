"""
Connectors API (Phase A foundation).
"""
from __future__ import annotations

import json
import os
import secrets
import hashlib
import base64
import hmac
import time
import uuid
import urllib.parse
import re
from typing import Any, Dict, List, Optional

import aiosqlite
import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from api.config import load_cortex_config, save_cortex_config
from api.state import DB_PATH
from connectors.base import ConnectorContext
from connectors.registry import get_provider, list_provider_metadata
from connectors.secrets import redact_config
from connectors.sync import run_sync


router = APIRouter(prefix="/connectors", tags=["connectors"])
_oauth_states: Dict[str, Dict[str, Any]] = {}
_OAUTH_STATE_TTL_SECONDS = 600


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


class ConnectorOAuthStartRequest(BaseModel):
    connector_id: str
    provider: str
    return_url: Optional[str] = None


class OAuthServerSetupRequest(BaseModel):
    provider: str
    enabled: Optional[bool] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None


def _base64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _new_code_verifier() -> str:
    return _base64url(secrets.token_bytes(48))


def _pkce_challenge(code_verifier: str) -> str:
    return _base64url(hashlib.sha256(code_verifier.encode("utf-8")).digest())


def _cleanup_oauth_states() -> None:
    now = time.time()
    expired = [
        key for key, data in _oauth_states.items()
        if now - float(data.get("created_at", 0)) > _OAUTH_STATE_TTL_SECONDS
    ]
    for key in expired:
        _oauth_states.pop(key, None)


def _state_secret() -> str:
    return str(os.getenv("CORTEX_OAUTH_STATE_SECRET") or "cortex-local-oauth-state-secret")


def _encode_oauth_state(payload: Dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    body = _base64url(raw)
    sig = _base64url(hmac.new(_state_secret().encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest())
    return f"{body}.{sig}"


def _decode_oauth_state(state: str) -> Optional[Dict[str, Any]]:
    token = str(state or "").strip()
    if not token or "." not in token:
        return None
    body, sig = token.split(".", 1)
    expected = _base64url(hmac.new(_state_secret().encode("utf-8"), body.encode("utf-8"), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        padding = "=" * (-len(body) % 4)
        decoded = base64.urlsafe_b64decode((body + padding).encode("utf-8")).decode("utf-8")
        payload = json.loads(decoded)
        if not isinstance(payload, dict):
            return None
        created_at = float(payload.get("created_at", 0))
        if not created_at or (time.time() - created_at) > _OAUTH_STATE_TTL_SECONDS:
            return None
        return payload
    except Exception:
        return None


def _external_base_url(request: Request) -> str:
    forwarded_proto = str(request.headers.get("x-forwarded-proto") or "").strip()
    forwarded_host = str(request.headers.get("x-forwarded-host") or "").strip()
    if forwarded_proto and forwarded_host:
        return f"{forwarded_proto}://{forwarded_host}"
    return str(request.base_url).rstrip("/")


def _safe_return_url(candidate: Optional[str], request: Request) -> str:
    raw = str(candidate or "").strip()
    if raw.startswith("http://") or raw.startswith("https://"):
        return raw
    origin = str(request.headers.get("origin") or "").strip()
    if origin.startswith("http://") or origin.startswith("https://"):
        return f"{origin}/?panel=connectors"
    return "http://localhost:3001/?panel=connectors"


def _default_return_url() -> str:
    return "http://localhost:3001/?panel=connectors"


def _append_query_params(url: str, params: Dict[str, str]) -> str:
    parsed = urllib.parse.urlparse(url)
    existing = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    for key, value in params.items():
        existing[key] = [value]
    query = urllib.parse.urlencode(existing, doseq=True)
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, query, parsed.fragment))


def _provider_config(provider_key: str) -> Dict[str, Any]:
    key = str(provider_key or "").strip().lower()
    try:
        cfg = load_cortex_config()
        providers = cfg.get("providers") if isinstance(cfg, dict) else None
        provider_cfg = providers.get(key) if isinstance(providers, dict) else None
        if isinstance(provider_cfg, dict):
            return provider_cfg
    except Exception:
        pass
    return {}


def _is_valid_github_client_id(client_id: str) -> bool:
    value = str(client_id or "").strip()
    if not value:
        return False
    if "@" in value:
        return False
    return bool(re.fullmatch(r"Iv1\.[A-Za-z0-9_-]{8,200}", value))


def _is_valid_google_client_id(client_id: str) -> bool:
    value = str(client_id or "").strip()
    if not value:
        return False
    return bool(re.fullmatch(r"[0-9]+-[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com", value))


def _extract_google_credentials(candidate: str) -> Dict[str, str]:
    raw = str(candidate or "").strip()
    if not raw:
        return {"client_id": "", "client_secret": ""}

    if not raw.startswith("{"):
        return {"client_id": raw, "client_secret": ""}

    try:
        parsed = json.loads(raw)
    except Exception:
        return {"client_id": raw, "client_secret": ""}

    if not isinstance(parsed, dict):
        return {"client_id": raw, "client_secret": ""}

    source = parsed.get("web") if isinstance(parsed.get("web"), dict) else None
    if source is None and isinstance(parsed.get("installed"), dict):
        source = parsed.get("installed")
    if source is None:
        source = parsed

    client_id = str(source.get("client_id") or "").strip() if isinstance(source, dict) else ""
    client_secret = str(source.get("client_secret") or "").strip() if isinstance(source, dict) else ""
    if client_id:
        return {"client_id": client_id, "client_secret": client_secret}
    return {"client_id": raw, "client_secret": ""}


def _oauth_server_setup_snapshot(provider_key: str) -> Dict[str, Any]:
    key = str(provider_key or "").strip().lower()
    cfg = _provider_config(key)
    client_id_cfg = str(cfg.get("oauth_client_id") or "").strip()
    client_secret_cfg = str(cfg.get("oauth_client_secret") or "").strip()
    status = _oauth_status(key)
    enabled = cfg.get("enabled")
    if not isinstance(enabled, bool):
        enabled = True
    return {
        "provider": key,
        "enabled": bool(enabled),
        "has_client_id": bool(client_id_cfg or _resolve_oauth_client(key, "client_id")),
        "has_client_secret": bool(client_secret_cfg or _resolve_oauth_client(key, "client_secret")),
        "oauth_ready": bool(status.get("oauth_ready")),
        "oauth_setup_message": str(status.get("oauth_setup_message") or ""),
    }


def _is_provider_enabled(provider_key: str) -> bool:
    provider_cfg = _provider_config(provider_key)
    enabled = provider_cfg.get("enabled")
    if isinstance(enabled, bool):
        return enabled
    return True


def _resolve_oauth_client(provider_key: str, kind: str) -> Optional[str]:
    key = str(provider_key or "").strip().lower()
    role = str(kind or "").strip().lower()

    env_aliases: List[str] = []
    if key == "github" and role == "client_id":
        env_aliases = ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_CLIENT_ID"]
    elif key == "github" and role == "client_secret":
        env_aliases = ["GITHUB_OAUTH_CLIENT_SECRET", "GITHUB_CLIENT_SECRET"]
    elif key == "google_drive" and role == "client_id":
        env_aliases = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_CLIENT_ID"]
    elif key == "google_drive" and role == "client_secret":
        env_aliases = ["GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET"]

    for env_key in env_aliases:
        from_env = str(os.getenv(env_key) or "").strip()
        if from_env:
            return from_env

    provider_cfg = _provider_config(key)
    cfg_key = "oauth_client_id" if role == "client_id" else "oauth_client_secret"
    from_cfg = str(provider_cfg.get(cfg_key) or "").strip()
    return from_cfg or None


def _oauth_status(provider_key: str) -> Dict[str, Any]:
    key = str(provider_key or "").strip().lower()
    if key == "github":
        enabled = _is_provider_enabled(key)
        client_id = str(_resolve_oauth_client(key, "client_id") or "").strip()
        valid_client = _is_valid_github_client_id(client_id)
        configured = enabled and valid_client
        return {
            "oauth_ready": configured,
            "oauth_setup_message": (
                "GitHub sign-in is turned off by server config."
                if not enabled
                else (
                    "GitHub sign-in credentials are not configured on this server."
                    if not client_id
                    else ("GitHub OAuth Client ID format is invalid. Use the OAuth app client ID (not email)." if not valid_client else "")
                )
            ),
        }
    if key == "google_drive":
        enabled = _is_provider_enabled(key)
        client_id = str(_resolve_oauth_client(key, "client_id") or "").strip()
        valid_client = _is_valid_google_client_id(client_id)
        configured = enabled and valid_client
        return {
            "oauth_ready": configured,
            "oauth_setup_message": (
                "Google Drive sign-in is turned off by server config."
                if not enabled
                else (
                    "Google Drive sign-in credentials are not configured on this server."
                    if not client_id
                    else ("Google Drive OAuth Client ID format is invalid. Use a Google OAuth Web Client ID." if not valid_client else "")
                )
            ),
        }
    return {"oauth_ready": True, "oauth_setup_message": ""}


async def _exchange_oauth_code(
    provider_key: str,
    *,
    code: str,
    code_verifier: str,
    redirect_uri: str,
    state: str,
) -> Dict[str, Any]:
    if provider_key == "github":
        client_id = _resolve_oauth_client(provider_key, "client_id")
        if not client_id:
            raise ValueError("GitHub OAuth client_id is missing")

        payload: Dict[str, Any] = {
            "client_id": client_id,
            "code": code,
            "redirect_uri": redirect_uri,
            "state": state,
            "code_verifier": code_verifier,
        }
        client_secret = _resolve_oauth_client(provider_key, "client_secret")
        if client_secret:
            payload["client_secret"] = client_secret

        headers = {"Accept": "application/json"}
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post("https://github.com/login/oauth/access_token", data=payload, headers=headers)
        if resp.status_code >= 400:
            raise ValueError(f"GitHub token exchange failed with HTTP {resp.status_code}")
        data = resp.json() if resp.text else {}
        if data.get("error"):
            raise ValueError(str(data.get("error_description") or data.get("error")))
        return data

    if provider_key == "google_drive":
        client_id = _resolve_oauth_client(provider_key, "client_id")
        if not client_id:
            raise ValueError("Google OAuth client_id is missing")

        payload: Dict[str, Any] = {
            "client_id": client_id,
            "code": code,
            "code_verifier": code_verifier,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
        client_secret = _resolve_oauth_client(provider_key, "client_secret")
        if client_secret:
            payload["client_secret"] = client_secret

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post("https://oauth2.googleapis.com/token", data=payload)
        if resp.status_code >= 400:
            raise ValueError(f"Google token exchange failed with HTTP {resp.status_code}")
        data = resp.json() if resp.text else {}
        if data.get("error"):
            if isinstance(data["error"], str):
                raise ValueError(data["error"])
            if isinstance(data["error"], dict):
                raise ValueError(str(data["error"].get("message") or data["error"]))
        return data

    raise ValueError(f"OAuth not supported for provider: {provider_key}")


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
    providers = list_provider_metadata()
    enriched = []
    for provider in providers:
        key = str(provider.get("key") or "").strip().lower()
        if str(provider.get("auth_type") or "") == "oauth2":
            enriched.append({**provider, **_oauth_status(key)})
        else:
            enriched.append({**provider, "oauth_ready": True, "oauth_setup_message": ""})
    return {"providers": enriched}


@router.get("/oauth/server-setup")
async def get_oauth_server_setup():
    return {
        "providers": {
            "github": _oauth_server_setup_snapshot("github"),
            "google_drive": _oauth_server_setup_snapshot("google_drive"),
        }
    }


@router.post("/oauth/server-setup")
async def update_oauth_server_setup(req: OAuthServerSetupRequest):
    provider_key = str(req.provider or "").strip().lower()
    if provider_key not in {"github", "google_drive"}:
        raise HTTPException(status_code=400, detail=f"Unsupported OAuth provider: {provider_key}")

    cfg = load_cortex_config()
    providers = cfg.get("providers") if isinstance(cfg, dict) else None
    if not isinstance(providers, dict):
        providers = {}

    provider_cfg = providers.get(provider_key)
    if not isinstance(provider_cfg, dict):
        provider_cfg = {}

    if req.enabled is not None:
        provider_cfg["enabled"] = bool(req.enabled)
    if provider_key == "google_drive":
        if req.client_id is not None:
            extracted = _extract_google_credentials(req.client_id)
            normalized_client_id = str(extracted.get("client_id") or "").strip()
            if normalized_client_id and not _is_valid_google_client_id(normalized_client_id):
                raise HTTPException(
                    status_code=400,
                    detail="Invalid Google OAuth Client ID. Paste a valid Web Client ID (....apps.googleusercontent.com) or full credentials JSON.",
                )
            provider_cfg["oauth_client_id"] = normalized_client_id

            incoming_secret = str(req.client_secret or "").strip() if req.client_secret is not None else ""
            extracted_secret = str(extracted.get("client_secret") or "").strip()
            if req.client_secret is not None:
                provider_cfg["oauth_client_secret"] = incoming_secret
            elif extracted_secret:
                provider_cfg["oauth_client_secret"] = extracted_secret
        elif req.client_secret is not None:
            provider_cfg["oauth_client_secret"] = str(req.client_secret or "").strip()
    else:
        if req.client_id is not None:
            normalized_client_id = str(req.client_id or "").strip()
            if normalized_client_id and not _is_valid_github_client_id(normalized_client_id):
                raise HTTPException(
                    status_code=400,
                    detail="Invalid GitHub OAuth Client ID. Use the OAuth app client ID (for example Iv1....), not an email.",
                )
            provider_cfg["oauth_client_id"] = normalized_client_id
        if req.client_secret is not None:
            provider_cfg["oauth_client_secret"] = str(req.client_secret or "").strip()

    providers[provider_key] = provider_cfg
    cfg["providers"] = providers
    save_cortex_config(cfg)

    return {
        "status": "ok",
        "provider": _oauth_server_setup_snapshot(provider_key),
    }


@router.post("/oauth/start")
async def connector_oauth_start(req: ConnectorOAuthStartRequest, request: Request):
    await init_connectors_db()
    _cleanup_oauth_states()

    provider_key = str(req.provider or "").strip().lower()
    if provider_key not in {"github", "google_drive"}:
        raise HTTPException(status_code=400, detail=f"OAuth redirect is not supported for provider: {provider_key}")

    connector = await _fetch_connector(req.connector_id)
    if not connector:
        raise HTTPException(status_code=404, detail="Connector not found")
    if str(connector.get("type") or "").strip().lower() != provider_key:
        raise HTTPException(status_code=400, detail="Connector/provider mismatch")

    if not _is_provider_enabled(provider_key):
        status = _oauth_status(provider_key)
        raise HTTPException(
            status_code=400,
            detail=status.get("oauth_setup_message") or "OAuth sign-in is disabled for this provider.",
        )
    if not _resolve_oauth_client(provider_key, "client_id"):
        status = _oauth_status(provider_key)
        raise HTTPException(
            status_code=400,
            detail=status.get("oauth_setup_message") or "OAuth sign-in is not enabled on this server yet.",
        )
    if provider_key == "github":
        cid = str(_resolve_oauth_client(provider_key, "client_id") or "").strip()
        if not _is_valid_github_client_id(cid):
            raise HTTPException(
                status_code=400,
                detail="GitHub OAuth Client ID is invalid. Use the OAuth app client ID (not email).",
            )
    if provider_key == "google_drive":
        cid = str(_resolve_oauth_client(provider_key, "client_id") or "").strip()
        if not _is_valid_google_client_id(cid):
            raise HTTPException(
                status_code=400,
                detail="Google OAuth Client ID is invalid. Use a Web Client ID ending with .apps.googleusercontent.com.",
            )

    state = secrets.token_urlsafe(24)
    code_verifier = _new_code_verifier()
    code_challenge = _pkce_challenge(code_verifier)
    redirect_uri = f"{_external_base_url(request)}/connectors/oauth/callback"
    return_url = _safe_return_url(req.return_url, request)

    state_payload = {
        "provider": provider_key,
        "connector_id": req.connector_id,
        "code_verifier": code_verifier,
        "redirect_uri": redirect_uri,
        "return_url": return_url,
        "created_at": time.time(),
    }
    state = _encode_oauth_state(state_payload)

    _oauth_states[state] = dict(state_payload)

    if provider_key == "github":
        mode = str(connector.get("mode") or "read_only").strip().lower()
        scope = "read:user repo" if mode == "read_write" else "read:user"
        params = {
            "client_id": _resolve_oauth_client(provider_key, "client_id") or "",
            "redirect_uri": redirect_uri,
            "scope": scope,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        auth_url = "https://github.com/login/oauth/authorize?" + urllib.parse.urlencode(params)
    else:
        mode = str(connector.get("mode") or "read_only").strip().lower()
        scope = (
            "https://www.googleapis.com/auth/drive.file"
            if mode == "read_write"
            else "https://www.googleapis.com/auth/drive.metadata.readonly"
        )
        params = {
            "client_id": _resolve_oauth_client(provider_key, "client_id") or "",
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": scope,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "access_type": "offline",
            "include_granted_scopes": "true",
            "prompt": "consent",
        }
        auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)

    return {
        "auth_url": auth_url,
        "provider": provider_key,
        "connector_id": req.connector_id,
    }


@router.get("/oauth/callback")
async def connector_oauth_callback(
    request: Request,
    state: Optional[str] = None,
    code: Optional[str] = None,
    error: Optional[str] = None,
):
    await init_connectors_db()
    _cleanup_oauth_states()

    resolved_state = str(state or "").strip()
    pending = _oauth_states.pop(resolved_state, None) if resolved_state else None
    if not pending and resolved_state:
        pending = _decode_oauth_state(resolved_state)
    if not pending:
        return RedirectResponse(
            url=_append_query_params(
                _safe_return_url(None, request) or _default_return_url(),
                {
                    "connector_oauth": "error",
                    "provider": "unknown",
                    "message": "invalid_or_expired_state_start_login_again",
                },
            )
        )

    provider_key = str(pending.get("provider") or "")
    connector_id = str(pending.get("connector_id") or "")
    return_url = str(pending.get("return_url") or "http://localhost:3001/?panel=connectors")

    if error:
        return RedirectResponse(
            url=_append_query_params(
                return_url,
                {
                    "connector_oauth": "error",
                    "provider": provider_key,
                    "message": str(error),
                },
            )
        )
    if not code:
        return RedirectResponse(
            url=_append_query_params(
                return_url,
                {
                    "connector_oauth": "error",
                    "provider": provider_key,
                    "message": "missing_code",
                },
            )
        )

    connector = await _fetch_connector(connector_id)
    if not connector:
        return RedirectResponse(
            url=_append_query_params(
                return_url,
                {
                    "connector_oauth": "error",
                    "provider": provider_key,
                    "message": "connector_not_found",
                },
            )
        )

    started = time.time()
    try:
        token_payload = await _exchange_oauth_code(
            provider_key,
            code=code,
            code_verifier=str(pending.get("code_verifier") or ""),
            redirect_uri=str(pending.get("redirect_uri") or ""),
            state=resolved_state,
        )
        access_token = str(token_payload.get("access_token") or "").strip()
        if not access_token:
            raise ValueError("Token exchange succeeded but no access token was returned")

        config = dict(connector.get("config") or {})
        if provider_key == "github":
            config["token"] = access_token
        else:
            config["access_token"] = access_token

        refresh = str(token_payload.get("refresh_token") or "").strip()
        if refresh:
            config["refresh_token"] = refresh
        expires_in = token_payload.get("expires_in")
        if isinstance(expires_in, (int, float)):
            config["token_expires_at"] = int(time.time() + float(expires_in))
        if token_payload.get("scope"):
            config["granted_scope"] = token_payload.get("scope")

        async with aiosqlite.connect(DB_PATH) as db:
            await db.execute(
                "UPDATE connectors SET config_json = ?, status = ?, updated_at = ? WHERE id = ?",
                (json.dumps(config), "connected", time.time(), connector_id),
            )
            await db.commit()

        await _write_run(
            connector_id,
            "oauth_connect",
            "success",
            started,
            result={"provider": provider_key, "status": "connected"},
        )
        return RedirectResponse(
            url=_append_query_params(
                return_url,
                {
                    "connector_oauth": "success",
                    "provider": provider_key,
                },
            )
        )
    except Exception as exc:
        await _write_run(
            connector_id,
            "oauth_connect",
            "failed",
            started,
            error=str(exc),
            result={"provider": provider_key},
        )
        return RedirectResponse(
            url=_append_query_params(
                return_url,
                {
                    "connector_oauth": "error",
                    "provider": provider_key,
                    "message": str(exc),
                },
            )
        )


@router.get("")
async def list_connectors():
    await init_connectors_db()
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM connectors ORDER BY updated_at DESC")
        oauth_singleton_types = {"github", "google_drive"}
        seen_singleton_types: set[str] = set()
        rows = []
        async for row in cursor:
            item = dict(row)
            connector_type = str(item.get("type") or "").strip().lower()
            if connector_type in oauth_singleton_types:
                if connector_type in seen_singleton_types:
                    continue
                seen_singleton_types.add(connector_type)
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

    provider_type = str(req.type or "").strip().lower()
    if provider_type in {"github", "google_drive"}:
        async with aiosqlite.connect(DB_PATH) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT id FROM connectors WHERE LOWER(type) = ? ORDER BY updated_at DESC LIMIT 1",
                (provider_type,),
            )
            existing = await cursor.fetchone()
            if existing and existing[0]:
                connector_id = str(existing[0])
                await db.execute(
                    """
                    UPDATE connectors
                    SET name = ?, mode = ?, config_json = ?, scopes_json = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        req.name,
                        req.mode,
                        json.dumps(req.config),
                        json.dumps(req.scopes),
                        time.time(),
                        connector_id,
                    ),
                )
                await db.commit()
                updated = await _fetch_connector(connector_id)
                return {"connector": {**(updated or {}), "config": redact_config((updated or {}).get("config", {}))}}

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
