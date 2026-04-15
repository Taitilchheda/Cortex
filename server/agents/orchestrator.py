"""
Cortex — Agent Orchestrator
Routes tasks to the correct agent: build, chat, aider refactor.
Implements multi-turn conversation memory and git integration (Future Scope).
"""
import json
import os
import subprocess
import httpx
import asyncio
import re
import time
from typing import AsyncGenerator, Dict, Any, List, Optional, Tuple
from config.models import get_model_for_role, OLLAMA_BASE, MODEL_ROUTER
from config.pools import SPECIALIST_POOLS, MODEL_BENCHMARKS
from agents.file_writer import architect_phase, self_healing_build, write_file_content
from agents.dispatcher import dispatch
from agents.specialist import stream_specialist_generation
from agents.merger import merge_and_validate
from agents.heal_loop import run_heal_loop
from agents.reviewer import run_code_review
from agents.web_search import get_web_context
from api.memory import get_memory_context, upsert_specialist_memory, get_specialist_memory_context
from api.state import add_event, create_session, update_session_title, update_token_usage, search_project_context

# ─── Conversation Memory (Future Scope) ──────────────────────────
# Multi-turn memory per session for build mode context
_conversation_memory: Dict[str, List[Dict[str, str]]] = {}

ROLE_KEYS = {"architect", "coder", "debug", "quick", "explain", "review"}
ROUTER_CONFIDENCE_MIN = 0.55
SPECIALIST_TIMEOUT_SEC = 20
DANGEROUS_ACTION_PATTERNS = (
    "rm -rf", "del /f", "format ", "drop table", "truncate table", "delete from",
    "git reset --hard", "force push", "rewrite history", "dangerous", "destructive",
)
LOW_QUALITY_PATTERNS = (
    "not sure", "i'm not sure", "cannot determine", "can't determine", "maybe", "might be",
    "i don't have enough", "unable to verify",
)

_router_metrics: Dict[str, Any] = {
    "total": 0,
    "auto": 0,
    "manual": 0,
    "fallbacks": 0,
    "by_role": {k: 0 for k in sorted(ROLE_KEYS)},
    "avg_confidence": 0.0,
    "specialist_consults": 0,
    "specialist_success": 0,
    "specialist_timeouts": 0,
    "avg_specialist_latency_ms": 0.0,
    "decompositions": 0,
    "auto_escalations": 0,
    "approval_blocks": 0,
    "quality_feedback": {"up": 0, "down": 0},
}

def get_conversation_history(session_id: str) -> List[Dict[str, str]]:
    return _conversation_memory.get(session_id, [])

def add_to_conversation(session_id: str, role: str, content: str):
    if session_id not in _conversation_memory:
        _conversation_memory[session_id] = []
    _conversation_memory[session_id].append({"role": role, "content": content})
    # Keep last 20 turns to avoid context overflow
    if len(_conversation_memory[session_id]) > 40:
        _conversation_memory[session_id] = _conversation_memory[session_id][-40:]


# ─── Project Templates (Future Scope) ────────────────────────────
PROJECT_TEMPLATES = {
    "fastapi": {
        "name": "FastAPI Starter",
        "description": "Python FastAPI REST API with SQLite, CORS, health checks",
        "files": ["main.py", "requirements.txt", "models.py", "schemas.py", "database.py", "README.md", ".gitignore"],
    },
    "nextjs": {
        "name": "Next.js Starter",
        "description": "Next.js 14 with App Router, Tailwind CSS, TypeScript",
        "files": ["package.json", "tsconfig.json", "tailwind.config.ts", "app/page.tsx", "app/layout.tsx", "app/globals.css", "README.md", ".gitignore"],
    },
    "react-native": {
        "name": "React Native Starter",
        "description": "React Native with Expo, TypeScript, Navigation",
        "files": ["package.json", "tsconfig.json", "App.tsx", "app.json", "README.md", ".gitignore"],
    },
    "ml-pipeline": {
        "name": "ML Pipeline",
        "description": "Python ML pipeline with data loading, training, evaluation",
        "files": ["requirements.txt", "train.py", "evaluate.py", "data_loader.py", "model.py", "config.yaml", "README.md", ".gitignore"],
    },
    "flask": {
        "name": "Flask Starter",
        "description": "Python Flask web app with templates and SQLite",
        "files": ["app.py", "requirements.txt", "templates/index.html", "static/style.css", "README.md", ".gitignore"],
    },
}


def _summarize_text(text: str, max_chars: int = 320) -> str:
    clean = " ".join((text or "").split())
    if len(clean) <= max_chars:
        return clean
    return clean[: max_chars - 3].rstrip() + "..."


def _risk_score(task: str, mode: str, role: str) -> float:
    text = (task or "").lower()
    score = 0.0
    if mode == "refactor":
        score += 0.2
    if role == "debug":
        score += 0.2
    score += 0.15 * sum(1 for token in DANGEROUS_ACTION_PATTERNS if token in text)
    if any(token in text for token in ["production", "database", "migration", "live data"]):
        score += 0.2
    return max(0.0, min(1.0, score))


def _is_complex_request(task: str) -> bool:
    text = (task or "").strip()
    if len(text) >= 280:
        return True
    lowered = text.lower()
    complexity_tokens = [
        "step by step", "multiple", "and then", "end-to-end", "across", "pipeline",
        "integrate", "migration", "plus", "phases", "subtasks",
    ]
    bullet_like = text.count("\n-") + text.count("\n1.") + text.count(";")
    return any(token in lowered for token in complexity_tokens) or bullet_like >= 2


