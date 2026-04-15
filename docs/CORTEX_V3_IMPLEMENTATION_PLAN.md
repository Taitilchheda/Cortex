# Cortex v3 Implementation Plan

## 1) Scope Source and Planning Goal
This plan is derived from the feature specification in [docs/cortex-v3-features.docx](docs/cortex-v3-features.docx).

Planning objective:
- Convert the v3 design into an execution-ready roadmap for this repository.
- Sequence work by dependencies and risk.
- Define deliverables, acceptance criteria, and validation for each phase.

## 2) Current Baseline (Repository Snapshot)
Based on current code structure and behavior:

Backend today:
- FastAPI server with chat/build/refactor flows in [server/main.py](server/main.py).
- Session persistence and search already present in [server/api/state.py](server/api/state.py).
- Agent orchestration exists in [server/agents/orchestrator.py](server/agents/orchestrator.py).
- Basic git endpoints are present and recently extended in [server/main.py](server/main.py).
- No dedicated CEP module, checkpoint module, plugin loader module, or cloud provider integration module yet.

Frontend today:
- Next.js dashboard with resizable shell and rich sidebar/right panel components in [dashboard/app/components](dashboard/app/components).
- Git dashboard is interactive and wired to backend operations in [dashboard/app/components/GitDashboard.tsx](dashboard/app/components/GitDashboard.tsx).
- Global search now propagates into sessions/files/git.
- No dedicated model browser page, hardware dashboard panel, environment switcher, checkpoint panel, or plugin manager page yet.

Operational note:
- Production build passes for dashboard.
- Local dev startup commands currently fail intermittently in this environment and should be treated as a parallel stabilization task before major feature merge windows.

## 3) Delivery Strategy
Use six phases with strict entry/exit criteria.

- Phase 0: Runtime stabilization and observability hardening
- Phase A: Foundation infrastructure
- Phase B: Cloud models and LM Studio parity
- Phase C: Graph memory checkpoints
- Phase D: Multi-environment continuity (CEP)
- Phase E: Agent/skill/plugin extensibility and management UI

Execution model:
- Time-boxed milestones with feature flags per major subsystem.
- Backend-first for contracts, then frontend integration.
- No phase closes without acceptance checks and minimal docs updates.

## 4) Phase-by-Phase Plan

## Phase 0 (Week 1): Stabilization Gate
Purpose:
- Eliminate run/start instability so the team can execute v3 safely.

Work items:
1. Standardize local run scripts and environment checks.
   - Update [START.bat](START.bat), [START_DEV.bat](START_DEV.bat), [INSTALL.bat](INSTALL.bat), [DIAGNOSE.bat](DIAGNOSE.bat).
2. Add startup diagnostics endpoint and startup log clarity.
   - Update [server/main.py](server/main.py).
3. Add frontend env and port conflict guard docs.
   - Update [docs/HOW_TO_RUN.md](docs/HOW_TO_RUN.md), [README.md](README.md).

Acceptance criteria:
- Clean startup path for backend and frontend from scripts.
- Diagnose script reports actionable causes for common failures (port conflict, env mismatch, missing deps).

## Phase A (Weeks 2-3): Foundation Infrastructure
Purpose:
- Introduce primitives required by all remaining v3 features.

Work items:
1. .cortex workspace foundation.
   - Create [server/api/config.py](server/api/config.py).
   - Create and manage .cortex directories: config, memory, agents, skills, plugins, environments.
2. CEP schema and environment API skeleton.
   - Create [server/api/environments.py](server/api/environments.py) with CEPPacket model and receive/push/latest contracts.
3. Plugin loader and sandbox boundary.
   - Create [server/api/plugins.py](server/api/plugins.py).
4. Skill discovery runner.
   - Create [server/agents/skill_runner.py](server/agents/skill_runner.py).
5. App boot integration.
   - Register new routers and startup loaders in [server/main.py](server/main.py).

