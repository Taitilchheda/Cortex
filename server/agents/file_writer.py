"""
Cortex — File Writer Agent
Two-phase build pipeline:
  Phase 1 (Architect): Streams a JSON plan with file structure, dependencies, priority.
  Phase 2 (Coder): Non-streaming per-file generation with retry + smart content extraction.

Key decision: non-streaming per-file to eliminate empty-file bugs from partial writes.
"""
import re
import os
import json
import httpx
import asyncio
import subprocess
from typing import AsyncGenerator, Dict, Any, Optional
from config.models import get_model_for_role, OLLAMA_BASE

# ─── Content Extraction ──────────────────────────────────────────
def extract_code_content(raw: str, file_path: str) -> str:
    """
    Priority extraction chain:
    1. Content inside a code fence (```...```)
    2. First line matching the file's extension syntax
    3. Raw text (trimmed)
    """
    # Priority 1: code fence
    fence_pattern = r'```(?:\w+)?\s*\n(.*?)```'
    fences = re.findall(fence_pattern, raw, re.DOTALL)
    if fences:
        # Use the longest fence (most likely the actual code)
        return max(fences, key=len).strip()

    # Priority 2: extension-based detection
    ext = os.path.splitext(file_path)[1].lower()
    start_patterns = {
        '.py':   r'^(import |from |def |class |#)',
        '.js':   r'^(import |export |const |let |var |function |//|/\*)',
        '.ts':   r'^(import |export |const |let |var |function |interface |type |//|/\*)',
        '.tsx':  r'^(import |export |const |let |var |function |interface |type |//|/\*)',
        '.jsx':  r'^(import |export |const |let |var |function |//|/\*)',
        '.html': r'^(<|<!)',
        '.css':  r'^(\.|#|@|:|\*|body|html)',
        '.json': r'^\s*[\{\[]',
        '.md':   r'^(#|\*|-|\d\.)',
        '.yaml': r'^(\w+:)',
        '.yml':  r'^(\w+:)',
        '.toml': r'^\[',
        '.sql':  r'^(CREATE|ALTER|INSERT|SELECT|DROP|--)',
        '.sh':   r'^(#!/|#|export |echo )',
        '.bat':  r'^(@|echo |set |rem )',
    }
    pattern = start_patterns.get(ext)
    if pattern:
        lines = raw.split('\n')
        for i, line in enumerate(lines):
            if re.match(pattern, line.strip(), re.IGNORECASE):
                return '\n'.join(lines[i:]).strip()

    # Priority 3: raw fallback
    return raw.strip()


async def architect_phase(task: str, project_path: str) -> AsyncGenerator[Dict[str, Any], None]:
    """
    Phase 1: Architect generates a structured JSON plan.
    Streams tokens to the dashboard in real-time.
    """
    model = get_model_for_role("architect")
    
    system_prompt = """You are a senior software architect. Given a user's project description, 
generate a structured JSON plan for the entire project. Your response MUST be valid JSON wrapped in ```json fences.

The JSON structure should be:
{
  "project_name": "string",
  "description": "string",
  "tech_stack": ["string"],
  "dependencies": {"package": "version"},
  "files": [
    {
      "path": "relative/path/to/file.ext",
      "purpose": "What this file does",
      "priority": 1,
      "dependencies": ["other/file.ext"]
    }
  ]
}

Order files by priority (1 = create first). Include ALL files needed for a production-ready project.
Include config files, documentation, .gitignore, package.json, etc."""

    full_text = ""
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            async with client.stream(
                "POST",
                f"{OLLAMA_BASE}/api/generate",
                json={
                    "model": model,
                    "prompt": f"Create a complete project plan for: {task}\n\nTarget directory: {project_path}",
                    "system": system_prompt,
                    "stream": True,
                    "options": {"temperature": 0.3, "num_predict": 8192},
                },
            ) as response:
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                        token = chunk.get("response", "")
                        full_text += token
                        yield {"type": "architect_stream", "data": {"delta": token}}
                        if chunk.get("done"):
                            break
                    except json.JSONDecodeError:
                        continue
    except Exception as e:
        yield {"type": "error", "data": {"message": f"Architect phase failed: {str(e)}"}}
        return

    # Parse the plan from the accumulated text
    plan = None
    try:
        json_match = re.search(r'```json\s*\n(.*?)```', full_text, re.DOTALL)
        if json_match:
            plan = json.loads(json_match.group(1))
        else:
            # Try raw JSON parse
            json_start = full_text.find('{')
            json_end = full_text.rfind('}') + 1
            if json_start >= 0 and json_end > json_start:
                plan = json.loads(full_text[json_start:json_end])
    except json.JSONDecodeError:
        pass

    if plan:
        yield {"type": "log", "data": {"phase": "architect_done", "message": f"Plan generated: {len(plan.get('files', []))} files", "plan": plan}}
    else:
        yield {"type": "error", "data": {"message": "Failed to parse architect plan as JSON"}}


