"""
Cortex — Model Configuration & Routing
Role-key based routing so the frontend never needs to know model names.
"""
import asyncio
import glob
import httpx
import json
import os
import re
import shutil
import subprocess
import time
from typing import Dict, Any, Optional, List

# ─── Default Model Router ─────────────────────────────────────────
# Maps role keys to Ollama model names. Swapping models = editing this dict.
MODEL_ROUTER: Dict[str, str] = {
    "architect": "qwen3-coder:latest",
    "coder":     "deepseek-coder-v2:16b",
    "debug":     "deepseek-r1:7b",
    "quick":     "qwen2.5:7b",
    "explain":   "llama3.1:8b",
    "review":    "deepseek-r1:7b",
}

OLLAMA_BASE = "http://localhost:11434"
EVALPLUS_RESULTS_URL = "https://evalplus.github.io/results.json"
EVALPLUS_CACHE_TTL_SEC = int(os.getenv("EVALPLUS_CACHE_TTL_SEC", "21600"))
LLMFIT_WINDOWS_GLOB = os.path.join("tools", "llmfit", "**", "llmfit.exe")

# ─── Benchmark Database ───────────────────────────────────────────
# Curated HumanEval / MBPP pass@1 scores for coding-rank display.
BENCHMARK_DB: Dict[str, Dict[str, Any]] = {
    "deepseek-coder-v2:16b": {"humaneval": 78.6, "mbpp": 73.1, "rank": "S",  "specialty": "Code generation, completion"},
    "qwen3-coder:latest":    {"humaneval": 72.0, "mbpp": 68.0, "rank": "A+", "specialty": "Planning, architecture"},
    "deepseek-r1:7b":        {"humaneval": 65.2, "mbpp": 60.8, "rank": "A",  "specialty": "Reasoning, debugging"},
    "qwen2.5:7b":            {"humaneval": 61.4, "mbpp": 58.3, "rank": "A",  "specialty": "Fast completions"},
    "llama3.1:8b":           {"humaneval": 55.0, "mbpp": 52.1, "rank": "B+", "specialty": "Documentation, explanation"},
    "codellama:7b":          {"humaneval": 48.2, "mbpp": 45.0, "rank": "B",  "specialty": "Code infill, legacy"},
    "starcoder2:7b":         {"humaneval": 46.0, "mbpp": 43.5, "rank": "B",  "specialty": "Multi-language code"},
    "phi3:mini":             {"humaneval": 42.0, "mbpp": 40.0, "rank": "B-", "specialty": "Lightweight tasks"},
}

VRAM_OVERHEAD_FACTOR = 1.15  # Runtime VRAM ≈ file_size × 1.15
_EVALPLUS_CACHE: Dict[str, Any] = {"updated_at": 0.0, "entries": []}
_EVALPLUS_LOCK = asyncio.Lock()


def _normalize_model_name(name: str) -> str:
    lowered = (name or "").lower().strip()
    # Remove Ollama tag suffixes like :latest, while keeping size tags for matching.
    lowered = lowered.replace(":latest", "")
    lowered = lowered.replace(":instruct", "")
    lowered = lowered.replace(":chat", "")
    lowered = lowered.replace("_", "-")
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    tokens = [
        tok for tok in lowered.split()
        if tok not in {"instruct", "chat", "preview", "release", "model", "it", "hf"}
    ]
    return " ".join(tokens)


def _extract_size_b(name: str) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)\s*b\b", (name or "").lower())
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def _extract_qwen_version(name: str) -> float | None:
    match = re.search(r"qwen\s*([0-9]+(?:\.[0-9]+)?)", (name or "").lower())
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def _model_family(name: str) -> str:
    lowered = (name or "").lower()
    for family in ("deepseek", "qwen", "llama", "mistral", "starcoder", "codegemma", "phi", "gemma"):
        if family in lowered:
            return family
    return ""


def _score_to_rank(score: float | None) -> str:
    if score is None:
        return "?"
    if score >= 85:
        return "S"
    if score >= 78:
        return "A+"
    if score >= 70:
        return "A"
    if score >= 62:
        return "B+"
    if score >= 54:
        return "B"
    if score >= 45:
        return "C+"
    return "C"


