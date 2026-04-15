"""
Cortex v3 foundation: skill registry management and execution endpoints.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from agents.skill_runner import (
    SkillContext,
    discover_skills,
    list_skills,
    run_skill,
    set_skill_enabled,
)


router = APIRouter(prefix="/skills", tags=["skills"])


class SkillRunRequest(BaseModel):
    session_id: Optional[str] = None
    project_path: Optional[str] = None
    env: Dict[str, str] = Field(default_factory=dict)
    args: Dict[str, Any] = Field(default_factory=dict)


@router.get("")
async def get_skills():
    return {"skills": await list_skills()}


@router.post("/reload")
async def reload_skills():
    registry = await discover_skills()
    return {
        "status": "reloaded",
        "count": len(registry),
        "enabled": len([s for s in registry.values() if s.enabled]),
        "runnable": len([s for s in registry.values() if s.run_callable]),
    }


@router.post("/{skill_name}/enable")
async def enable_skill(skill_name: str):
    ok = await set_skill_enabled(skill_name, True)
    if not ok:
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"status": "enabled", "skill": skill_name}


@router.post("/{skill_name}/disable")
async def disable_skill(skill_name: str):
    ok = await set_skill_enabled(skill_name, False)
    if not ok:
        raise HTTPException(status_code=404, detail="Skill not found")
    return {"status": "disabled", "skill": skill_name}


@router.post("/{skill_name}/run")
async def execute_skill(skill_name: str, req: SkillRunRequest):
    context = SkillContext(
        env=req.env,
        session_id=req.session_id,
        project_path=req.project_path,
    )
    result = await run_skill(skill_name, context, **req.args)
    payload = {
        "success": result.success,
        "output": result.output,
        "events": result.events,
        "error": result.error,
    }
    if not result.success and result.error and "not found" in result.error.lower():
        raise HTTPException(status_code=404, detail=payload)
    return payload
