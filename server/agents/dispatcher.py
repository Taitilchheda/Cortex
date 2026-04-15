"""
Task dispatcher: classify architect-planned files into specialist domains.
"""
from __future__ import annotations

from typing import Dict, Any, List

DOMAIN_FRONTEND = "frontend"
DOMAIN_BACKEND = "backend"
DOMAIN_ML = "ml"
DOMAIN_DOCS = "docs"

_FRONTEND_EXT = {".tsx", ".ts", ".jsx", ".js", ".css", ".scss", ".html", ".svg"}
_BACKEND_EXT = {".py", ".go", ".rs", ".java"}
_ML_HINTS = ("train", "model", "dataset", "inference", "huggingface", "torch", "ml", "numpy", "pandas")
_DOC_HINTS = ("readme", "dockerfile", ".env", "github/workflows", "license", "contributing", "yaml", "yml", "toml")


def _classify_file(path: str, description: str) -> str:
    p = (path or "").lower()
    d = (description or "").lower()

    # Stage 1: fast rule-based mapping.
    for hint in _DOC_HINTS:
        if hint in p:
            return DOMAIN_DOCS

    if p.endswith((".md", ".yml", ".yaml", ".toml", ".ini", ".env", "dockerfile")):
        return DOMAIN_DOCS

    if any(h in p or h in d for h in _ML_HINTS):
        return DOMAIN_ML

    for ext in _FRONTEND_EXT:
        if p.endswith(ext):
            if p.endswith(".ts") and ("server/" in p or "api/" in p):
                return DOMAIN_BACKEND
            return DOMAIN_FRONTEND

    for ext in _BACKEND_EXT:
        if p.endswith(ext):
            return DOMAIN_BACKEND

    if "/docs/" in p or p.startswith("docs/"):
        return DOMAIN_DOCS
    if "/dashboard/" in p or p.startswith("dashboard/"):
        return DOMAIN_FRONTEND
    if "/server/" in p or p.startswith("server/"):
        return DOMAIN_BACKEND

    return DOMAIN_BACKEND


async def dispatch(plan: Dict[str, Any], session_id: str) -> List[Dict[str, Any]]:
    """
    Return plan files augmented with specialist assignment and stage metadata.
    """
    files = plan.get("files", []) if isinstance(plan, dict) else []
    out: List[Dict[str, Any]] = []
    for file_spec in files:
        if not isinstance(file_spec, dict):
            continue
        path = str(file_spec.get("path", ""))
        desc = str(file_spec.get("description") or file_spec.get("purpose") or "")
        specialist = _classify_file(path, desc)
        enriched = dict(file_spec)
        enriched["specialist"] = specialist
        enriched["classification_stage"] = 1
        enriched["session_id"] = session_id
        out.append(enriched)
    return out
