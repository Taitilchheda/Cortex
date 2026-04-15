"""
Merger + validator for specialist outputs.
"""
from __future__ import annotations

import json
from typing import Dict, Any, List, Tuple


def _sort_by_priority(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(items, key=lambda item: int(item.get("priority", 999)))


def _validate_json_if_needed(path: str, content: str) -> Tuple[bool, str]:
    if not path.lower().endswith(".json"):
        return True, ""
    try:
        json.loads(content)
        return True, ""
    except Exception as exc:
        return False, str(exc)


async def merge_and_validate(
    planned_files: List[Dict[str, Any]],
    generated: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Merge generated file payloads into a deterministic write set and run lightweight validation.
    """
    by_path: Dict[str, Dict[str, Any]] = {}
    for row in _sort_by_priority(planned_files):
        path = str(row.get("path", ""))
        if path:
            by_path[path] = {
                "path": path,
                "priority": int(row.get("priority", 999)),
                "specialist": row.get("specialist", "backend"),
                "content": None,
            }

    errors: List[Dict[str, Any]] = []
    for row in generated:
        path = str(row.get("path", ""))
        content = row.get("content")
        if path not in by_path:
            by_path[path] = {
                "path": path,
                "priority": 999,
                "specialist": row.get("specialist", "backend"),
                "content": content,
            }
        else:
            by_path[path]["content"] = content

    writes: List[Dict[str, Any]] = []
    for path, row in by_path.items():
        content = row.get("content")
        if not isinstance(content, str) or not content.strip():
            errors.append({"path": path, "error": "missing_content"})
            continue

        is_ok, err = _validate_json_if_needed(path, content)
        if not is_ok:
            errors.append({"path": path, "error": f"invalid_json: {err}"})
            continue

        writes.append(
            {
                "path": path,
                "content": content,
                "specialist": row.get("specialist", "backend"),
                "priority": row.get("priority", 999),
            }
        )

    writes.sort(key=lambda item: int(item.get("priority", 999)))
    return {"writes": writes, "errors": errors}