async def coder_phase(plan: dict, project_path: str, context: str = "") -> AsyncGenerator[Dict[str, Any], None]:
    """
    Phase 2: Coder generates each file using non-streaming completion.
    Key: non-streaming ensures full content arrives before writing.
    """
    model = get_model_for_role("coder")
    files = plan.get("files", [])
    files.sort(key=lambda f: f.get("priority", 99))

    for i, file_spec in enumerate(files):
        rel_path = file_spec.get("path", "")
        purpose = file_spec.get("purpose", "")
        
        if not rel_path:
            continue

        full_path = os.path.join(project_path, rel_path)
        yield {"type": "log", "data": {"phase": "coding", "message": f"Generating ({i+1}/{len(files)}): {rel_path}"}}

        prompt = f"""Write the COMPLETE, production-ready code for this file.

Project: {plan.get('project_name', 'Project')}
Description: {plan.get('description', '')}
Tech Stack: {', '.join(plan.get('tech_stack', []))}

File: {rel_path}
Purpose: {purpose}

{f'Additional context: {context}' if context else ''}

Write ONLY the file content. No explanations. No markdown fences unless the file IS a markdown file.
The code must be complete, production-ready, and properly formatted."""

        content = await _generate_file_content(model, prompt, rel_path)
        
        # Capture old content if exists
        old_content = None
        if os.path.exists(full_path):
            try:
                with open(full_path, 'r', encoding='utf-8') as f:
                    old_content = f.read()
            except: pass

        if content and len(content) < 10:
            # Retry with simplified prompt
            yield {"type": "log", "data": {"phase": "retry", "message": f"Content too short, retrying: {rel_path}"}}
            retry_prompt = f"Write the complete code for {rel_path}. Purpose: {purpose}. Just output code, nothing else."
            content = await _generate_file_content(model, retry_prompt, rel_path)

        if content and len(content) >= 10:
            try:
                os.makedirs(os.path.dirname(full_path), exist_ok=True)
                with open(full_path, 'w', encoding='utf-8') as f:
                    f.write(content)
                size = os.path.getsize(full_path)
                yield {
                    "type": "file_created",
                    "data": {
                        "path": full_path,
                        "rel_path": rel_path,
                        "message": f"✅ {rel_path} ({size} bytes)",
                        "size": size,
                        "old_content": old_content,
                        "new_content": content
                    }
                }
            except Exception as e:
                yield {"type": "error", "data": {"message": f"Failed to write {rel_path}: {str(e)}"}}
        else:
            yield {"type": "error", "data": {"message": f"Empty or too short content for {rel_path}"}}

    yield {"type": "log", "data": {"phase": "complete", "message": f"Build complete: {len(files)} files generated"}}


async def _generate_file_content(model: str, prompt: str, file_path: str) -> Optional[str]:
    """Non-streaming single-file generation. Returns extracted code content."""
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": 0.2, "num_predict": 16384},
                },
            )
            if resp.status_code == 200:
                raw = resp.json().get("response", "")
                return extract_code_content(raw, file_path)
    except Exception:
        pass
    return None


