"""
Cortex — Model Configuration & Routing
Role-key based routing so the frontend never needs to know model names.
"""
import httpx
from typing import Dict, Any, Optional

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

async def recommend_models(vram_gb: float, ram_gb: float, priority: str = "balanced") -> dict:
    """
    Real-data advisor: fetches actual model sizes from Ollama,
    applies 1.15× overhead, and ranks by benchmark scores.
    """
    models = await fetch_ollama_models()
    vram_bytes = vram_gb * 1024**3
    ram_bytes = ram_gb * 1024**3

    recommendations = []
    for m in models:
        name = m.get("name", "")
        size = m.get("size", 0)
        runtime_vram = size * VRAM_OVERHEAD_FACTOR

        fits_vram = runtime_vram <= vram_bytes
        fits_ram = size <= ram_bytes

        bench = BENCHMARK_DB.get(name, None)
        humaneval = bench["humaneval"] if bench else 0
        rank = bench["rank"] if bench else "?"
        specialty = bench["specialty"] if bench else "General"

        recommendations.append({
            "model": name,
            "size_gb": round(size / (1024**3), 2),
            "runtime_vram_gb": round(runtime_vram / (1024**3), 2),
            "fits_vram": fits_vram,
            "needs_ram_offload": not fits_vram and fits_ram,
            "humaneval": humaneval,
            "rank": rank,
            "specialty": specialty,
        })

    # Sort by priority
    if priority == "speed":
        recommendations.sort(key=lambda x: x["size_gb"])
    elif priority == "quality":
        recommendations.sort(key=lambda x: -x["humaneval"])
    else:  # balanced
        recommendations.sort(key=lambda x: (-x["humaneval"], x["size_gb"]))

    # Generate suggested router
    suggested_router = {}
    vram_models = [r for r in recommendations if r["fits_vram"]]
    all_usable = [r for r in recommendations if r["fits_vram"] or r["needs_ram_offload"]]

    best_by_score = sorted(all_usable, key=lambda x: -x["humaneval"])
    fastest = sorted(vram_models, key=lambda x: x["size_gb"]) if vram_models else best_by_score[:1]

    if best_by_score:
        suggested_router["architect"] = best_by_score[0]["model"]
        suggested_router["coder"] = best_by_score[0]["model"]
        suggested_router["review"] = best_by_score[0]["model"]
    if len(best_by_score) > 1:
        suggested_router["debug"] = best_by_score[1]["model"]
        suggested_router["explain"] = best_by_score[1]["model"]
    if fastest:
        suggested_router["quick"] = fastest[0]["model"]

    return {
        "models": recommendations,
        "suggested_router": suggested_router,
        "vram_gb": vram_gb,
        "ram_gb": ram_gb,
        "priority": priority,
    }
