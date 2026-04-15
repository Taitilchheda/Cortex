"""
Cortex v3 foundation: skill auto-discovery and invocation runtime.
"""
from __future__ import annotations

import importlib.util
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Callable, Optional

from api.config import get_cortex_paths
from api.state import get_preference, set_preference


SKILLS_PREF_KEY = "skills_enabled"
_skill_registry: Dict[str, "SkillDefinition"] = {}


@dataclass
class SkillContext:
    env: Dict[str, str] = field(default_factory=dict)
    session_id: Optional[str] = None
    project_path: Optional[str] = None
    written_files: Dict[str, str] = field(default_factory=dict)
    model: Optional[str] = None
    memory: list = field(default_factory=list)


@dataclass
class SkillResult:
    success: bool
    output: Dict[str, Any] = field(default_factory=dict)
    events: list = field(default_factory=list)
    error: Optional[str] = None


@dataclass
class SkillDefinition:
    name: str
    description: str
    module_path: str
    enabled: bool
    run_callable: Optional[Callable[..., Any]]
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


def _skills_root() -> Path:
    return get_cortex_paths()["skills"]


def _load_skill_module(module_name: str, module_path: Path):
    spec = importlib.util.spec_from_file_location(module_name, str(module_path))
    if not spec or not spec.loader:
        raise RuntimeError("Failed to build module spec")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def discover_skills() -> Dict[str, SkillDefinition]:
    root = _skills_root()
    enabled_map = await get_preference(SKILLS_PREF_KEY, {})
    if not isinstance(enabled_map, dict):
        enabled_map = {}

    discovered: Dict[str, SkillDefinition] = {}
    for skill_file in root.glob("*.py"):
        if skill_file.name.startswith("_"):
            continue

        module_name = f"cortex_skill_{skill_file.stem}"
        skill_name = skill_file.stem

        try:
            module = _load_skill_module(module_name, skill_file)
            metadata = getattr(module, "SKILL_METADATA", {})
            if isinstance(metadata, dict) and metadata.get("name"):
                skill_name = str(metadata["name"])

            description = ""
            if isinstance(metadata, dict):
                description = str(metadata.get("description", ""))

            run_callable = getattr(module, "run", None)
            discovered[skill_name] = SkillDefinition(
                name=skill_name,
                description=description,
                module_path=str(skill_file),
                enabled=bool(enabled_map.get(skill_name, True)),
                run_callable=run_callable if callable(run_callable) else None,
                metadata=metadata if isinstance(metadata, dict) else {},
                error=None if callable(run_callable) else "run(context, ...) callable not found",
            )
        except Exception as exc:
            discovered[skill_name] = SkillDefinition(
                name=skill_name,
                description="",
                module_path=str(skill_file),
                enabled=False,
                run_callable=None,
                metadata={},
                error=str(exc),
            )

    _skill_registry.clear()
    _skill_registry.update(discovered)
    print(f"[skills] discovered {len(_skill_registry)} skill(s)")
    return _skill_registry


async def init_skill_registry() -> Dict[str, SkillDefinition]:
    return await discover_skills()


def list_skill_definitions() -> Dict[str, SkillDefinition]:
    return dict(_skill_registry)


async def list_skills() -> list:
    if not _skill_registry:
        await discover_skills()
    return [
        {
            "name": s.name,
            "description": s.description,
            "enabled": s.enabled,
            "module_path": s.module_path,
            "has_runner": bool(s.run_callable),
            "metadata": s.metadata,
            "error": s.error,
        }
        for s in _skill_registry.values()
    ]


async def set_skill_enabled(skill_name: str, enabled: bool) -> bool:
    if not _skill_registry:
        await discover_skills()
    if skill_name not in _skill_registry:
        return False

    enabled_map = await get_preference(SKILLS_PREF_KEY, {})
    if not isinstance(enabled_map, dict):
        enabled_map = {}
    enabled_map[skill_name] = enabled
    await set_preference(SKILLS_PREF_KEY, enabled_map)

    _skill_registry[skill_name].enabled = enabled
    return True


async def run_skill(skill_name: str, context: SkillContext, **kwargs) -> SkillResult:
    if not _skill_registry:
        await discover_skills()

    skill = _skill_registry.get(skill_name)
    if not skill:
        return SkillResult(success=False, error=f"Skill '{skill_name}' not found")
    if not skill.enabled:
        return SkillResult(success=False, error=f"Skill '{skill_name}' is disabled")
    if not callable(skill.run_callable):
        return SkillResult(success=False, error=f"Skill '{skill_name}' has no runnable entrypoint")

    try:
        result = await skill.run_callable(context, **kwargs)
        if isinstance(result, SkillResult):
            return result
        if isinstance(result, dict):
            return SkillResult(success=True, output=result)
        return SkillResult(success=True, output={"value": result})
    except Exception as exc:
        return SkillResult(success=False, error=str(exc))


async def invoke(skill_name: str, context: SkillContext, **kwargs) -> SkillResult:
    """Compatibility alias for documented skill_runner.invoke(...) calls."""
    return await run_skill(skill_name, context, **kwargs)