def write_file_content(project_path: str, rel_path: str, content: str) -> Dict[str, Any]:
    """Write generated content to disk and return write metadata."""
    full_path = os.path.join(project_path, rel_path)
    old_content = None
    if os.path.exists(full_path):
        try:
            with open(full_path, "r", encoding="utf-8") as src:
                old_content = src.read()
        except Exception:
            old_content = None

    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "w", encoding="utf-8") as dst:
        dst.write(content)

    size = os.path.getsize(full_path)
    return {
        "path": full_path,
        "rel_path": rel_path,
        "size": size,
        "old_content": old_content,
        "new_content": content,
    }


async def self_healing_build(task: str, project_path: str, max_attempts: int = 3) -> AsyncGenerator[Dict[str, Any], None]:
    """
    Self-healing build loop.
    Repeatedly builds and tests until success or exhaustion.
    """
    attempt = 0
    error_context = ""
    
    while attempt < max_attempts:
        attempt += 1
        yield {"type": "log", "data": {"phase": "self_heal", "message": f"🚀 Build attempt {attempt}/{max_attempts}..."}}

        # Boost the user task with error logs if retrying
        current_task = task
        if error_context:
            current_task += f"\n\n🚨 PREVIOUS ATTEMPT FAILED WITH ERRORS:\n{error_context}\nPlease FIX these errors in the next plan/files."

        # Phase 1: Architect
        plan = None
        async for event in architect_phase(current_task, project_path):
            yield event
            if event["type"] == "log" and event["data"].get("phase") == "architect_done":
                plan = event["data"].get("plan")

        if not plan:
            yield {"type": "error", "data": {"message": "Self-heal: Architect failed to generate plan"}}
            return

        # Phase 2: Coder
        async for event in coder_phase(plan, project_path, error_context):
            yield event

        # Phase 3: Verify (Self-Heal Trigger)
        yield {"type": "log", "data": {"phase": "verifying", "message": "🔍 Verifying build health..."}}
        test_result = await _run_project_tests(project_path)
        
        if test_result["success"]:
            yield {"type": "log", "data": {"phase": "complete", "message": "✅ Build successful and verified!"}}
            return
        else:
            error_context = test_result.get("output", "Unknown error")
            yield {"type": "log", "data": {"phase": "self_heal_retry", "message": f"⚠️ Verification failed (see logs). Retrying handle...", "error": error_context}}

    yield {"type": "error", "data": {"message": f"❌ Self-healing exhausted after {max_attempts} attempts. Check manually."}}


async def _run_project_tests(project_path: str) -> dict:
    """Detect and execute test runners. Capture failures for self-healing."""
    # 1. Look for obvious build/compile indicators
    # Python syntax check
    python_files = [f for f in os.listdir(project_path) if f.endswith('.py')]
    for pyf in python_files:
        try:
            full_p = os.path.join(project_path, pyf)
            subprocess.run(["python", "-m", "py_compile", full_p], check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            return {"success": False, "output": f"Syntax Error in {pyf}:\n{e.stderr.decode()}"}

    # 2. Check for missing dependencies (requirements.txt)
    if os.path.exists(os.path.join(project_path, "requirements.txt")):
        # Simple check for common package missing errors (not running full pip install here)
        pass

    # 3. Run specific test suites
    test_commands = []
    if os.path.exists(os.path.join(project_path, "package.json")):
        test_commands.append(["npm", "run", "build"]) # Build is a good 'test' for TS/Next
    if os.path.exists(os.path.join(project_path, "pytest.ini")) or os.path.exists(os.path.join(project_path, "tests")):
        test_commands.append(["python", "-m", "pytest", "--tb=short"])

    for cmd in test_commands:
        try:
            proc = subprocess.run(cmd, cwd=project_path, capture_output=True, text=True, timeout=60)
            if proc.returncode != 0:
                return {"success": False, "output": f"Command Failed: {' '.join(cmd)}\n{proc.stdout}\n{proc.stderr}"}
        except Exception as e:
            return {"success": False, "output": f"Runner Error: {str(e)}"}

    return {"success": True, "output": "Verified"}
