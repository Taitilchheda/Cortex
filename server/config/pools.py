"""
Model pools and benchmark metadata for Cortex v2 agent routing.
"""
from __future__ import annotations

from typing import Dict, List, Any

# Preferred model pools per specialist role. First entry is preferred when available.
SPECIALIST_POOLS: Dict[str, List[str]] = {
    "architect": ["qwen3-coder:latest", "deepseek-coder-v2:16b", "qwen2.5-coder:7b"],
    "frontend": ["qwen2.5-coder:7b", "llama3.1:8b", "qwen2.5:7b"],
    "backend": ["deepseek-coder-v2:16b", "qwen3-coder:latest", "deepseek-coder:6.7b", "qwen2.5-coder:7b"],
    "ml": ["deepseek-r1:7b", "qwen3-coder:latest", "deepseek-coder-v2:16b"],
    "docs": ["llama3.1:8b", "qwen2.5:7b", "deepseek-r1:7b"],
    "debug": ["deepseek-r1:7b", "qwen3-coder:latest", "llama3.1:8b"],
    "review": ["deepseek-r1:7b", "llama3.1:8b"],
    "dispatcher": ["qwen2.5:7b", "llama3.1:8b"],
}

# Lightweight benchmark hints used for selector tie-breaks and UI diagnostics.
MODEL_BENCHMARKS: Dict[str, Dict[str, Any]] = {
    "deepseek-coder-v2:16b": {"coding": 0.95, "reasoning": 0.78, "latency": 0.55},
    "qwen3-coder:latest": {"coding": 0.90, "reasoning": 0.82, "latency": 0.62},
    "qwen2.5-coder:7b": {"coding": 0.82, "reasoning": 0.65, "latency": 0.84},
    "deepseek-r1:7b": {"coding": 0.75, "reasoning": 0.94, "latency": 0.58},
    "llama3.1:8b": {"coding": 0.68, "reasoning": 0.74, "latency": 0.70},
    "qwen2.5:7b": {"coding": 0.64, "reasoning": 0.60, "latency": 0.86},
    "deepseek-coder:6.7b": {"coding": 0.72, "reasoning": 0.62, "latency": 0.80},
}