def _decompose_task(task: str, max_parts: int = 4) -> List[str]:
    text = (task or "").strip()
    if not text:
        return []

    if "\n" in text and ("-" in text or "1." in text):
        rows = [r.strip(" -\t") for r in text.splitlines() if r.strip()]
        rows = [r for r in rows if len(r) > 10]
        return rows[:max_parts]

    split_re = re.compile(r"(?:\s+then\s+|\s+and then\s+|;|\n|\.\s+)", re.IGNORECASE)
    parts = [p.strip(" -\t") for p in split_re.split(text) if p.strip()]
    parts = [p for p in parts if len(p) > 12]

    if len(parts) <= 1:
        return [text]
    return parts[:max_parts]


def _derive_latency_budget_ms(task: str) -> int:
    lowered = (task or "").lower()
    if any(k in lowered for k in ["quick", "asap", "fast", "brief", "tldr", "one-liner"]):
        return 2200
    if any(k in lowered for k in ["thorough", "deep", "comprehensive", "audit"]):
        return 9000
    return 5200


def _derive_quality_tier(task: str) -> str:
    lowered = (task or "").lower()
    if any(k in lowered for k in ["quick", "fast", "brief", "minimal"]):
        return "fast"
    if any(k in lowered for k in ["thorough", "comprehensive", "high quality", "robust"]):
        return "high"
    return "balanced"


def _estimate_model_latency_ms(model_name: str) -> float:
    bench = MODEL_BENCHMARKS.get(model_name, {})
    # latency benchmark is in [0..1], where higher means faster in this repo's benchmark map.
    relative_speed = float(bench.get("latency", 0.55))
    return max(700.0, 5800.0 - (relative_speed * 4200.0))


def _select_model_for_role(role: str, task: str, latency_budget_ms: int, quality_tier: str) -> str:
    pool = SPECIALIST_POOLS.get(role, [get_model_for_role(role)])
    if not pool:
        return get_model_for_role(role)

    def score(name: str) -> float:
        bench = MODEL_BENCHMARKS.get(name, {})
        coding = float(bench.get("coding", 0.5))
        reasoning = float(bench.get("reasoning", 0.5))
        est_latency = _estimate_model_latency_ms(name)
        latency_fit = 1.0 if est_latency <= latency_budget_ms else max(0.0, 1.0 - ((est_latency - latency_budget_ms) / 5000.0))

        if quality_tier == "fast":
            return (latency_fit * 0.55) + (coding * 0.30) + (reasoning * 0.15)
        if quality_tier == "high":
            return (reasoning * 0.45) + (coding * 0.40) + (latency_fit * 0.15)
        return (coding * 0.40) + (reasoning * 0.30) + (latency_fit * 0.30)

    ranked = sorted(pool, key=score, reverse=True)
    return ranked[0] if ranked else get_model_for_role(role)


