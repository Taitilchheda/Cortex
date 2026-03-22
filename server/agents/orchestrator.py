"""
Cortex — Agent Orchestrator
Routes tasks to the correct agent: build, chat, aider refactor.
Implements multi-turn conversation memory and git integration (Future Scope).
"""
import json
import os
import subprocess
import httpx
import asyncio
from typing import AsyncGenerator, Dict, Any, List, Optional
from config.models import get_model_for_role, OLLAMA_BASE, MODEL_ROUTER
from agents.file_writer import architect_phase, coder_phase, self_healing_build
from api.state import add_event, create_session, update_session_title, update_token_usage

# ─── Conversation Memory (Future Scope) ──────────────────────────
# Multi-turn memory per session for build mode context
_conversation_memory: Dict[str, List[Dict[str, str]]] = {}

def get_conversation_history(session_id: str) -> List[Dict[str, str]]:
    return _conversation_memory.get(session_id, [])

def add_to_conversation(session_id: str, role: str, content: str):
    if session_id not in _conversation_memory:
        _conversation_memory[session_id] = []
    _conversation_memory[session_id].append({"role": role, "content": content})
    # Keep last 20 turns to avoid context overflow
    if len(_conversation_memory[session_id]) > 40:
        _conversation_memory[session_id] = _conversation_memory[session_id][-40:]


# ─── Project Templates (Future Scope) ────────────────────────────
PROJECT_TEMPLATES = {
    "fastapi": {
        "name": "FastAPI Starter",
        "description": "Python FastAPI REST API with SQLite, CORS, health checks",
        "files": ["main.py", "requirements.txt", "models.py", "schemas.py", "database.py", "README.md", ".gitignore"],
    },
    "nextjs": {
        "name": "Next.js Starter",
        "description": "Next.js 14 with App Router, Tailwind CSS, TypeScript",
        "files": ["package.json", "tsconfig.json", "tailwind.config.ts", "app/page.tsx", "app/layout.tsx", "app/globals.css", "README.md", ".gitignore"],
    },
    "react-native": {
        "name": "React Native Starter",
        "description": "React Native with Expo, TypeScript, Navigation",
        "files": ["package.json", "tsconfig.json", "App.tsx", "app.json", "README.md", ".gitignore"],
    },
    "ml-pipeline": {
        "name": "ML Pipeline",
        "description": "Python ML pipeline with data loading, training, evaluation",
        "files": ["requirements.txt", "train.py", "evaluate.py", "data_loader.py", "model.py", "config.yaml", "README.md", ".gitignore"],
    },
    "flask": {
        "name": "Flask Starter",
        "description": "Python Flask web app with templates and SQLite",
        "files": ["app.py", "requirements.txt", "templates/index.html", "static/style.css", "README.md", ".gitignore"],
    },
}


async def run_build(task: str, project_path: str, session_id: str, self_heal: bool = False) -> AsyncGenerator[Dict[str, Any], None]:
    """Full build pipeline: architect → coder → optional self-heal."""
    await add_event(session_id, "build_start", {"task": task, "project_path": project_path})
    
    if self_heal:
        async for event in self_healing_build(task, project_path):
            await add_event(session_id, event["type"], event["data"])
            yield event
    else:
        # Standard two-phase pipeline
        plan = None
        async for event in architect_phase(task, project_path):
            await add_event(session_id, event["type"], event["data"])
            yield event
            if event["type"] == "log" and event["data"].get("phase") == "architect_done":
                plan = event["data"].get("plan")

        if plan:
            # Add build context to conversation memory
            add_to_conversation(session_id, "user", task)
            add_to_conversation(session_id, "assistant", f"Architect plan: {json.dumps(plan.get('files', []))}")
            
            async for event in coder_phase(plan, project_path):
                await add_event(session_id, event["type"], event["data"])
                yield event

            # Git auto-commit (Future Scope)
            await _git_auto_commit(project_path, task)


async def run_chat(task: str, mode: str, session_id: str, attachments: list = None) -> AsyncGenerator[Dict[str, Any], None]:
    """Chat with role routing + image support + multi-turn memory."""
    model = get_model_for_role(mode)
    
    # Build messages with conversation history
    history = get_conversation_history(session_id)
    messages = [
        {"role": "system", "content": _get_system_prompt(mode)},
    ]
    messages.extend(history)
    
    # Process attachments
    user_content = task
    images = []
    if attachments:
        for att in attachments:
            if att.get("is_image") and att.get("data"):
                images.append(att["data"])
            elif att.get("content"):
                user_content += f"\n\n--- Attached: {att.get('name', 'file')} ---\n{att['content']}"
    
    messages.append({"role": "user", "content": user_content})
    
    add_to_conversation(session_id, "user", user_content)
    await add_event(session_id, "chat_start", {"mode": mode, "model": model})

    full_response = ""
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            request_body = {
                "model": model,
                "messages": messages,
                "stream": True,
            }
            if images:
                request_body["images"] = images

            async with client.stream(
                "POST",
                f"{OLLAMA_BASE}/api/chat",
                json=request_body,
            ) as response:
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    try:
                        chunk = json.loads(line)
                        token = chunk.get("message", {}).get("content", "")
                        full_response += token
                        if token:
                            yield {"type": "chat_stream", "data": {"delta": token}}
                        if chunk.get("done"):
                            # Token tracking (Future Scope)
                            eval_count = chunk.get("eval_count", 0)
                            prompt_eval_count = chunk.get("prompt_eval_count", 0)
                            await update_token_usage(session_id, prompt_eval_count, eval_count, model)
                            break
                    except json.JSONDecodeError:
                        continue
    except Exception as e:
        yield {"type": "error", "data": {"message": f"Chat failed: {str(e)}"}}

    if full_response:
        add_to_conversation(session_id, "assistant", full_response)
        await add_event(session_id, "chat_response", {"content": full_response, "model": model})


