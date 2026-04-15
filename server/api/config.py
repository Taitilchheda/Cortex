"""
Cortex v3 foundation: .cortex workspace bootstrap + config loader.
"""
import json
from pathlib import Path
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel


router = APIRouter(prefix="/cortex/config", tags=["cortex-config"])


PROJECT_ROOT = Path(__file__).resolve().parents[2]
CORTEX_DIR = PROJECT_ROOT / ".cortex"

CORTEX_LAYOUT = {
    "root": CORTEX_DIR,
    "memory": CORTEX_DIR / "memory",
    "memory_knowledge": CORTEX_DIR / "memory" / "knowledge",
    "agents": CORTEX_DIR / "agents",
    "skills": CORTEX_DIR / "skills",
    "plugins": CORTEX_DIR / "plugins",
    "environments": CORTEX_DIR / "environments",
    "environments_latest": CORTEX_DIR / "environments" / "latest.json",
    "config": CORTEX_DIR / "config.json",
}

DEFAULT_CONFIG: Dict[str, Any] = {
    "version": "1.0",
    "features": {
        "cloud_models": False,
        "openrouter": False,
        "checkpoints": False,
        "environments": True,
        "plugins": True,
        "skills": True,
    },
    "providers": {
        "openrouter": {"enabled": False, "api_key_env": "OPENROUTER_API_KEY"},
    },
    "routing": {
        "prefer_local": True,
        "allow_cloud_fallback": True,
    },
}


class ConfigUpdateRequest(BaseModel):
    config: Dict[str, Any]


def _merge_config(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _merge_config(merged[key], value)
        else:
            merged[key] = value
    return merged


def ensure_cortex_layout() -> Dict[str, str]:
    for key in ("root", "memory", "memory_knowledge", "agents", "skills", "plugins", "environments"):
        CORTEX_LAYOUT[key].mkdir(parents=True, exist_ok=True)

    cfg_path = CORTEX_LAYOUT["config"]
    if not cfg_path.exists():
        cfg_path.write_text(json.dumps(DEFAULT_CONFIG, indent=2), encoding="utf-8")

    latest_path = CORTEX_LAYOUT["environments_latest"]
    if not latest_path.exists():
        latest_path.write_text("{}", encoding="utf-8")

    return {k: str(v) for k, v in CORTEX_LAYOUT.items()}


def load_cortex_config() -> Dict[str, Any]:
    ensure_cortex_layout()
    cfg_path = CORTEX_LAYOUT["config"]
    try:
        raw = json.loads(cfg_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("config must be an object")
    except Exception:
        raw = {}
    return _merge_config(DEFAULT_CONFIG, raw)


def save_cortex_config(config: Dict[str, Any]) -> Dict[str, Any]:
    ensure_cortex_layout()
    final_config = _merge_config(DEFAULT_CONFIG, config)
    CORTEX_LAYOUT["config"].write_text(json.dumps(final_config, indent=2), encoding="utf-8")
    return final_config


def init_cortex_workspace() -> Dict[str, Any]:
    paths = ensure_cortex_layout()
    config = load_cortex_config()
    return {"paths": paths, "config": config}


def get_cortex_paths() -> Dict[str, Path]:
    ensure_cortex_layout()
    return dict(CORTEX_LAYOUT)


@router.get("")
async def get_config():
    return {"config": load_cortex_config()}


@router.post("")
async def update_config(req: ConfigUpdateRequest):
    try:
        saved = save_cortex_config(req.config)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to save config: {exc}")
    return {"status": "ok", "config": saved}


@router.get("/paths")
async def get_paths():
    return {"paths": {k: str(v) for k, v in get_cortex_paths().items()}}
