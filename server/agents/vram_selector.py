"""
VRAM-aware model selector that chooses the best available model from a pool.
"""
from __future__ import annotations

from typing import Dict, Any, List

from config.models import fetch_ollama_models
from config.pools import MODEL_BENCHMARKS


def _model_size_map(models: List[Dict[str, Any]]) -> Dict[str, int]:
    size_map: Dict[str, int] = {}
    for item in models:
        name = str(item.get("name", "")).strip()
        if not name:
            continue
        size_map[name] = int(item.get("size") or 0)
    return size_map


async def select_model(pool: List[str], prefer_quality: bool = True) -> str:
    """
    Select a model from a specialist pool that is currently installed.

    Strategy:
    1) keep order preference from pool
    2) if multiple are installed, score by coding/reasoning with optional latency bias
    3) fallback to first pool item when no installed match exists
    """
    if not pool:
        return "qwen2.5:7b"

    installed = await fetch_ollama_models()
    size_map = _model_size_map(installed)

    candidates = [m for m in pool if m in size_map]
    if not candidates:
        return pool[0]

    def score(model_name: str) -> float:
        bench = MODEL_BENCHMARKS.get(model_name, {})
        coding = float(bench.get("coding", 0.5))
        reasoning = float(bench.get("reasoning", 0.5))
        latency = float(bench.get("latency", 0.5))
        if prefer_quality:
            return (coding * 0.6) + (reasoning * 0.3) + ((1.0 - latency) * 0.1)
        return (coding * 0.35) + (reasoning * 0.15) + (latency * 0.5)

    best = max(candidates, key=score)
    return best
