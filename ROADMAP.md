# 🗺️ Cortex — Future Scope & Roadmap

This document outlines the strategic evolution of Cortex, progressing from a high-performance local AI assistant to a full-fidelity autonomous coding workstation.

## 🟢 Phase 1: UX & UI Infrastructure (V5.1 Complete)
The foundation of a professional IDE has been established with focus on high-density information and accessibility.

- [x] **🌗 Theme System**: Fluid light/dark mode transitions via global CSS variables.
- [x] **⌘ Universal Search**: Full-screen Command Palette (Ctrl+K) for global navigation.
- [x] **📐 Workspace Control**: Resizable panels with persistence and clean drag handles.
- [x] **🔍 Deep History Search**: Backend Full-Text Search (FTS5) for instant message retrieval.
- [x] **📝 High-Fidelity Preview**: Integrated **Monaco Code Editor** with syntax highlighting and minimap.
- [x] **🧭 Navigation Trail**: Active Breadcrumbs showing project path and traversal depth.
- [x] **📌 Advanced Pinning**: Local persistence for favorite sessions and model assignments.
- [x] **📊 Agent Telemetry**: Real-time tracking of latency, tokens, and response feedback.

---

## 🟡 Phase 2: AI & Agent Orchestration (Incoming)
Enhancing the "intelligence" of the local agents to handle large-scale codebases.

- [ ] **🧠 RAG Context Engine**: Local vector database (ChromaDB) for semantic code search across the entire drive.
- [ ] **🔄 Self-Healing Loops**: Automatic error detection in builds with autonomous fixing and retry logic.
- [ ] **🔎 AI Code Reviewer**: Specialized mode for deep PR-style analysis of complex architectural changes.
- [ ] **🌐 Web Search Tool**: Real-time browsing capability for agents to pull documentation and latest library updates.
- [ ] **💾 Persistent Memory**: Long-term "knowledge" store that remembers past project decisions.

---

## 🟠 Phase 3: Developer Utilities (In Development)
Bridging the gap between the agent and existing developer tools.

- [ ] **💻 Embedded Terminal**: Integrated **xterm.js** terminal for real-time command execution and monitoring.
- [ ] **🔍 Visual Diff Viewer**: Side-by-side comparison for agent-proposed changes before application.
- [ ] **🔀 Git Visualizer**: Visual branch/commit management and diff history directly in the sidebar.
- [ ] **📋 Workspace Tabs**: Multi-document editing managed through top-level file tabs.
- [ ] **🧪 Test Integrator**: Automated test execution and AI-assisted debugging of failing tests.

---

## 🔴 Phase 4: Collaboration & Operations (Future)
Extending Cortex beyond a single developer's machine.

- [ ] **📤 Export System**: Session archiving into Markdown, JSON, or project ZIP files.
- [ ] **🔗 Public Shareables**: Backend generation of read-only links for session sharing.
- [ ] **📂 Multi-Project Workspaces**: Logic for grouping sessions into "Workspaces" with shared context.
- [ ] **📊 Performance Insights**: Analytics dashboard for token costs, model speed, and agent success rates.
- [ ] **🪝 Event Webhooks**: Trigger external CI/CD or notification systems on build completion.

---

## ✨ Developed with ❤️ for Local-First Development
*Making high-tier coding intelligence accessible, private, and free for everyone.*
