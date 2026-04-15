"""
Cortex v3 scaffold: hardware telemetry endpoints.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import threading
import time
from typing import Any, Dict

from fastapi import APIRouter
from fastapi.responses import StreamingResponse


router = APIRouter(prefix="/hardware", tags=["hardware"])

try:
    import psutil  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    psutil = None


_SMOOTH_ALPHA = 0.28
_MIN_SAMPLE_INTERVAL_SEC = 1.0
_hardware_lock = threading.Lock()
_last_snapshot: Dict[str, Any] | None = None
_last_sample_ts = 0.0


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _ema(prev: Any, current: Any, alpha: float = _SMOOTH_ALPHA) -> float | None:
    prev_val = _as_float(prev)
    curr_val = _as_float(current)
    if curr_val is None:
        return prev_val
    if prev_val is None:
        return curr_val
    return round(prev_val + ((curr_val - prev_val) * alpha), 2)


def _smooth_snapshot(prev: Dict[str, Any] | None, current: Dict[str, Any]) -> Dict[str, Any]:
    if not prev:
        return current

    smoothed = dict(current)

    prev_cpu = prev.get("cpu") or {}
    curr_cpu = dict(current.get("cpu") or {})
    curr_cpu["utilization_pct"] = _ema(prev_cpu.get("utilization_pct"), curr_cpu.get("utilization_pct"))
    smoothed["cpu"] = curr_cpu

    prev_ram = prev.get("ram") or {}
    curr_ram = dict(current.get("ram") or {})
    curr_ram["utilization_pct"] = _ema(prev_ram.get("utilization_pct"), curr_ram.get("utilization_pct"))
    curr_ram["used_mb"] = _ema(prev_ram.get("used_mb"), curr_ram.get("used_mb"))
    smoothed["ram"] = curr_ram

    prev_gpu = prev.get("gpu") or {}
    curr_gpu = dict(current.get("gpu") or {})
    if curr_gpu.get("available"):
        curr_gpu["utilization_pct"] = _ema(prev_gpu.get("utilization_pct"), curr_gpu.get("utilization_pct"))
        curr_gpu["memory_used_mb"] = _ema(prev_gpu.get("memory_used_mb"), curr_gpu.get("memory_used_mb"))
        curr_gpu["temperature_c"] = _ema(prev_gpu.get("temperature_c"), curr_gpu.get("temperature_c"))
    smoothed["gpu"] = curr_gpu

    return smoothed


def _query_nvidia() -> Dict[str, Any]:
    try:
        proc = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if proc.returncode != 0:
            return {"available": False}
        rows = [r.strip() for r in (proc.stdout or "").splitlines() if r.strip()]
        if not rows:
            return {"available": False}
        parts = [p.strip() for p in rows[0].split(",")]
        if len(parts) < 4:
            return {"available": False}
        return {
            "available": True,
            "utilization_pct": float(parts[0]),
            "memory_used_mb": float(parts[1]),
            "memory_total_mb": float(parts[2]),
            "temperature_c": float(parts[3]),
        }
    except Exception:
        return {"available": False}


def get_hardware_snapshot() -> Dict[str, Any]:
    global _last_sample_ts, _last_snapshot

    now = time.time()
    with _hardware_lock:
        if _last_snapshot and (now - _last_sample_ts) < _MIN_SAMPLE_INTERVAL_SEC:
            cached = dict(_last_snapshot)
            cached["timestamp"] = now
            return cached

        cpu_pct = psutil.cpu_percent(interval=0.0) if psutil else None
        ram = psutil.virtual_memory() if psutil else None
        raw = {
            "timestamp": now,
            "cpu": {
                "utilization_pct": cpu_pct,
            },
            "ram": {
                "used_mb": round((ram.used / (1024 * 1024)), 2) if ram else None,
                "total_mb": round((ram.total / (1024 * 1024)), 2) if ram else None,
                "utilization_pct": ram.percent if ram else None,
            },
            "gpu": _query_nvidia(),
        }

        smoothed = _smooth_snapshot(_last_snapshot, raw)
        _last_snapshot = smoothed
        _last_sample_ts = now
        return dict(smoothed)


@router.get("/stats")
async def hardware_stats():
    return get_hardware_snapshot()


@router.get("/stats/stream")
async def hardware_stats_stream():
    async def event_stream():
        while True:
            payload = get_hardware_snapshot()
            yield f"data: {json.dumps(payload)}\n\n"
            await asyncio.sleep(2)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
    )
