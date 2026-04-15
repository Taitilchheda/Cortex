"""
Specialist generation agents for frontend/backend/ml/docs domains.
"""
from __future__ import annotations

import json
from typing import Dict, Any, List, AsyncGenerator

import httpx

from config.models import OLLAMA_BASE
from config.pools import SPECIALIST_POOLS
from agents.vram_selector import select_model
from agents.file_writer import extract_code_content


def _build_specialist_system(domain: str) -> str:
    if domain == "frontend":
        return (
            "You are a frontend specialist. Use React functional components, TypeScript types, "
            "responsive layouts, and accessible semantics."
        )
    if domain == "backend":
        return (
            "You are a backend specialist. Prefer async FastAPI/Pydantic patterns with robust "
            "error handling and secure defaults."
        )
    if domain == "ml":
        return (
            "You are an ML specialist. Write reproducible ML/data code and include stable "
            "inference/train conventions where relevant."
        )
    return (
        "You are a docs/config specialist. Produce concise and correct markdown/configuration "
        "files with practical instructions."
    )


async def _generate_once(model: str, system: str, prompt: str, path: str) -> str:
    async with httpx.AsyncClient(timeout=180) as client:
        resp = await client.post(
            f"{OLLAMA_BASE}/api/generate",
            json={
                "model": model,
                "system": system,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.2, "num_predict": 8192},
            },
        )
        resp.raise_for_status()
        raw = str(resp.json().get("response", ""))
        return extract_code_content(raw, path)


async def run_specialist(
    domain: str,
    file_spec: Dict[str, Any],
    project_name: str,
    task: str,
    project_path: str,
    context_blobs: List[str] | None = None,
) -> Dict[str, Any]:
    rel_path = str(file_spec.get("path", "")).strip()
    purpose = str(file_spec.get("description") or file_spec.get("purpose") or "").strip()
    if not rel_path:
        return {"ok": False, "error": "missing_path", "path": rel_path}

    pool = SPECIALIST_POOLS.get(domain, SPECIALIST_POOLS["backend"])
    model = await select_model(pool, prefer_quality=True)
    system = _build_specialist_system(domain)

    extra_context = "\n\n".join(context_blobs or [])
    prompt = (
        f"Project: {project_name}\n"
        f"Task: {task}\n"
        f"File path: {rel_path}\n"
        f"Purpose: {purpose}\n\n"
        "Output ONLY the complete file content for this file. No commentary."
    )
    if extra_context:
        prompt += f"\n\nAdditional context:\n{extra_context}"

    try:
        content = await _generate_once(model, system, prompt, rel_path)
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "path": rel_path,
            "specialist": domain,
            "model": model,
        }

    if not content or len(content.strip()) < 4:
        return {
            "ok": False,
            "error": "empty_content",
            "path": rel_path,
            "specialist": domain,
            "model": model,
        }

    return {
        "ok": True,
        "path": rel_path,
        "content": content,
        "specialist": domain,
        "model": model,
    }


async def stream_specialist_generation(
    files: List[Dict[str, Any]],
    plan: Dict[str, Any],
    task: str,
    project_path: str,
) -> AsyncGenerator[Dict[str, Any], None]:
    project_name = str(plan.get("project_name", "Project"))

    for idx, file_spec in enumerate(files, start=1):
        path = str(file_spec.get("path", ""))
        domain = str(file_spec.get("specialist", "backend"))
        yield {
            "type": "log",
            "data": {
                "phase": "specialist_start",
                "message": f"Generating ({idx}/{len(files)}): {path}",
                "path": path,
                "specialist": domain,
            },
        }

        result = await run_specialist(
            domain=domain,
            file_spec=file_spec,
            project_name=project_name,
            task=task,
            project_path=project_path,
            context_blobs=[],
        )

        if not result.get("ok"):
            yield {
                "type": "error",
                "data": {
                    "message": f"Specialist failed for {path}: {result.get('error', 'unknown')}",
                    "path": path,
                    "specialist": domain,
                },
            }
            continue

        yield {
            "type": "file_stream",
            "data": {
                "path": path,
                "delta": result["content"],
                "specialist": domain,
            },
        }
        yield {
            "type": "specialist_file",
            "data": {
                "path": path,
                "content": result["content"],
                "specialist": domain,
                "model": result.get("model"),
            },
        }
