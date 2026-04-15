import httpx
import json
import os
from typing import List, Dict, Any, AsyncGenerator
from config.models import get_model_for_role, OLLAMA_BASE

async def run_code_review(project_path: str, changed_files: List[str]) -> AsyncGenerator[Dict[str, Any], None]:
    """
    Automated review pass over changed files.
    """
    yield {"type": "log", "data": {"phase": "review_start", "message": f"🔍 Starting automated review of {len(changed_files)} files..."}}
    
    review_model = get_model_for_role("review")
    
    # Read modified file contents
    context = ""
    for f in changed_files:
        full_p = os.path.join(project_path, f)
        if os.path.exists(full_p):
            with open(full_p, 'r', encoding='utf-8') as src:
                context += f"\n--- File: {f} ---\n{src.read()}\n"

    prompt = f"""You are a senior security researcher and staff engineer.
Review the following code for:
1. Security vulnerabilities (SQLi, XSS, insecure deps).
2. Performance bottlenecks (unindexed queries, unnecessary re-renders).
3. Anti-patterns (DRY violations, lack of error handling).
4. Code quality (readability, naming).

{context}

Output your findings as valid JSON with this structure:
[{{"path": "file_path", "line": 0, "severity": "high|med|low", "issue": "brief description", "fix": "suggested code changes"}}]
"""

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={
                    "model": review_model,
                    "prompt": prompt,
                    "format": "json",
                    "stream": False,
                    "options": {"temperature": 0.2, "num_predict": 2048},
                },
            )
            raw = resp.json().get("response", "[]")
            # Cleaning up potential markdown fences if Ollama ignored format:json
            if "```" in raw:
                raw = raw.split("```")[1].replace("json", "").strip()
            
            findings = json.loads(raw)
            yield {"type": "log", "data": {"phase": "review_done", "message": "✅ Automated review complete.", "findings": findings}}
            
    except Exception as e:
        yield {"type": "error", "data": {"message": f"Review Error: {str(e)}"}}
