"""
Connector base contracts and shared runtime helpers.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class ConnectorContext:
    connector_id: str
    connector_type: str
    mode: str = "read_only"
    config: Dict[str, Any] = field(default_factory=dict)


@dataclass
class ConnectorResult:
    ok: bool
    status: str
    message: str = ""
    data: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


class ConnectorProvider(ABC):
    """Abstract provider interface for external system connectors."""

    key: str = "base"
    name: str = "Base Connector"
    supports_read: bool = True
    supports_write: bool = False

    @abstractmethod
    async def connect(self, ctx: ConnectorContext) -> ConnectorResult:
        raise NotImplementedError

    @abstractmethod
    async def disconnect(self, ctx: ConnectorContext) -> ConnectorResult:
        raise NotImplementedError

    @abstractmethod
    async def test(self, ctx: ConnectorContext) -> ConnectorResult:
        raise NotImplementedError

    async def list_items(self, ctx: ConnectorContext, cursor: Optional[str] = None) -> ConnectorResult:
        return ConnectorResult(ok=True, status="ok", data={"items": [], "cursor": cursor})

    async def read_item(self, ctx: ConnectorContext, item_id: str) -> ConnectorResult:
        return ConnectorResult(ok=False, status="not_supported", error="read_item is not implemented")

    async def write_item(self, ctx: ConnectorContext, payload: Dict[str, Any]) -> ConnectorResult:
        if not self.supports_write:
            return ConnectorResult(ok=False, status="denied", error="Provider is read-only")
        return ConnectorResult(ok=False, status="not_supported", error="write_item is not implemented")

    @property
    def capabilities(self) -> List[str]:
        caps = ["connect", "disconnect", "test", "list_items", "read_item"]
        if self.supports_write:
            caps.append("write_item")
        return caps