Acceptance criteria:
- Cortex starts with .cortex auto-bootstrap in project root.
- Plugin and skill discovery logs discovered units without execution failures.
- Environment API endpoints return schema-valid packets (even before adapters are complete).

## Phase B (Weeks 4-5): Cloud Models and LM Studio Parity Core
Purpose:
- Deliver unified model sourcing, model management, and hardware visibility.

Work items:
1. Cloud provider integration layer.
   - Create [server/config/cloud.py](server/config/cloud.py).
   - Add OpenRouter API key support and model fetch.
2. Unified model catalog and selection policies.
   - Update [server/config/models.py](server/config/models.py).
   - Add source tagging local/cloud/openrouter, cloud quota metadata, fallback logic.
3. Hardware telemetry stream.
   - Add SSE endpoint in [server/main.py](server/main.py).
   - Add service module [server/api/hardware.py](server/api/hardware.py).
4. Frontend model and hardware UI.
   - Create [dashboard/app/components/ModelPicker.tsx](dashboard/app/components/ModelPicker.tsx).
   - Create [dashboard/app/components/HardwareDashboard.tsx](dashboard/app/components/HardwareDashboard.tsx).
   - Integrate in [dashboard/app/components/RightPanel.tsx](dashboard/app/components/RightPanel.tsx).
5. Model browser and install pipeline.
   - Create [server/api/model_browser.py](server/api/model_browser.py).
   - Create [dashboard/app/components/ModelBrowser.tsx](dashboard/app/components/ModelBrowser.tsx).

Acceptance criteria:
- Unified model list shows source badges and quota/cost metadata.
- Hardware dashboard updates every 2 seconds without UI lockups.
- One-click model install streams progress and refreshes available model roster.

## Phase C (Weeks 6-7): Graph Memory and Checkpoints
Purpose:
- Add durable, portable session memory and restore points.

Work items:
1. Memory node writer/reader skills.
   - Extend [server/agents/skill_runner.py](server/agents/skill_runner.py).
2. Checkpoint API and storage format.
   - Create [server/api/checkpoints.py](server/api/checkpoints.py).
   - Store markdown checkpoints in .cortex/memory with frontmatter and links.
3. Restore flows and optional git stash integration.
   - Update [server/main.py](server/main.py) and [server/agents/orchestrator.py](server/agents/orchestrator.py).
4. Checkpoint UI.
   - Create [dashboard/app/components/CheckpointPanel.tsx](dashboard/app/components/CheckpointPanel.tsx).
   - Integrate in [dashboard/app/components/RightPanel.tsx](dashboard/app/components/RightPanel.tsx).

Acceptance criteria:
- Manual checkpoint create and restore works for an active session.
- Auto-checkpoint triggers run at configured events (plan complete, pre-patch, pre-handoff).
- Markdown artifacts are readable and linked (Obsidian-compatible).

## Phase D (Weeks 8-9): Multi-Environment Continuity (CEP)
Purpose:
- Enable portable session handoff between tools.

Work items:
1. CEP packet builder and restore resolver.
   - Implement in [server/api/environments.py](server/api/environments.py).
2. Dashboard environment switcher.
   - Create [dashboard/app/components/EnvironmentSwitcher.tsx](dashboard/app/components/EnvironmentSwitcher.tsx).
   - Integrate in [dashboard/app/components/Header.tsx](dashboard/app/components/Header.tsx).
3. VS Code adapter package.
   - Create [vscode-cortex](vscode-cortex) extension workspace.
4. MCP bridge for Claude Code.
   - Create [server/mcp_server.py](server/mcp_server.py).
5. OpenClaw polling contract completion.
   - Finalize latest handoff endpoint semantics in [server/api/environments.py](server/api/environments.py).

Acceptance criteria:
- Push/receive handoff flow succeeds between Cortex and one adapter (VS Code first).
- CEP packet persists and can be restored after backend restart.
- User sees explicit accept/restore action in UI for incoming handoffs.

