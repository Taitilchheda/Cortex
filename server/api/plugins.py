"""
Cortex v3 foundation: plugin discovery and minimal safe loader.
"""
from __future__ import annotations

import ast
import importlib.util
import traceback
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

from api.config import get_cortex_paths
from api.state import get_preference, set_preference


router = APIRouter(prefix="/plugins", tags=["plugins"])


PLUGINS_PREF_KEY = "plugins_enabled"
_plugin_registry: Dict[str, Dict[str, Any]] = {}
_host_app = None

SANDBOX_BLOCKED_IMPORTS = {
    "ctypes",
    "multiprocessing",
    "socket",
    "subprocess",
    "winreg",
}

SANDBOX_BLOCKED_CALLS = {
    "eval",
    "exec",
    "compile",
    "__import__",
    "os.system",
    "subprocess.Popen",
    "subprocess.run",
}


def _plugin_root() -> Path:
    return get_cortex_paths()["plugins"]


def _load_module(plugin_name: str, plugin_file: Path):
    spec = importlib.util.spec_from_file_location(f"cortex_plugin_{plugin_name}", str(plugin_file))
    if not spec or not spec.loader:
        raise RuntimeError("Failed to create import spec")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _extract_call_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = _extract_call_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    return ""


def _audit_plugin_file(plugin_file: Path) -> list[str]:
    try:
        source = plugin_file.read_text(encoding="utf-8")
    except Exception as exc:
        return [f"Failed to read plugin file: {exc}"]

    try:
        tree = ast.parse(source, filename=str(plugin_file))
    except Exception as exc:
        return [f"Failed to parse plugin file: {exc}"]

    violations: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in SANDBOX_BLOCKED_IMPORTS:
                    violations.append(f"Blocked import '{alias.name}'")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root in SANDBOX_BLOCKED_IMPORTS:
                violations.append(f"Blocked import-from '{node.module}'")
        elif isinstance(node, ast.Call):
            call_name = _extract_call_name(node.func)
            if call_name in SANDBOX_BLOCKED_CALLS:
                violations.append(f"Blocked call '{call_name}'")

    # Keep output deterministic and compact for UI display.
    return sorted(set(violations))


async def discover_plugins() -> Dict[str, Dict[str, Any]]:
    root = _plugin_root()
    enabled_map = await get_preference(PLUGINS_PREF_KEY, {})
    if not isinstance(enabled_map, dict):
        enabled_map = {}

    discovered: Dict[str, Dict[str, Any]] = {}
    for entry in root.iterdir():
        if not entry.is_dir():
            continue
        plugin_file = entry / "plugin.py"
        if not plugin_file.exists():
            continue

        plugin_name = entry.name
        violations = _audit_plugin_file(plugin_file)
        if violations:
            discovered[plugin_name] = {
                "name": plugin_name,
                "path": str(entry),
                "metadata": {},
                "enabled": False,
                "register_callable": False,
                "registered": False,
                "error": "Plugin blocked by sandbox policy",
                "sandbox_violations": violations,
                "module": None,
            }
            continue

        try:
            module = _load_module(plugin_name, plugin_file)
            metadata = getattr(module, "PLUGIN_METADATA", {})
            register_fn = getattr(module, "register", None)
            discovered[plugin_name] = {
                "name": plugin_name,
                "path": str(entry),
                "metadata": metadata if isinstance(metadata, dict) else {},
                "enabled": bool(enabled_map.get(plugin_name, True)),
                "register_callable": callable(register_fn),
                "registered": False,
                "error": None,
                "sandbox_violations": [],
                "module": module,
            }
        except Exception as exc:
            discovered[plugin_name] = {
                "name": plugin_name,
                "path": str(entry),
                "metadata": {},
                "enabled": False,
                "register_callable": False,
                "registered": False,
                "error": f"{exc}\n{traceback.format_exc(limit=1)}",
                "sandbox_violations": [],
                "module": None,
            }

    _plugin_registry.clear()
    _plugin_registry.update(discovered)
    print(f"[plugins] discovered {len(_plugin_registry)} plugin(s)")
    return _plugin_registry


async def initialize_plugins(app=None) -> Dict[str, Dict[str, Any]]:
    global _host_app
    if app is not None:
        _host_app = app

    registry = await discover_plugins()
    target_app = _host_app

    if target_app is None:
        return registry

    for plugin_name, item in registry.items():
        if not item.get("enabled"):
            continue
        module = item.get("module")
        if not module:
            continue
        register_fn = getattr(module, "register", None)
        if not callable(register_fn):
            continue

        try:
            register_fn(target_app)
            item["registered"] = True
            print(f"[plugins] registered: {plugin_name}")
        except Exception as exc:
            item["registered"] = False
            item["error"] = str(exc)
            print(f"[plugins] failed to register {plugin_name}: {exc}")
    return registry


async def _set_plugin_enabled(plugin_name: str, enabled: bool) -> None:
    enabled_map = await get_preference(PLUGINS_PREF_KEY, {})
    if not isinstance(enabled_map, dict):
        enabled_map = {}
    enabled_map[plugin_name] = enabled
    await set_preference(PLUGINS_PREF_KEY, enabled_map)


@router.get("")
async def list_plugins():
    if not _plugin_registry:
        await discover_plugins()
    items = []
    for plugin_name, item in _plugin_registry.items():
        items.append(
            {
                "name": plugin_name,
                "path": item.get("path"),
                "enabled": item.get("enabled", False),
                "registered": item.get("registered", False),
                "register_callable": item.get("register_callable", False),
                "metadata": item.get("metadata", {}),
                "error": item.get("error"),
                "sandbox_violations": item.get("sandbox_violations", []),
            }
        )
    return {"plugins": items}


@router.get("/policy")
async def plugin_policy():
    return {
        "blocked_imports": sorted(SANDBOX_BLOCKED_IMPORTS),
        "blocked_calls": sorted(SANDBOX_BLOCKED_CALLS),
    }


@router.post("/reload")
async def reload_plugins():
    registry = await initialize_plugins()
    return {
        "status": "reloaded",
        "count": len(registry),
        "registered": len([p for p in registry.values() if p.get("registered")]),
    }


@router.post("/{plugin_name}/enable")
async def enable_plugin(plugin_name: str):
    if plugin_name not in _plugin_registry:
        await discover_plugins()
    if plugin_name not in _plugin_registry:
        raise HTTPException(status_code=404, detail="Plugin not found")

    await _set_plugin_enabled(plugin_name, True)
    _plugin_registry[plugin_name]["enabled"] = True
    await initialize_plugins()
    return {"status": "enabled", "plugin": plugin_name}


@router.post("/{plugin_name}/disable")
async def disable_plugin(plugin_name: str):
    if plugin_name not in _plugin_registry:
        await discover_plugins()
    if plugin_name not in _plugin_registry:
        raise HTTPException(status_code=404, detail="Plugin not found")

    await _set_plugin_enabled(plugin_name, False)
    _plugin_registry[plugin_name]["enabled"] = False
    return {"status": "disabled", "plugin": plugin_name}