def _validate_specialist_payload(payload: Dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    if not isinstance(payload.get("summary", ""), str):
        return False
    if not isinstance(payload.get("risks", []), list):
        return False
    if not isinstance(payload.get("actions", []), list):
        return False
    conf = payload.get("confidence", 0.0)
    return isinstance(conf, (int, float))


def _needs_auto_escalation(task: str, response_text: str, mode: str) -> bool:
    if mode != "coder":
        return False
    task_complex = _is_complex_request(task)
    resp = (response_text or "").strip().lower()
    if not resp:
        return True
    if task_complex and len(resp) < 180:
        return True
    if any(token in resp for token in LOW_QUALITY_PATTERNS):
        return True
    if "```" not in response_text and any(k in task.lower() for k in ["code", "implement", "function", "endpoint"]):
        return True
    return False


def record_router_feedback(feedback: str) -> None:
    fb = str(feedback or "").strip().lower()
    if fb not in {"up", "down"}:
        return
    q = _router_metrics.get("quality_feedback", {})
    if not isinstance(q, dict):
        q = {"up": 0, "down": 0}
    q[fb] = int(q.get(fb, 0)) + 1
    _router_metrics["quality_feedback"] = q


async def run_architect(task: str, project_path: str, session_id: str) -> AsyncGenerator[Dict[str, Any], None]:
    """Architect-only planning phase entrypoint."""
    async for event in architect_phase(task, project_path):
        await add_event(session_id, event["type"], event["data"])
        yield event


async def run_debug_agent(task: str, session_id: str) -> AsyncGenerator[Dict[str, Any], None]:
    """Debug-specialized chat entrypoint."""
    async for event in run_chat(task=task, mode="debug", session_id=session_id):
        yield event


async def run_build(task: str, project_path: str, session_id: str, self_heal: bool = False) -> AsyncGenerator[Dict[str, Any], None]:
    """Full build pipeline: architect -> dispatcher -> specialists -> merger -> write -> heal -> review."""
    await add_event(session_id, "build_start", {"task": task, "project_path": project_path})

    # Preserve legacy self-heal mode for compatibility.
    if self_heal and os.getenv("CORTEX_USE_LEGACY_SELF_HEAL", "0") == "1":
        async for event in self_healing_build(task, project_path):
            await add_event(session_id, event["type"], event["data"])
            yield event
        return

    # Fetch memory and project context for architect planning.
    memory_context = await get_memory_context(task)
    architect_task = task
    if memory_context:
        architect_task = f"{memory_context}\n\nTarget Task: {architect_task}"

    project_context = await _get_project_context(session_id, task)
    if project_context:
        architect_task = f"{project_context}\n\nTarget Task: {architect_task}"

    plan = None
    async for event in architect_phase(architect_task, project_path):
        await add_event(session_id, event["type"], event["data"])
        yield event
        if event["type"] == "log" and event["data"].get("phase") == "architect_done":
            plan = event["data"].get("plan")

    if not isinstance(plan, dict):
        err_event = {"type": "error", "data": {"message": "No valid architect plan produced."}}
        await add_event(session_id, err_event["type"], err_event["data"])
        yield err_event
        return

    add_to_conversation(session_id, "user", task)
    add_to_conversation(session_id, "assistant", f"Architect plan: {json.dumps(plan.get('files', []))}")

    classified_files = await dispatch(plan, session_id)
    for file_spec in classified_files:
        evt = {
            "type": "file_classified",
            "data": {
                "path": file_spec.get("path", ""),
                "specialist": file_spec.get("specialist", "backend"),
                "stage": int(file_spec.get("classification_stage", 1)),
            },
        }
        await add_event(session_id, evt["type"], evt["data"])
        yield evt

    generated_rows: List[Dict[str, Any]] = []
    async for event in stream_specialist_generation(classified_files, plan, task, project_path):
        if event["type"] == "specialist_file":
            generated_rows.append(event["data"])
            continue
        await add_event(session_id, event["type"], event["data"])
        yield event

    merge_result = await merge_and_validate(classified_files, generated_rows)
    for merge_error in merge_result.get("errors", []):
        evt = {
            "type": "error",
            "data": {
                "message": f"Merge validation error in {merge_error.get('path')}: {merge_error.get('error')}",
                "path": merge_error.get("path", ""),
                "reason": merge_error.get("error", "unknown"),
            },
        }
        await add_event(session_id, evt["type"], evt["data"])
        yield evt

    changed_files: List[str] = []
    for write_row in merge_result.get("writes", []):
        try:
            write_meta = write_file_content(project_path, str(write_row["path"]), str(write_row["content"]))
            changed_files.append(str(write_row["path"]))
            evt = {
                "type": "file_created",
                "data": {
                    **write_meta,
                    "message": f"{write_row['path']} written",
                    "specialist": write_row.get("specialist", "backend"),
                },
            }
            await add_event(session_id, evt["type"], evt["data"])
            yield evt
        except Exception as exc:
            evt = {
                "type": "error",
                "data": {
                    "message": f"Failed to write {write_row.get('path')}: {exc}",
                    "path": write_row.get("path", ""),
                },
            }
            await add_event(session_id, evt["type"], evt["data"])
            yield evt

    max_heal_iterations = int(os.getenv("MAX_HEAL_ITERATIONS", "3"))
    heal = await run_heal_loop(project_path, max_iterations=max_heal_iterations)
    if heal.get("ok"):
        evt = {
            "type": "heal_success",
            "data": {"iterations_taken": int(heal.get("iterations_taken", 1))},
        }
        await add_event(session_id, evt["type"], evt["data"])
        yield evt
    else:
        evt = {
            "type": "heal_failed",
            "data": {"final_errors": heal.get("errors", [])},
        }
        await add_event(session_id, evt["type"], evt["data"])
        yield evt

    async for event in run_code_review(project_path, changed_files):
        await add_event(session_id, event["type"], event["data"])
        yield event

    await add_event(session_id, "log", {"phase": "complete", "message": "Build and review complete."})
    yield {"type": "log", "data": {"phase": "complete", "message": "Build and review complete."}}
    await add_event(session_id, "log", {"phase": "build_done", "message": "Build and review complete."})

    await _git_auto_commit(project_path, task)


def _classify_task_role(task: str, attachments: Optional[list] = None) -> Dict[str, Any]:
    """Heuristic router with confidence and keyword evidence."""
    text = (task or "").lower()
    if attachments:
        text += " " + " ".join(str(a.get("name", "")).lower() for a in attachments if isinstance(a, dict))

    signals: Dict[str, List[str]] = {
        "debug": ["traceback", "stack trace", "error", "crash", "exception", "bug", "fix", "broken", "failing test"],
        "architect": ["architecture", "system design", "scalable", "design a", "design an", "plan this", "migration", "refactor plan"],
        "explain": ["explain", "what is", "how does", "documentation", "docstring", "teach me", "walk me through"],
        "review": ["review", "audit", "security", "best practice", "code smell", "performance review", "vulnerability"],
        "quick": ["quick", "brief", "tldr", "one-liner", "short answer"],
        "coder": ["implement", "build", "write code", "create", "feature", "endpoint", "component"],
    }

    role_scores: Dict[str, float] = {role: 0.0 for role in ROLE_KEYS}
    role_matches: Dict[str, List[str]] = {role: [] for role in ROLE_KEYS}

    for role, keywords in signals.items():
        hits = [kw for kw in keywords if kw in text]
        role_matches[role].extend(hits)
        if keywords:
            role_scores[role] = len(hits) / float(len(keywords))

    ranked: List[Tuple[str, float]] = sorted(role_scores.items(), key=lambda item: item[1], reverse=True)
    top_role, top_score = ranked[0]
    second_score = ranked[1][1] if len(ranked) > 1 else 0.0

    if top_score <= 0.0:
        return {
            "role": "coder",
            "confidence": 0.40,
            "reason": "No strong specialist keywords; defaulting to coder",
            "matched_keywords": [],
            "scores": role_scores,
        }

    margin = max(0.0, top_score - second_score)
    confidence = min(0.98, 0.45 + (top_score * 0.35) + (margin * 0.30))
    matched = role_matches.get(top_role, [])

    return {
        "role": top_role,
        "confidence": round(confidence, 3),
        "reason": f"Matched {len(matched)} keyword(s) for {top_role}",
        "matched_keywords": matched[:8],
        "scores": role_scores,
    }


def _record_router_metric(role: str, confidence: float, auto_mode: bool, fallback: bool) -> None:
    prev_total = int(_router_metrics.get("total", 0))
    total = prev_total + 1
    _router_metrics["total"] = total
    _router_metrics["auto"] = int(_router_metrics.get("auto", 0)) + (1 if auto_mode else 0)
    _router_metrics["manual"] = int(_router_metrics.get("manual", 0)) + (0 if auto_mode else 1)
    _router_metrics["fallbacks"] = int(_router_metrics.get("fallbacks", 0)) + (1 if fallback else 0)

    by_role = _router_metrics.get("by_role", {})
    if isinstance(by_role, dict):
        by_role[role] = int(by_role.get(role, 0)) + 1
        _router_metrics["by_role"] = by_role

    old_avg = float(_router_metrics.get("avg_confidence", 0.0))
    _router_metrics["avg_confidence"] = round(((old_avg * prev_total) + confidence) / float(total), 4)


def get_router_metrics() -> Dict[str, Any]:
    by_role = _router_metrics.get("by_role", {})
    specialist_consults = int(_router_metrics.get("specialist_consults", 0))
    specialist_success = int(_router_metrics.get("specialist_success", 0))
    specialist_timeouts = int(_router_metrics.get("specialist_timeouts", 0))
    quality_feedback = _router_metrics.get("quality_feedback", {})
    return {
        "total": int(_router_metrics.get("total", 0)),
        "auto": int(_router_metrics.get("auto", 0)),
        "manual": int(_router_metrics.get("manual", 0)),
        "fallbacks": int(_router_metrics.get("fallbacks", 0)),
        "avg_confidence": float(_router_metrics.get("avg_confidence", 0.0)),
        "by_role": dict(by_role) if isinstance(by_role, dict) else {},
        "specialist_consults": specialist_consults,
        "specialist_success": specialist_success,
        "specialist_timeouts": specialist_timeouts,
        "specialist_hit_rate": round((specialist_success / float(max(1, specialist_consults))) * 100.0, 2),
        "avg_specialist_latency_ms": float(_router_metrics.get("avg_specialist_latency_ms", 0.0)),
        "decompositions": int(_router_metrics.get("decompositions", 0)),
        "auto_escalations": int(_router_metrics.get("auto_escalations", 0)),
        "approval_blocks": int(_router_metrics.get("approval_blocks", 0)),
        "quality_feedback": dict(quality_feedback) if isinstance(quality_feedback, dict) else {"up": 0, "down": 0},
        "confidence_threshold": ROUTER_CONFIDENCE_MIN,
    }


def reset_router_metrics() -> Dict[str, Any]:
    _router_metrics["total"] = 0
    _router_metrics["auto"] = 0
    _router_metrics["manual"] = 0
    _router_metrics["fallbacks"] = 0
    _router_metrics["avg_confidence"] = 0.0
    _router_metrics["by_role"] = {k: 0 for k in sorted(ROLE_KEYS)}
    _router_metrics["specialist_consults"] = 0
    _router_metrics["specialist_success"] = 0
    _router_metrics["specialist_timeouts"] = 0
    _router_metrics["avg_specialist_latency_ms"] = 0.0
    _router_metrics["decompositions"] = 0
    _router_metrics["auto_escalations"] = 0
    _router_metrics["approval_blocks"] = 0
    _router_metrics["quality_feedback"] = {"up": 0, "down": 0}
    return get_router_metrics()


def _support_roles_for(primary_role: str, task: str) -> List[str]:
    """Select up to two supporting specialists for cross-checking."""
    text = (task or "").lower()
    support: List[str] = []

    if primary_role == "coder":
        if any(k in text for k in ["error", "bug", "fix", "exception", "failing"]):
            support.extend(["debug", "review"])
        elif any(k in text for k in ["architecture", "design", "migration", "scalable", "refactor"]):
            support.extend(["architect", "review"])
    elif primary_role == "architect":
        support.append("review")
    elif primary_role == "debug":
        support.append("review")
    elif primary_role == "review":
        if any(k in text for k in ["security", "vulnerability", "owasp"]):
            support.append("debug")

    out: List[str] = []
    for role in support:
        if role != primary_role and role not in out:
            out.append(role)
    return out[:2]


def _extract_json_dict(raw_text: str) -> Optional[Dict[str, Any]]:
    text = (raw_text or "").strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            parsed = json.loads(text[start : end + 1])
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return None
    return None


def _coerce_specialist_payload(role: str, payload: Dict[str, Any], fallback_text: str = "") -> Dict[str, Any]:
    summary = str(payload.get("summary", "")).strip()
    confidence = payload.get("confidence", 0.5)
    try:
        confidence = float(confidence)
    except Exception:
        confidence = 0.5
    confidence = max(0.0, min(1.0, confidence))

    risks = payload.get("risks", [])
    if not isinstance(risks, list):
        risks = [str(risks)]
    risks = [str(r).strip() for r in risks if str(r).strip()]

    actions = payload.get("actions", [])
    if not isinstance(actions, list):
        actions = [str(actions)]
    actions = [str(a).strip() for a in actions if str(a).strip()]

    if not summary and fallback_text:
        lines = [ln.strip("-* ") for ln in fallback_text.splitlines() if ln.strip()]
        summary = lines[0] if lines else ""
        if len(lines) > 1 and not actions:
            actions = lines[1:6]

    candidate = {
        "role": role,
        "summary": summary,
        "risks": risks[:6],
        "actions": actions[:8],
        "confidence": round(confidence, 3),
    }
    candidate["schema_valid"] = _validate_specialist_payload(candidate)
    return candidate


async def _run_specialist_brief(
    role: str,
    task: str,
    base_context: str,
    history: List[Dict[str, str]],
    latency_budget_ms: int = 5200,
    quality_tier: str = "balanced",
) -> Dict[str, Any]:
    """Get a specialist note in a structured format for downstream synthesis."""
    model = _select_model_for_role(role, task, latency_budget_ms=latency_budget_ms, quality_tier=quality_tier)
    system_prompt = (
        _get_system_prompt(role)
        + "\nReturn STRICT JSON only with this schema: "
        + '{"summary": string, "risks": string[], "actions": string[], "confidence": number}. '
        + "Use confidence in range 0.0..1.0."
    )

    messages = [{"role": "system", "content": system_prompt}]
    if history:
        messages.extend(history[-6:])
    messages.append(
        {
            "role": "user",
            "content": f"Task:\n{task}\n\nContext:\n{base_context}\n\nReturn only the brief.",
        }
    )

    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/chat",
                json={"model": model, "messages": messages, "stream": False},
            )
            if resp.status_code != 200:
                return {
                    "role": role,
                    "summary": "",
                    "risks": [],
                    "actions": [],
                    "confidence": 0.0,
                    "error": f"http_{resp.status_code}",
                }
            data = resp.json()
            content = str(data.get("message", {}).get("content", "")).strip()
            parsed = _extract_json_dict(content)
            if isinstance(parsed, dict):
                return _coerce_specialist_payload(role, parsed, fallback_text=content)
            return _coerce_specialist_payload(role, {}, fallback_text=content)
    except Exception:
        return {
            "role": role,
            "summary": "",
            "risks": [],
            "actions": [],
            "confidence": 0.0,
            "error": "exception",
        }