async def run_aider(instruction: str, project_path: str, session_id: str) -> AsyncGenerator[Dict[str, Any], None]:
    """Aider refactoring: streams aider stdout so you see exactly what files are modified."""
    model = get_model_for_role("coder")
    await add_event(session_id, "aider_start", {"instruction": instruction, "project_path": project_path})

    try:
        proc = await asyncio.create_subprocess_exec(
            "python", "-m", "aider",
            "--model", f"ollama/{model}",
            "--no-git",
            "--yes",
            "--message", instruction,
            cwd=project_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )

        async for line in proc.stdout:
            text = line.decode('utf-8', errors='replace').rstrip()
            if text:
                yield {"type": "aider_output", "data": {"line": text}}
                await add_event(session_id, "aider_output", {"line": text})

        await proc.wait()
        yield {"type": "log", "data": {"phase": "aider_complete", "message": f"Aider finished (exit code {proc.returncode})"}}
    except FileNotFoundError:
        yield {"type": "error", "data": {"message": "aider-chat not installed. Run: pip install aider-chat"}}
    except Exception as e:
        yield {"type": "error", "data": {"message": f"Aider error: {str(e)}"}}


async def openai_chat_completion(messages: list, model: str = None, stream: bool = True) -> AsyncGenerator[str, None]:
    """OpenAI-compatible /v1/chat/completions endpoint."""
    resolved_model = model or get_model_for_role("coder")
    
    try:
        async with httpx.AsyncClient(timeout=300) as client:
            if stream:
                async with client.stream(
                    "POST",
                    f"{OLLAMA_BASE}/api/chat",
                    json={"model": resolved_model, "messages": messages, "stream": True},
                ) as response:
                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        try:
                            chunk = json.loads(line)
                            token = chunk.get("message", {}).get("content", "")
                            if token:
                                yield json.dumps({
                                    "id": "chatcmpl-local",
                                    "object": "chat.completion.chunk",
                                    "choices": [{"index": 0, "delta": {"content": token}, "finish_reason": None}],
                                })
                            if chunk.get("done"):
                                yield json.dumps({
                                    "id": "chatcmpl-local",
                                    "object": "chat.completion.chunk",
                                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                                })
                                break
                        except json.JSONDecodeError:
                            continue
            else:
                resp = await client.post(
                    f"{OLLAMA_BASE}/api/chat",
                    json={"model": resolved_model, "messages": messages, "stream": False},
                )
                data = resp.json()
                content = data.get("message", {}).get("content", "")
                yield json.dumps({
                    "id": "chatcmpl-local",
                    "object": "chat.completion",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                    "usage": {
                        "prompt_tokens": data.get("prompt_eval_count", 0),
                        "completion_tokens": data.get("eval_count", 0),
                        "total_tokens": data.get("prompt_eval_count", 0) + data.get("eval_count", 0),
                    }
                })
    except Exception as e:
        yield json.dumps({"error": {"message": str(e), "type": "server_error"}})


def _get_system_prompt(mode: str) -> str:
    """Role-specific system prompts."""
    prompts = {
        "coder": "You are an expert software developer. Write clean, production-ready code. When asked to write code, output complete implementations with proper error handling, type hints, and documentation.",
        "architect": "You are a senior software architect. Design clean, scalable systems. When asked about architecture, provide detailed plans with file structures, technology choices, and dependency graphs.",
        "debug": "You are an expert debugger. Analyze code step-by-step, identify bugs, explain root causes, and provide fixes. Use systematic reasoning.",
        "quick": "You are a fast, concise coding assistant. Give short, direct answers and code snippets. No long explanations unless asked.",
        "explain": "You are a technical writer. Explain code and concepts clearly with examples. Use analogies when helpful. Write documentation that developers love to read.",
        "review": "You are a senior code reviewer. Analyze code for bugs, security issues, performance problems, and best-practice violations. Rate severity and provide actionable fixes.",
    }
    return prompts.get(mode, prompts["coder"])


async def _git_auto_commit(project_path: str, task_description: str) -> None:
    """Future Scope: Git auto-commit after each completed build."""
    git_dir = os.path.join(project_path, ".git")
    if not os.path.exists(git_dir):
        return
    
    try:
        # Generate a commit message
        model = get_model_for_role("quick")
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={
                    "model": model,
                    "prompt": f"Write a concise git commit message (max 72 chars) for: {task_description}",
                    "stream": False,
                    "options": {"temperature": 0.3, "num_predict": 100},
                },
            )
            commit_msg = resp.json().get("response", "Auto-commit by Cortex").strip()
            # Clean up the message
            commit_msg = commit_msg.split('\n')[0][:72]
        
        subprocess.run(["git", "add", "."], cwd=project_path, capture_output=True, timeout=10)
        subprocess.run(["git", "commit", "-m", commit_msg], cwd=project_path, capture_output=True, timeout=10)
    except Exception:
        pass  # Non-critical — don't fail the build