def _infer_specialty(model_name: str) -> str:
    n = (model_name or "").lower()
    if "coder" in n or "code" in n:
        return "Code generation, completion"
    if "deepseek-r1" in n or "reason" in n:
        return "Reasoning, debugging"
    if "qwen3" in n:
        return "Planning, architecture"
    if "llama" in n:
        return "Documentation, explanation"
    return "General"


def _evalplus_quality(pass_at_1: Dict[str, Any]) -> float | None:
    hv_plus = pass_at_1.get("humaneval+")
    mbpp_plus = pass_at_1.get("mbpp+")
    hv = pass_at_1.get("humaneval")
    mbpp = pass_at_1.get("mbpp")

    if isinstance(hv_plus, (int, float)) and isinstance(mbpp_plus, (int, float)):
        return round((float(hv_plus) + float(mbpp_plus)) / 2.0, 1)
    if isinstance(hv_plus, (int, float)):
        return float(hv_plus)
    if isinstance(hv, (int, float)) and isinstance(mbpp, (int, float)):
        return round((float(hv) + float(mbpp)) / 2.0, 1)
    if isinstance(hv, (int, float)):
        return float(hv)
    return None


def _build_evalplus_entries(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries: List[Dict[str, Any]] = []
    for model_name, details in payload.items():
        if not isinstance(details, dict):
            continue
        pass_at_1 = details.get("pass@1") if isinstance(details.get("pass@1"), dict) else {}
        quality = _evalplus_quality(pass_at_1)
        normalized = _normalize_model_name(model_name)
        token_set = set(normalized.split())
        entries.append({
            "model": model_name,
            "normalized": normalized,
            "tokens": token_set,
            "size_b": details.get("size"),
            "quality": quality,
            "pass@1": pass_at_1,
            "link": details.get("link"),
        })
    return entries


async def fetch_evalplus_entries() -> List[Dict[str, Any]]:
    now = time.time()
    if now - float(_EVALPLUS_CACHE.get("updated_at", 0.0)) < EVALPLUS_CACHE_TTL_SEC:
        cached = _EVALPLUS_CACHE.get("entries")
        if isinstance(cached, list):
            return cached

    async with _EVALPLUS_LOCK:
        now = time.time()
        if now - float(_EVALPLUS_CACHE.get("updated_at", 0.0)) < EVALPLUS_CACHE_TTL_SEC:
            cached = _EVALPLUS_CACHE.get("entries")
            if isinstance(cached, list):
                return cached

        try:
            async with httpx.AsyncClient(timeout=12) as client:
                resp = await client.get(EVALPLUS_RESULTS_URL)
                if resp.status_code == 200:
                    payload = resp.json()
                    if isinstance(payload, dict):
                        entries = _build_evalplus_entries(payload)
                        _EVALPLUS_CACHE["entries"] = entries
                        _EVALPLUS_CACHE["updated_at"] = time.time()
                        return entries
        except Exception:
            pass

        cached = _EVALPLUS_CACHE.get("entries")
        return cached if isinstance(cached, list) else []


def _find_evalplus_match(model_name: str, runtime_vram_gb: float, entries: List[Dict[str, Any]]) -> Dict[str, Any] | None:
    if not entries:
        return None

    normalized = _normalize_model_name(model_name)
    tokens = set(normalized.split())
    source_lower = (model_name or "").lower()
    source_family = _model_family(source_lower)
    source_has_coder = ("coder" in source_lower) or ("code" in source_lower)
    source_has_r1 = "r1" in source_lower
    source_has_embed = "embed" in source_lower

    if source_has_embed:
        return None

    model_size_b = _extract_size_b(model_name) or max(runtime_vram_gb / max(VRAM_OVERHEAD_FACTOR, 1e-6), 0.0)

    aliases = {
        "deepseek coder v2": "deepseek coder v2",
        "qwen2 5 coder": "qwen2 5 coder",
        "qwen 2 5 coder": "qwen2 5 coder",
        "llama3 1 8b": "llama3 1 8b",
    }

    best_alias = None
    for alias_key, alias_target in aliases.items():
        if alias_key in normalized:
            for entry in entries:
                if alias_target in entry.get("normalized", ""):
                    best_alias = entry
                    break
        if best_alias:
            break
    if best_alias:
        return best_alias

    best: Dict[str, Any] | None = None
    best_score = 0.0

    for entry in entries:
        entry_tokens = entry.get("tokens") or set()
        if not entry_tokens or not tokens:
            continue

        entry_name = str(entry.get("model") or "").lower()
        entry_family = _model_family(entry_name)
        if source_family and entry_family != source_family:
            continue

        entry_has_coder = ("coder" in entry_name) or ("code" in entry_name)
        entry_has_r1 = "r1" in entry_name

        if source_has_r1 and not entry_has_r1:
            continue
        if source_has_coder and not entry_has_coder:
            continue
        if (not source_has_coder) and entry_has_coder and source_family == entry_family:
            continue

        source_qwen_ver = _extract_qwen_version(source_lower)
        entry_qwen_ver = _extract_qwen_version(entry_name)
        if source_qwen_ver is not None and entry_qwen_ver is not None:
            if abs(source_qwen_ver - entry_qwen_ver) > 0.4:
                continue

        overlap = len(tokens & entry_tokens)
        if overlap == 0:
            continue

        denom = max(len(tokens) + len(entry_tokens), 1)
        token_score = (2.0 * overlap) / denom

        entry_norm = entry.get("normalized", "")
        contains_bonus = 0.15 if (normalized in entry_norm or entry_norm in normalized) else 0.0

        size_score = 0.0
        entry_size = entry.get("size_b")
        if isinstance(entry_size, (int, float)) and model_size_b:
            diff = abs(float(entry_size) - float(model_size_b))
            size_score = max(0.0, 1.0 - (diff / max(float(model_size_b), float(entry_size), 1.0))) * 0.25

        score = token_score + contains_bonus + size_score
        if score > best_score:
            best_score = score
            best = entry

    return best if best_score >= 0.42 else None

def get_model_for_role(role: str) -> str:
    """Resolve a role key to an Ollama model name."""
    return MODEL_ROUTER.get(role, MODEL_ROUTER.get("coder", "qwen2.5:7b"))

def update_router(new_mapping: Dict[str, str]) -> Dict[str, str]:
    """Live-update the MODEL_ROUTER. No restart needed."""
    global MODEL_ROUTER
    MODEL_ROUTER.update(new_mapping)
    return MODEL_ROUTER

async def fetch_ollama_models() -> list:
    """Fetch installed models from Ollama with real file sizes."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{OLLAMA_BASE}/api/tags")
            if resp.status_code == 200:
                data = resp.json()
                return data.get("models", [])
    except Exception:
        pass
    return []

async def check_ollama_health() -> dict:
    """Quick health probe for Ollama."""
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            resp = await client.get(f"{OLLAMA_BASE}/api/tags")
            if resp.status_code == 200:
                models = resp.json().get("models", [])
                return {"status": "connected", "model_count": len(models)}
    except Exception as e:
        return {"status": "disconnected", "error": str(e)}
    return {"status": "unknown"}


def _repo_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def resolve_llmfit_binary() -> str | None:
    env_path = os.getenv("LLMFIT_BIN")
    candidates: List[str] = []
    if env_path:
        candidates.append(env_path)

    repo_candidate_glob = os.path.join(_repo_root(), LLMFIT_WINDOWS_GLOB)
    candidates.extend(glob.glob(repo_candidate_glob, recursive=True))

    which_path = shutil.which("llmfit")
    if which_path:
        candidates.append(which_path)

    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def _fit_level_rank(value: str) -> int:
    cleaned = (value or "").strip().lower().replace(" ", "")
    if cleaned == "perfect":
        return 4
    if cleaned == "good":
        return 3
    if cleaned == "marginal":
        return 2
    if cleaned in {"tootight", "tight"}:
        return 1
    return 0


def _priority_sort_key(item: Dict[str, Any], priority: str) -> tuple:
    fit_rank = _fit_level_rank(str(item.get("fit_level") or ""))
    score = float(item.get("score") or 0.0)
    sc = item.get("score_components") if isinstance(item.get("score_components"), dict) else {}
    quality = float(sc.get("quality") or 0.0)
    speed = float(item.get("estimated_tps") or 0.0)
    mem = float(item.get("memory_required_gb") or 0.0)

    if priority == "speed":
        return (-fit_rank, -speed, -score, mem)
    if priority == "quality":
        return (-fit_rank, -quality, -score, mem)
    return (-fit_rank, -score, -quality, mem)


def _suggested_router_from_llmfit(models: List[Dict[str, Any]]) -> Dict[str, str]:
    if not models:
        return {}

    suggested: Dict[str, str] = {}
    suggested["architect"] = models[0].get("name", "")
    suggested["coder"] = models[0].get("name", "")
    suggested["review"] = models[0].get("name", "")

    if len(models) > 1:
        suggested["debug"] = models[1].get("name", "")
        suggested["explain"] = models[1].get("name", "")

    # Quick role prefers the fastest runnable model.
    fastest = sorted(
        models,
        key=lambda m: (-_fit_level_rank(str(m.get("fit_level") or "")), -float(m.get("estimated_tps") or 0.0)),
    )
    if fastest:
        suggested["quick"] = fastest[0].get("name", "")

    return {k: v for k, v in suggested.items() if isinstance(v, str) and v}


async def _run_llmfit_recommend(vram_gb: float, ram_gb: float) -> Dict[str, Any]:
    llmfit_bin = resolve_llmfit_binary()
    if not llmfit_bin:
        return {
            "status": "unavailable",
            "models": [],
            "suggested_router": {},
            "error": "llmfit binary not found. Install llmfit and set LLMFIT_BIN if needed.",
            "data_sources": {
                "engine": "llmfit",
                "model_database": "HuggingFace via llmfit",
                "scoring": "quality/speed/fit/context (llmfit)",
                "binary": None,
                "install_hint_windows": "https://github.com/AlexsJones/llmfit",
            },
            "generated_at": time.time(),
        }

    args = [
        llmfit_bin,
        f"--memory={max(vram_gb, 0.0)}G",
        f"--ram={max(ram_gb, 0.0)}G",
        "recommend",
        "--json",
        "--limit",
        "15",
        "--use-case",
        "coding",
    ]

    async def _exec_llmfit() -> tuple[int, bytes, bytes]:
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
            return int(proc.returncode or 0), (stdout or b""), (stderr or b"")
        except NotImplementedError:
            # On some Windows event-loop policies, asyncio subprocess APIs are unavailable.
            def _run_blocking() -> tuple[int, bytes, bytes]:
                proc = subprocess.run(
                    args,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    check=False,
                )
                return int(proc.returncode or 0), (proc.stdout or b""), (proc.stderr or b"")

            return await asyncio.to_thread(_run_blocking)

    try:
        returncode, stdout, stderr = await _exec_llmfit()
    except Exception as exc:
        return {
            "status": "error",
            "models": [],
            "suggested_router": {},
            "error": f"llmfit execution failed: {exc}",
            "data_sources": {
                "engine": "llmfit",
                "model_database": "HuggingFace via llmfit",
                "scoring": "quality/speed/fit/context (llmfit)",
                "binary": llmfit_bin,
            },
            "generated_at": time.time(),
        }

    if returncode != 0:
        err = (stderr or b"").decode("utf-8", errors="ignore").strip() or "llmfit failed"
        return {
            "status": "error",
            "models": [],
            "suggested_router": {},
            "error": err,
            "data_sources": {
                "engine": "llmfit",
                "model_database": "HuggingFace via llmfit",
                "scoring": "quality/speed/fit/context (llmfit)",
                "binary": llmfit_bin,
            },
            "generated_at": time.time(),
        }

    text = (stdout or b"{}").decode("utf-8", errors="ignore").strip()
    try:
        payload = json.loads(text) if text else {}
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    return {
        "status": "ok",
        "llmfit_binary": llmfit_bin,
        "raw": payload,
    }

async def recommend_models(vram_gb: float, ram_gb: float, priority: str = "balanced") -> dict:
    """
    llmfit-backed advisor: use the same recommendation source and score
    dimensions as llmfit (no synthetic benchmark fallback in this endpoint).
    """
    llmfit_result = await _run_llmfit_recommend(vram_gb, ram_gb)
    if llmfit_result.get("status") != "ok":
        return {
            "models": [],
            "suggested_router": {},
            "vram_gb": vram_gb,
            "ram_gb": ram_gb,
            "priority": priority,
            "status": llmfit_result.get("status", "unavailable"),
            "error": llmfit_result.get("error"),
            "data_sources": llmfit_result.get("data_sources", {}),
            "generated_at": llmfit_result.get("generated_at", time.time()),
        }

    payload = llmfit_result.get("raw") if isinstance(llmfit_result.get("raw"), dict) else {}
    raw_models = payload.get("models") if isinstance(payload.get("models"), list) else []
    raw_models = [m for m in raw_models if isinstance(m, dict)]
    raw_models.sort(key=lambda m: _priority_sort_key(m, priority))

    recommendations: List[Dict[str, Any]] = []
    for row in raw_models:
        run_mode = str(row.get("run_mode") or "")
        fit_level = str(row.get("fit_level") or "")
        score_components = row.get("score_components") if isinstance(row.get("score_components"), dict) else {}
        overall_score = float(row.get("score") or 0.0)
        quality_score = float(score_components.get("quality") or overall_score)
        memory_required = float(row.get("memory_required_gb") or 0.0)
        memory_available = float(row.get("memory_available_gb") or 0.0)
        fits_vram = run_mode.strip().lower() == "gpu" and _fit_level_rank(fit_level) > 1
        needs_ram_offload = ("offload" in run_mode.lower()) or ("moe" in run_mode.lower() and float(row.get("moe_offloaded_gb") or 0.0) > 0.0)

        recommendations.append({
            "model": row.get("name"),
            "rank": _score_to_rank(overall_score),
            "specialty": row.get("use_case") or row.get("category") or _infer_specialty(str(row.get("name") or "")),
            "quality_score": round(quality_score, 1),
            "humaneval": round(quality_score, 1),
            "runtime_vram_gb": round(memory_required, 2),
            "fits_vram": fits_vram,
            "needs_ram_offload": needs_ram_offload,
            "benchmark_source": "llmfit_cli",
            "benchmark_model": row.get("name"),
            "balanced_score": round(overall_score, 1),
            "fit_level": fit_level,
            "run_mode": run_mode,
            "score": round(overall_score, 1),
            "score_components": score_components,
            "estimated_tps": row.get("estimated_tps"),
            "memory_required_gb": round(memory_required, 2),
            "memory_available_gb": round(memory_available, 2),
            "utilization_pct": row.get("utilization_pct"),
            "best_quant": row.get("best_quant"),
            "provider": row.get("provider"),
            "category": row.get("category"),
            "llmfit": row,
        })

    suggested_router = _suggested_router_from_llmfit(raw_models)

    return {
        "models": recommendations,
        "suggested_router": suggested_router,
        "vram_gb": vram_gb,
        "ram_gb": ram_gb,
        "priority": priority,
        "status": "ok",
        "llmfit_binary": llmfit_result.get("llmfit_binary"),
        "system": payload.get("system") if isinstance(payload.get("system"), dict) else {},
        "data_sources": {
            "engine": "llmfit",
            "binary": llmfit_result.get("llmfit_binary"),
            "model_database": "HuggingFace via llmfit",
            "scoring": "quality/speed/fit/context (llmfit)",
            "raw_output": "llmfit recommend --json",
        },
        "generated_at": time.time(),
    }


def normalize_unified_model(row: Dict[str, Any]) -> Dict[str, Any]:
    name = str(row.get("name") or row.get("id") or "")
    source = str(row.get("source") or "local")
    provider = str(row.get("provider") or ("ollama" if source == "local" else source))
    size_bytes = int(row.get("size") or row.get("size_bytes") or 0)
    bench = BENCHMARK_DB.get(name, {})

    pricing = row.get("pricing") if isinstance(row.get("pricing"), dict) else {}
    context_length = row.get("context_length") or row.get("ctx")
    vram_gb = row.get("vram_gb")
    if vram_gb is None and size_bytes:
        vram_gb = round((size_bytes / (1024**3)) * VRAM_OVERHEAD_FACTOR, 2)

    return {
        "id": name,
        "name": name,
        "source": source,
        "provider": provider,
        "size_bytes": size_bytes,
        "size_gb": round(size_bytes / (1024**3), 2) if size_bytes else None,
        "vram_gb": vram_gb,
        "context_length": context_length,
        "pricing": pricing,
        "benchmarks": {
            "humaneval": bench.get("humaneval"),
            "mbpp": bench.get("mbpp"),
        },
        "rank": bench.get("rank"),
        "specialty": bench.get("specialty"),
        "details": row.get("details") if isinstance(row.get("details"), dict) else {},
    }


async def fetch_unified_models() -> List[Dict[str, Any]]:
    from config.cloud import fetch_unified_model_catalog

    rows = await fetch_unified_model_catalog()
    normalized = [normalize_unified_model(row) for row in rows if isinstance(row, dict)]
    normalized.sort(key=lambda item: (item.get("source") != "local", item.get("name") or ""))
    return normalized