## Phase E (Weeks 10-11): Agent/Skill/Plugin System UX
Purpose:
- Make extensibility visible, manageable, and safe for end users.

Work items:
1. Plugin manager route and shell.
   - Create [dashboard/app/plugins/page.tsx](dashboard/app/plugins/page.tsx).
2. Plugin manager component.
   - Create [dashboard/app/components/PluginManager.tsx](dashboard/app/components/PluginManager.tsx).
3. Plugin store backend.
   - Create [server/api/plugin_store.py](server/api/plugin_store.py).
4. Enable/disable controls and health metadata for custom agents and skills.
   - Update [server/api/plugins.py](server/api/plugins.py), [server/agents/skill_runner.py](server/agents/skill_runner.py).

Acceptance criteria:
- Installed plugin list supports enable/disable and displays metadata.
- Custom agents and skills are discoverable and testable from UI.
- Plugin sandbox constraints enforced by server boundary checks.

## 5) Dependency Graph (Execution Order)
Hard dependencies:
1. Phase 0 before all major implementation phases.
2. Phase A before B/C/D/E.
3. Phase C depends on A.
4. Phase D depends on A and should start after C contracts stabilize.
5. Phase E depends on A and can partially parallelize with D after plugin contracts land.

Safe parallel tracks:
- B frontend and B backend can run in parallel after unified model contracts are frozen.
- C UI panel can start once checkpoint list/get endpoints are stubbed.

## 6) Milestone Definition of Done
Each phase completes only when all are true:
1. API contracts documented and exercised.
2. UI integration complete with empty/loading/error states.
3. Build passes for dashboard and backend syntax checks pass.
4. Runbook updates completed in [docs/HOW_TO_RUN.md](docs/HOW_TO_RUN.md) and release notes appended in [cortex_implementation_log.md](cortex_implementation_log.md).

## 7) Risk Register and Mitigation
1. Provider API variance (Ollama cloud/OpenRouter).
   - Mitigation: adapter abstraction in [server/config/cloud.py](server/config/cloud.py) with per-provider fallback and strict timeout handling.
2. Plugin safety.
   - Mitigation: explicit sandbox policy and restricted import surface in [server/api/plugins.py](server/api/plugins.py).
3. Session restore corruption across tools.
   - Mitigation: versioned CEP schema plus compatibility handler in [server/api/environments.py](server/api/environments.py).
4. Memory growth and token bloat.
   - Mitigation: graph-linked retrieval window (top-k relevant nodes) and retention policy.

## 8) Suggested Tracking Board Columns
Use these for each work item:
- Planned
- In progress
- Contract ready
- UI wired
- Validated
- Released

## 9) First 10 Actionable Tickets (Start Immediately)
1. Create [server/api/config.py](server/api/config.py) and bootstrap .cortex dirs.
2. Create [server/api/environments.py](server/api/environments.py) with CEPPacket schema and receive/latest stubs.
3. Create [server/api/plugins.py](server/api/plugins.py) loader skeleton and startup registration.
4. Create [server/agents/skill_runner.py](server/agents/skill_runner.py) discovery and registry.
5. Wire new routers in [server/main.py](server/main.py).
6. Add cloud provider config scaffold in [server/config/cloud.py](server/config/cloud.py).
7. Add unified model response shape in [server/config/models.py](server/config/models.py).
8. Add hardware stats endpoint stub in [server/main.py](server/main.py).
9. Scaffold [dashboard/app/components/HardwareDashboard.tsx](dashboard/app/components/HardwareDashboard.tsx).
10. Scaffold [dashboard/app/components/ModelPicker.tsx](dashboard/app/components/ModelPicker.tsx) and integrate in [dashboard/app/components/RightPanel.tsx](dashboard/app/components/RightPanel.tsx).
