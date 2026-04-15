"""
Connector provider registry and runtime lookup.
"""
from __future__ import annotations

from typing import Dict, List

from connectors.base import ConnectorProvider
from connectors.providers import (
    GitHubConnector,
    GoogleDriveConnector,
    MCPConnector,
    ColabConnector,
    KaggleConnector,
    CustomAgentConnector,
)


_PROVIDER_MAP: Dict[str, ConnectorProvider] = {
    "github": GitHubConnector(),
    "google_drive": GoogleDriveConnector(),
    "colab": ColabConnector(),
    "kaggle": KaggleConnector(),
    "custom_agent": CustomAgentConnector(),
    "mcp": MCPConnector(),
}


def list_provider_metadata() -> List[dict]:
    out = []
    for key, provider in _PROVIDER_MAP.items():
        out.append(
            {
                "key": key,
                "name": provider.name,
                "description": provider.description,
                "auth_type": provider.auth_type,
                "supports_read": provider.supports_read,
                "supports_write": provider.supports_write,
                "capabilities": provider.capabilities,
                "config_fields": provider.config_fields,
            }
        )
    return out


def get_provider(key: str) -> ConnectorProvider | None:
    return _PROVIDER_MAP.get(str(key or "").strip().lower())