async def _run_specialist_brief_with_timeout(
    role: str,
    task: str,
    base_context: str,
    history: List[Dict[str, str]],
    timeout_sec: int = SPECIALIST_TIMEOUT_SEC,
    latency_budget_ms: int = 5200,
    quality_tier: str = "balanced",
) -> Dict[str, Any]:
    try:
        return await asyncio.wait_for(
            _run_specialist_brief(
                role=role,
                task=task,
                base_context=base_context,
                history=history,
                latency_budget_ms=latency_budget_ms,
                quality_tier=quality_tier,
            ),
            timeout=timeout_sec,
        )
    except asyncio.TimeoutError:
        return {
            "role": role,
            "summary": "",
            "risks": [],
            "actions": [],
            "confidence": 0.0,
            "error": "timeout",
        }


async def run_chat(
    task: str,
    mode: str,
    session_id: str,
    attachments: list = None,
    local_only: bool = False,
    approved_actions: bool = False,
    latency_budget_ms: Optional[int] = None,
    quality_tier: str = "balanced",
) -> AsyncGenerator[Dict[str, Any], None]:
    """Chat with role routing + image support + multi-turn memory."""
    requested_mode = (mode or "").strip().lower()
    auto_mode = requested_mode in {"", "auto"}
    router_decision = _classify_task_role(task, attachments) if auto_mode else {
        "role": requested_mode,
        "confidence": 1.0,
        "reason": "User selected role",
        "matched_keywords": [],
        "scores": {},
    }
    resolved_mode = str(router_decision.get("role", "coder"))
    if resolved_mode not in ROLE_KEYS:
        resolved_mode = "coder"

    router_reason = str(router_decision.get("reason", ""))
    router_keywords = [str(k) for k in router_decision.get("matched_keywords", []) if str(k).strip()]

    fallback_applied = False
    if auto_mode:
        confidence = float(router_decision.get("confidence", 0.0))
        if confidence < ROUTER_CONFIDENCE_MIN and resolved_mode != "coder":
            fallback_applied = True
            router_decision["reason"] = (
                f"Confidence {confidence:.2f} below threshold {ROUTER_CONFIDENCE_MIN:.2f}; fallback to coder"
            )
            resolved_mode = "coder"
            router_reason = str(router_decision.get("reason", ""))

    support_roles = _support_roles_for(resolved_mode, task) if auto_mode else []
    effective_latency_budget_ms = latency_budget_ms if isinstance(latency_budget_ms, int) and latency_budget_ms > 0 else _derive_latency_budget_ms(task)
    effective_quality_tier = quality_tier if quality_tier in {"fast", "balanced", "high"} else _derive_quality_tier(task)
    model = _select_model_for_role(
        resolved_mode,
        task,
        latency_budget_ms=effective_latency_budget_ms,
        quality_tier=effective_quality_tier,
    )
    confidence_val = float(router_decision.get("confidence", 1.0 if not auto_mode else 0.0))
    _record_router_metric(resolved_mode, confidence_val, auto_mode, fallback_applied)

    # Persist the prompt intent immediately so history survives downstream failures.
    chat_start_data = {
        "mode": resolved_mode,
        "requested_mode": requested_mode or "auto",
        "auto_mode": auto_mode,
        "support_roles": support_roles,
        "router_confidence": round(confidence_val, 3),
        "router_fallback": fallback_applied,
        "router_reason": router_reason,
        "router_keywords": router_keywords,
        "quality_tier": effective_quality_tier,
        "latency_budget_ms": effective_latency_budget_ms,
        "model": model,
        "task": task,
    }
    await add_event(session_id, "chat_start", chat_start_data)

    risk = _risk_score(task, mode=resolved_mode, role=resolved_mode)
    if risk >= 0.7 and not approved_actions:
        _router_metrics["approval_blocks"] = int(_router_metrics.get("approval_blocks", 0)) + 1
        gate_data = {
            "action": "high_risk_chat",
            "risk_score": round(risk, 3),
            "resolved_mode": resolved_mode,
            "reason": "High-risk request detected. Confirm before proceeding.",
            "task_excerpt": _summarize_text(task, 220),
        }
        yield {"type": "approval_required", "data": gate_data}
        await add_event(session_id, "approval_required", gate_data)
        return

    history = get_conversation_history(session_id)
    messages = [{"role": "system", "content": _get_system_prompt(resolved_mode)}]
    messages.extend(history)

    user_content = task
    images = []
    if attachments:
        for att in attachments:
            if att.get("is_image") and att.get("data"):
                images.append(att["data"])
            elif att.get("content"):
                user_content += f"\n\n--- Attached: {att.get('name', 'file')} ---\n{att['content']}"

    if (not local_only) and any(kw in task.lower() for kw in ["search", "google", "web", "latest", "how to", "library"]):
        yield {"type": "log", "data": {"phase": "web_search", "message": f"Searching web for: {task}..."}}
        web_context = await get_web_context(task)
        if web_context:
            user_content = f"{web_context}\n\nUser Question: {user_content}"

    memory_context = await get_memory_context(task)
    if memory_context:
        user_content = f"{memory_context}\n\nUser Question: {user_content}"

    specialist_memory_context = await get_specialist_memory_context([resolved_mode, "review", "debug"], limit=5)
    if specialist_memory_context:
        user_content = f"{specialist_memory_context}\n\nUser Question: {user_content}"

    project_context = await _get_project_context(session_id, task)
    if project_context:
        user_content = f"{project_context}\n\nUser Question: {user_content}"

    if auto_mode:
        route_log = {
            "type": "log",
            "data": {
                "phase": "role_router",
                "message": f"Auto-routed to '{resolved_mode}'",
                "requested_mode": requested_mode or "auto",
                "resolved_mode": resolved_mode,
                "support_roles": support_roles,
                "confidence": round(confidence_val, 3),
                "fallback_applied": fallback_applied,
                "reason": router_reason,
                "matched_keywords": router_keywords,
                "quality_tier": effective_quality_tier,
                "latency_budget_ms": effective_latency_budget_ms,
            },
        }
        yield route_log
        await add_event(session_id, "role_router", route_log["data"])

    decomposed_subtasks: List[str] = []
    if _is_complex_request(task):
        decomposed_subtasks = _decompose_task(task)
        if decomposed_subtasks:
            _router_metrics["decompositions"] = int(_router_metrics.get("decompositions", 0)) + 1
            decomposition_data = {"count": len(decomposed_subtasks), "subtasks": decomposed_subtasks}
            yield {"type": "task_decomposition", "data": decomposition_data}
            await add_event(session_id, "task_decomposition", decomposition_data)

    specialist_briefs: List[Dict[str, Any]] = []
    if support_roles or decomposed_subtasks:
        base_context = user_content
        for role in support_roles:
            yield {
                "type": "log",
                "data": {
                    "phase": "specialist_handoff",
                    "message": f"Consulting specialist '{role}'",
                    "role": role,
                },
            }

        jobs: List[Tuple[str, str, str]] = [(role, task, base_context) for role in support_roles]
        for subtask in decomposed_subtasks:
            routed = _classify_task_role(subtask)
            sub_role = str(routed.get("role", resolved_mode)).lower()
            if sub_role not in ROLE_KEYS:
                sub_role = resolved_mode
            jobs.append((sub_role, subtask, f"{base_context}\n\nSubtask focus:\n{subtask}"))

        async def _run_job(role: str, scoped_task: str, scoped_context: str) -> Tuple[Dict[str, Any], float]:
            started = time.perf_counter()
            timeout_for_role = max(6.0, min(24.0, effective_latency_budget_ms / 1000.0))
            brief = await _run_specialist_brief_with_timeout(
                role=role,
                task=scoped_task,
                base_context=scoped_context,
                history=history,
                timeout_sec=timeout_for_role,
                latency_budget_ms=effective_latency_budget_ms,
                quality_tier=effective_quality_tier,
            )
            elapsed = (time.perf_counter() - started) * 1000.0
            return brief, elapsed

        specialist_results = await asyncio.gather(*[_run_job(r, t, c) for r, t, c in jobs])
        previous_consults = int(_router_metrics.get("specialist_consults", 0))
        running_avg = float(_router_metrics.get("avg_specialist_latency_ms", 0.0))

        for brief, elapsed_ms in specialist_results:
            _router_metrics["specialist_consults"] = int(_router_metrics.get("specialist_consults", 0)) + 1
            total_consults = int(_router_metrics.get("specialist_consults", 0))
            running_avg = ((running_avg * previous_consults) + elapsed_ms) / float(total_consults)
            _router_metrics["avg_specialist_latency_ms"] = round(running_avg, 2)
            previous_consults = total_consults

            if isinstance(brief, dict) and (brief.get("summary") or brief.get("actions") or brief.get("risks")):
                if brief.get("error") == "timeout":
                    _router_metrics["specialist_timeouts"] = int(_router_metrics.get("specialist_timeouts", 0)) + 1
                else:
                    _router_metrics["specialist_success"] = int(_router_metrics.get("specialist_success", 0)) + 1
                specialist_briefs.append(brief)
                role_name = str(brief.get("role", "specialist"))
                summary_text = _summarize_text(str(brief.get("summary", "")), 360)
                if summary_text:
                    await upsert_specialist_memory(role_name, summary_text)

        if specialist_briefs:
            notes_chunks: List[str] = []
            for brief in specialist_briefs:
                role = str(brief.get("role", "specialist"))
                summary = str(brief.get("summary", "")).strip()
                actions = brief.get("actions", [])
                risks = brief.get("risks", [])
                conf = brief.get("confidence", 0.0)
                schema_valid = bool(brief.get("schema_valid", False))

                lines = [f"[{role}] confidence={conf} schema_valid={schema_valid}"]
                if summary:
                    lines.append(f"summary: {summary}")
                if isinstance(risks, list) and risks:
                    lines.append("risks:")
                    lines.extend([f"- {r}" for r in risks[:4]])
                if isinstance(actions, list) and actions:
                    lines.append("actions:")
                    lines.extend([f"- {a}" for a in actions[:5]])
                notes_chunks.append("\n".join(lines))

            notes_block = "\n\n".join(notes_chunks)
            user_content = (
                "--- Specialist Briefs ---\n"
                f"{notes_block}\n"
                "--- End Specialist Briefs ---\n\n"
                f"User Question: {task}"
            )

    messages.append({"role": "user", "content": user_content})

    add_to_conversation(session_id, "user", user_content)

    full_response = ""
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            request_body = {
                "model": model,
                "messages": messages,
                "stream": True,
            }
            if images:
                request_body["images"] = images

            async with client.stream(
                "POST",
                f"{OLLAMA_BASE}/api/chat",
                json=request_body,
            ) as response:
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                        token = chunk.get("message", {}).get("content", "")
                        full_response += token
                        if token:
                            yield {
                                "type": "chat_stream",
                                "data": {
                                    "delta": token,
                                    "mode": resolved_mode,
                                    "model": model,
                                    "confidence": round(confidence_val, 3),
                                    "router_reason": router_reason,
                                    "router_keywords": router_keywords,
                                    "quality_tier": effective_quality_tier,
                                    "latency_budget_ms": effective_latency_budget_ms,
                                },
                            }
                        if chunk.get("done"):
                            eval_count = chunk.get("eval_count", 0)
                            prompt_eval_count = chunk.get("prompt_eval_count", 0)
                            await update_token_usage(session_id, prompt_eval_count, eval_count, model)
                            break
                    except json.JSONDecodeError:
                        continue
    except Exception as e:
        yield {"type": "error", "data": {"message": f"Chat failed: {str(e)}"}}

    auto_escalated = False
    if _needs_auto_escalation(task, full_response, resolved_mode):
        auto_escalated = True
        _router_metrics["auto_escalations"] = int(_router_metrics.get("auto_escalations", 0)) + 1
        escalation_log = {
            "phase": "auto_escalation",
            "message": "Initial answer quality appears low for task complexity. Running review/debug escalation.",
        }
        yield {"type": "log", "data": escalation_log}
        await add_event(session_id, "auto_escalation", escalation_log)

        escalation_roles = ["review", "debug"]
        escalation_results = await asyncio.gather(
            *[
                _run_specialist_brief_with_timeout(
                    role=role,
                    task=task,
                    base_context=user_content,
                    history=history,
                    timeout_sec=12,
                    latency_budget_ms=max(effective_latency_budget_ms, 4800),
                    quality_tier="high",
                )
                for role in escalation_roles
            ]
        )

        lines: List[str] = []
        for role, brief in zip(escalation_roles, escalation_results):
            summary = _summarize_text(str(brief.get("summary", "")), 260)
            if summary:
                lines.append(f"- [{role}] {summary}")
                await upsert_specialist_memory(role, summary)
        if lines:
            appended = "\n\nAuto-escalation review:\n" + "\n".join(lines)
            full_response += appended
            yield {
                "type": "chat_stream",
                "data": {
                    "delta": appended,
                    "mode": resolved_mode,
                    "model": model,
                    "confidence": round(confidence_val, 3),
                    "router_reason": router_reason,
                    "router_keywords": router_keywords,
                    "quality_tier": effective_quality_tier,
                    "latency_budget_ms": effective_latency_budget_ms,
                    "auto_escalated": True,
                },
            }

    if full_response:
        add_to_conversation(session_id, "assistant", full_response)
        await upsert_specialist_memory(resolved_mode, _summarize_text(full_response, 360))
        await add_event(
            session_id,
            "chat_response",
            {
                "content": full_response,
                "model": model,
                "mode": resolved_mode,
                "support_roles": support_roles,
                "router_confidence": round(confidence_val, 3),
                "router_reason": router_reason,
                "router_keywords": router_keywords,
                "quality_tier": effective_quality_tier,
                "latency_budget_ms": effective_latency_budget_ms,
                "auto_escalated": auto_escalated,
            },
        )


