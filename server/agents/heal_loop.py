"""
Self-healing loop: run build/test command and report failures for patching.
"""
from __future__ import annotations

import asyncio
import os
from typing import Dict, Any, List, Tuple


def _detect_commands(project_path: str) -> List[List[str]]:
    cmds: List[List[str]] = []
    if os.path.exists(os.path.join(project_path, "package.json")):
        cmds.append(["npm", "run", "build"])
    if os.path.exists(os.path.join(project_path, "pytest.ini")) or os.path.exists(os.path.join(project_path, "tests")):
        cmds.append(["python", "-m", "pytest", "-q"])
    if not cmds:
        cmds.append(["python", "-m", "py_compile", "main.py"])
    return cmds


async def _run_cmd(project_path: str, cmd: List[str], timeout_sec: int = 120) -> Tuple[bool, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=project_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        return False, f"timeout: {' '.join(cmd)}"
    except Exception as exc:
        return False, f"exec_error: {' '.join(cmd)} :: {exc}"

    out = (stdout or b"").decode("utf-8", errors="ignore")
    err = (stderr or b"").decode("utf-8", errors="ignore")
    combined = "\n".join(part for part in [out, err] if part.strip())
    return proc.returncode == 0, combined.strip()


async def run_heal_loop(project_path: str, max_iterations: int = 3) -> Dict[str, Any]:
    commands = _detect_commands(project_path)
    final_errors: List[str] = []

    for iteration in range(1, max_iterations + 1):
        iter_errors: List[str] = []
        for cmd in commands:
            ok, output = await _run_cmd(project_path, cmd)
            if not ok:
                iter_errors.append(f"$ {' '.join(cmd)}\n{output}")

        if not iter_errors:
            return {"ok": True, "iterations_taken": iteration, "errors": []}

        final_errors = iter_errors

    return {"ok": False, "iterations_taken": max_iterations, "errors": final_errors}
