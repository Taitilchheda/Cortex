"""
Secret resolution helpers for connector providers.
Phase A keeps this simple with env refs and inline config fallback.
"""
from __future__ import annotations

import os
from typing import Any, Dict, Optional


def resolve_secret(config: Dict[str, Any], direct_key: str, env_key: str) -> Optional[str]:
    """
    Resolve a secret from connector config and/or environment variable.

    Priority:
    1) explicit value in config[direct_key]
    2) env var name in config[env_key]
    3) default env var matching env_key
    """
    direct = str(config.get(direct_key, "") or "").strip()
    if direct:
        return direct

    env_name = str(config.get(env_key, "") or "").strip() or env_key
    val = os.getenv(env_name, "").strip()
    return val or None


def redact_config(config: Dict[str, Any]) -> Dict[str, Any]:
    """Return config with obvious secret keys redacted for safe API output."""
    out: Dict[str, Any] = {}
    secret_markers = ("token", "secret", "password", "key", "credential")
    for key, value in config.items():
        lowered = str(key).lower()
        if any(marker in lowered for marker in secret_markers):
            out[key] = "***"
        else:
            out[key] = value
    return out
