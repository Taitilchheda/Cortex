# Cortex User Guide

This guide is the fastest way for a new user to start using Cortex.

For full project details, read [README.md](../README.md).
For platform-specific setup and troubleshooting, read [HOW_TO_RUN.md](HOW_TO_RUN.md).

## 1) First-Time Setup

1. Clone and enter the repo:

```bash
git clone https://github.com/Taitilchheda/Cortex.git
cd Cortex
```

2. Install dependencies (Windows helper script):

```bash
INSTALL.bat
```

3. Make sure Ollama is running and has at least one model:

```bash
ollama serve
ollama list
```

## 2) Start Cortex

Use the dev launcher:

```bash
START_DEV.bat
```

Default URLs:

- Frontend: http://localhost:3001
- Backend: http://localhost:8000
- Health: http://localhost:8000/health

## 3) Understand the Main Modes

In the input bar, choose one mode before sending a prompt:

- chat: Ask questions, generate code snippets, debug issues.
- build: Generate or scaffold a project in a target path.
- refactor: Apply larger code improvements or cleanup tasks.

You can also choose a role in chat mode (auto, coder, debug, architect, quick, review).

## 4) Your First Useful Prompts

### Chat Mode

Use a direct request:

- "Explain how the build pipeline works in this repo."
- "Find likely causes of this error and suggest a fix."

### Build Mode

1. Select build mode.
2. Set target project path.
3. Send prompt, for example:

- "Create a production-ready FastAPI service with auth, tests, and Docker support."

You will see architect planning, then file generation stream output.

### Refactor Mode

Use a clear objective:

- "Refactor this codebase to reduce duplication and improve type safety."

## 5) Connect External Sources (Connectors)

Open the Connectors panel in the right panel.

Supported connectors include:

- GitHub (OAuth)
- Google Drive (OAuth)
- Kaggle
- Google Colab
- Custom Agent endpoint
- MCP endpoint

For OAuth providers:

1. Configure OAuth client details in Connectors setup.
2. Start login flow from the connector card.
3. Return to Cortex and test/sync.

## 6) Use RAG Context Engine

Open the RAG panel in the right panel.

1. Set the project path.
2. Click Index Project.
3. Wait until indexing progresses.
4. Ask a context query such as:
   - "Where is specialist fallback implemented?"
5. Review ranked snippets returned by path and score.

## 7) Use Git Visualizer

Open the Git dashboard.

1. Enable visualizer toggle.
2. Review commit lanes and refs.
3. Filter commit list with search, sort, and graph options.

## 8) Daily Workflow Recommendation

1. Start with chat mode for planning.
2. Run build/refactor mode for implementation.
3. Use RAG context for targeted code understanding.
4. Use Git dashboard/visualizer before commit.
5. Run validation:

```bash
cd server
python -m pytest -q

cd ../dashboard
npx tsc --noEmit
npm run lint
```

## 9) If Something Fails

1. Check backend health at http://localhost:8000/health.
2. Ensure Ollama is reachable on port 11434.
3. Restart backend and frontend processes.
4. Re-run tests and type checks.
5. Follow the full troubleshooting section in [HOW_TO_RUN.md](HOW_TO_RUN.md).
