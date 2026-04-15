"""
Cortex v3 foundation scaffold: cloud provider model catalog helpers.
"""
from __future__ import annotations

import os
from typing import Any, Dict, List

import httpx


OLLAMA_LOCAL_BASE = "http://localhost:11434"
OPENROUTER_BASE = "https://openrouter.ai/api/v1"
OLLAMA_REGISTRY_BASE = "https://registry.ollama.ai/v1"

CLOUD_PROVIDERS = {
    "ollama_cloud": {
        "base_url": f"{OLLAMA_LOCAL_BASE}/v1",
        "quota_endpoint": "https://ollama.ai/api/account/quota",
    },
    "openrouter": {
        "base_url": OPENROUTER_BASE,
        "key_env": "OPENROUTER_API_KEY",
    },
}


def is_cloud_model(model: Dict[str, Any]) -> bool:
    name = str(model.get("name", ""))
    size = model.get("size", 1)
    return size == 0 or ":cloud" in name or model.get("source") == "cloud"


async def fetch_ollama_tag_models() -> List[Dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{OLLAMA_LOCAL_BASE}/api/tags")
            if resp.status_code != 200:
                return []
            data = resp.json()
            return data.get("models", [])
    except Exception:
        return []


async def fetch_ollama_registry_models() -> List[Dict[str, Any]]:
    """Fetch public Ollama catalog entries usable as cloud candidates."""
    try:
        async with httpx.AsyncClient(timeout=12) as client:
            resp = await client.get(f"{OLLAMA_REGISTRY_BASE}/models")
            if resp.status_code != 200:
                return []
            payload = resp.json()
            rows = payload.get("data", []) if isinstance(payload, dict) else []
            if not isinstance(rows, list):
                return []
            return [r for r in rows if isinstance(r, dict)]
    except Exception:
        return []


async def fetch_ollama_cloud_models() -> List[Dict[str, Any]]:
    models = await fetch_ollama_tag_models()
    out: List[Dict[str, Any]] = []
    for model in models:
        if is_cloud_model(model):
            row = dict(model)
            row["source"] = "cloud"
            row["provider"] = "ollama_cloud"
            row["vram_gb"] = 0
            out.append(row)
    return out


async def fetch_openrouter_models(api_key: str | None = None) -> List[Dict[str, Any]]:
    key = api_key or os.getenv(CLOUD_PROVIDERS["openrouter"]["key_env"], "")
    headers: Dict[str, str] = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{OPENROUTER_BASE}/models", headers=headers)
            if resp.status_code != 200:
                return []
            payload = resp.json()
            models = payload.get("data", [])
            out: List[Dict[str, Any]] = []
            for model in models:
                out.append(
                    {
                        "name": model.get("id"),
                        "source": "openrouter",
                        "provider": "openrouter",
                        "context_length": model.get("context_length"),
                        "pricing": model.get("pricing", {}),
                        "vram_gb": 0,
                        "details": model,
                    }
                )
            return out
    except Exception:
        return []


async def fetch_unified_model_catalog() -> List[Dict[str, Any]]:
    tag_models = await fetch_ollama_tag_models()
    registry_models = await fetch_ollama_registry_models()
    local_rows: List[Dict[str, Any]] = []
    cloud_rows: List[Dict[str, Any]] = []

    for model in tag_models:
        row = dict(model)
        if is_cloud_model(model):
            row["source"] = "cloud"
            row["provider"] = "ollama_cloud"
            row["vram_gb"] = 0
            cloud_rows.append(row)
        else:
            size = float(row.get("size") or 0)
            row["source"] = "local"
            row["provider"] = "ollama"
            row["vram_gb"] = round((size / 1e9) * 1.15, 2) if size else None
            local_rows.append(row)

    local_names = {str(r.get("name", "")).strip().lower() for r in local_rows}
    cloud_names = {str(r.get("name", "")).strip().lower() for r in cloud_rows}
    for model in registry_models:
        model_id = str(model.get("id") or "").strip()
        if not model_id:
            continue
        key = model_id.lower()
        if key in local_names or key in cloud_names:
            continue
        cloud_rows.append(
            {
                "id": model_id,
                "name": model_id,
                "source": "cloud",
                "provider": "ollama_cloud",
                "size": 0,
                "size_bytes": 0,
                "vram_gb": 0,
                "context_length": model.get("context_length"),
                "details": {
                    **model,
                    "catalog_only": True,
                    "catalog_source": "ollama_registry",
                },
            }
        )

    openrouter_rows = await fetch_openrouter_models()
    return local_rows + cloud_rows + openrouter_rows