async def run_aider(
    instruction: str,
    project_path: str,
    session_id: str,
    approved_actions: bool = False,
) -> AsyncGenerator[Dict[str, Any], None]:
    """Aider refactoring: streams aider stdout so you see exactly what files are modified."""
    model = get_model_for_role("coder")
    risk = _risk_score(instruction, mode="refactor", role="coder")
    if risk >= 0.7 and not approved_actions:
        _router_metrics["approval_blocks"] = int(_router_metrics.get("approval_blocks", 0)) + 1
        data = {
            "action": "aider_refactor",
            "risk_score": round(risk, 3),
            "reason": "Refactor request looks high-risk. Confirm approval before running aider.",
            "instruction_excerpt": _summarize_text(instruction, 220),
        }
        yield {"type": "approval_required", "data": data}
        await add_event(session_id, "approval_required", data)
        return

    await add_event(session_id, "aider_start", {"instruction": instruction, "project_path": project_path})

    try:
        proc = await asyncio.create_subprocess_exec(
            "python", "-m", "aider",
            "--model", f"ollama/{model}",
            "--no-git",
            "--yes",
            "--message", instruction,
            cwd=project_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        async for line in proc.stdout:
            text = line.decode('utf-8', errors='replace').rstrip()
            if text:
                yield {"type": "aider_output", "data": {"line": text}}
                await add_event(session_id, "aider_output", {"line": text})

        await proc.wait()
        yield {"type": "log", "data": {"phase": "aider_complete", "message": f"Aider finished (exit code {proc.returncode})"}}
    except FileNotFoundError:
        yield {"type": "error", "data": {"message": "aider-chat not installed. Run: pip install aider-chat"}}
    except Exception as e:
        yield {"type": "error", "data": {"message": f"Aider error: {str(e)}"}}


async def openai_chat_completion(messages: list, model: str = None, stream: bool = True) -> AsyncGenerator[str, None]:
    """OpenAI-compatible /v1/chat/completions endpoint."""
    resolved_model = model or get_model_for_role("coder")
    
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            if stream:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_BASE}/api/chat",
                    json={"model": resolved_model, "messages": messages, "stream": True},
                ) as response:
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk = json.loads(line)
                            token = chunk.get("message", {}).get("content", "")
                            if token:
                                yield json.dumps({
                                    "id": "chatcmpl-local",
                                    "object": "chat.completion.chunk",
                                    "choices": [{"index": 0, "delta": {"content": token}, "finish_reason": None}],
                                })
                            if chunk.get("done"):
                                yield json.dumps({
                                    "id": "chatcmpl-local",
                                    "object": "chat.completion.chunk",
                                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                                })
                                break
                        except json.JSONDecodeError:
                            continue
            else:
                resp = await client.post(
                    f"{OLLAMA_BASE}/api/chat",
                    json={"model": resolved_model, "messages": messages, "stream": False},
                )
                data = resp.json()
                content = data.get("message", {}).get("content", "")
                yield json.dumps({
                    "id": "chatcmpl-local",
                    "object": "chat.completion",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                    "usage": {
                        "prompt_tokens": data.get("prompt_eval_count", 0),
                        "completion_tokens": data.get("eval_count", 0),
                        "total_tokens": data.get("prompt_eval_count", 0) + data.get("eval_count", 0),
                    }
                })
    except Exception as e:
        yield json.dumps({"error": {"message": str(e), "type": "server_error"}})


def _get_system_prompt(mode: str) -> str:
    """Role-specific system prompts."""
    prompts = {
        "coder": "You are an expert software developer. Write clean, production-ready code. When asked to write code, output complete implementations with proper error handling, type hints, and documentation.",
        "architect": "You are a senior software architect. Design clean, scalable systems. When asked about architecture, provide detailed plans with file structures, technology choices, and dependency graphs.",
        "debug": "You are an expert debugger. Analyze code step-by-step, identify bugs, explain root causes, and provide fixes. Use systematic reasoning.",
        "quick": "You are a fast, concise coding assistant. Give short, direct answers and code snippets. No long explanations unless asked.",
        "explain": "You are a technical writer. Explain code and concepts clearly with examples. Use analogies when helpful. Write documentation that developers love to read.",
        "review": "You are a senior code reviewer. Analyze code for bugs, security issues, performance problems, and best-practice violations. Rate severity and provide actionable fixes.",
    }
    return prompts.get(mode, prompts["coder"])


async def _get_project_context(session_id: str, query: str) -> str:
    """Helper to fetch top relevant snippets from project index if a path exists."""
    from api.state import get_session
    session = await get_session(session_id)
    if not session or not session.get("project_path"):
        return ""
    
    project_path = session["project_path"]
    results = await search_project_context(project_path, query, limit=3)
    
    if not results:
        return ""
        
    context = "\n--- Project Context (Relevant Snippets) ---\n"
    for r in results:
        context += f"File: {r['path']}\nContent Snippet:\n{r['content'][:1000]}...\n\n"
    return context + "--- End Context ---\n"

async def _git_auto_commit(project_path: str, task_description: str) -> None:
    """Git auto-commit after each completed build."""
    git_dir = os.path.join(project_path, ".git")
    if not os.path.exists(git_dir):
        return
    
    try:
        model = get_model_for_role("quick")
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={
                    "model": model,
                    "prompt": f"Write a concise git commit message (max 72 chars) for: {task_description}",
                    "stream": False,
                    "options": {"temperature": 0.3, "num_predict": 100},
                },
            )
            commit_msg = resp.json().get("response", "Auto-commit by Cortex").strip()
            commit_msg = commit_msg.split('\n')[0][:72]
        
        subprocess.run(["git", "add", "."], cwd=project_path, capture_output=True, timeout=10)
        subprocess.run(["git", "commit", "-m", commit_msg], cwd=project_path, capture_output=True, timeout=10)
    except Exception:
        pass
