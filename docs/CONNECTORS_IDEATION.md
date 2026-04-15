# Connectors Ideation (Google Drive, GitHub, MCP, and More)

## 1) Purpose
Define a production-grade connector architecture for Cortex so agents can securely access external systems (code, docs, files, tickets, telemetry, and tools) while preserving local-first defaults and strict user control.

## 2) What Connectors Are Needed (Senior AI Dev Perspective)
For an AI coding workstation, the most useful connector stack is:

### 2.1 P0 Connectors (Highest Product Value)
- GitHub (repos, PRs, issues, checks, comments)
- Google Drive (Docs, Sheets, folder context)
- MCP (tool protocol gateway)
- Notion or Confluence (team knowledge base)
- Jira or Linear (task and sprint context)

### 2.2 P1 Connectors (High Leverage)
- GitLab and Azure DevOps (code and boards)
- Slack and Microsoft Teams (notifications and approval loops)
- S3 and GCS (artifact/doc stores)
- Postgres and Snowflake (schema and analytics context)
- Datadog and Sentry (incident and runtime debugging context)

### 2.3 P2 Connectors (Extended Platform)
- OneDrive and SharePoint
- BigQuery, Redshift, Databricks
- ServiceNow and Zendesk
- Figma and Miro
- Salesforce and HubSpot

## 3) Product Goals
- Make external context available to agents on demand.
- Keep least-privilege access and explicit user consent per connector.
- Support read-only and read-write modes per action.
- Expose health, sync status, and audit events in UI.
- Keep connector failures isolated from core chat/build.

## 4) Non-Goals (Phase 1)
- No autonomous writes without user approval.
- No plaintext secret storage in repository files.
- No hard dependency on cloud services to run Cortex.

## 5) Connector Taxonomy (Expanded)

### 5.1 Code and SCM
- GitHub, GitLab, Bitbucket, Azure DevOps Repos
- Core use cases:
  - Pull repo context and PR diffs
  - Reviewer agent feedback
  - Issue-PR traceability

### 5.2 Storage and Documents
- Google Drive, OneDrive, SharePoint, Dropbox, S3, GCS
- Core use cases:
  - Inject docs/files into tasks
  - Team document retrieval and enrichment

### 5.3 Project and Ticketing
- Jira, Linear, Azure Boards, Asana, Trello
- Core use cases:
  - Map tasks to code changes
  - Auto-generate implementation plans from tickets

### 5.4 Knowledge and Wiki
- Notion, Confluence, Coda, Slab, Obsidian Vault
- Core use cases:
  - Ground answers in team docs
  - Pull ADRs and architecture standards

### 5.5 Data and Analytics
- Postgres, MySQL, Snowflake, BigQuery, Redshift, Databricks
- Core use cases:
  - Schema-aware code generation
  - Query debugging and data lineage hints

### 5.6 Observability and Incident
- Datadog, Grafana, New Relic, Honeycomb, Sentry
- Core use cases:
  - Error-driven debugging workflows
  - Incident runbook recommendation

### 5.7 Communication and Approval
- Slack, Teams, Discord, Email
- Core use cases:
  - Approval prompts for write actions
  - Delivery notifications and summaries

### 5.8 AI and Model Ecosystem
- OpenRouter, HuggingFace, Azure OpenAI, Vertex AI, Bedrock
- Core use cases:
  - Model metadata and capability discovery
  - Provider-aware routing policies

### 5.9 Protocol and Tooling
- MCP, REST adapters, Webhook adapters
- Core use cases:
  - Tool orchestration through unified interface
  - Extensible custom tool integrations

## 6) Priority Matrix

| Connector | User Value | Complexity | Risk | Priority |
|---|---:|---:|---:|---|
| GitHub | High | Medium | Medium | P0 |
| Google Drive | High | Medium | Medium | P0 |
| MCP | High | Medium | Low | P0 |
| Jira/Linear | High | Medium | Medium | P0 |
| Notion/Confluence | High | Medium | Low | P0 |
| GitLab/Azure DevOps | Medium | Medium | Low | P1 |
| Slack/Teams | Medium | Low | Low | P1 |
| S3/GCS | Medium | Low | Low | P1 |
| Datadog/Sentry | Medium | Medium | Low | P1 |
| Snowflake/BigQuery | Medium | Medium | Medium | P1 |

## 7) High-Level Architecture

### 7.1 Backend Modules
- server/api/connectors.py
  - Connector CRUD and lifecycle endpoints.
  - connect/disconnect/test/sync actions.
- server/connectors/base.py
  - Base interface and shared abstractions.
- server/connectors/providers/
  - google_drive.py
  - github.py
  - mcp.py
  - jira.py
  - notion.py
  - ...
- server/connectors/secrets.py
  - Secret and token resolution abstraction.
- server/connectors/sync.py
  - Pull jobs, incremental sync, conflict markers.
- server/connectors/policy.py
  - Scope enforcement and approval gates.
- server/connectors/audit.py
  - Structured immutable audit logging.

### 7.2 Runtime Components
- Connector Registry: provider metadata and capabilities.
- Connector Executor: isolated action execution with timeouts.
- Sync Worker: background indexing, retry/backoff.
- Approval Broker: prompts and policy-based approvals.
- Credential Resolver: OS keychain or encrypted store.

### 7.3 UI Surfaces
- New route: dashboard/app/connectors/page.tsx
- Components:
  - ConnectorList
  - ConnectorCard
  - ConnectorAuthModal
  - ConnectorPermissionsPanel
  - ConnectorRunHistory
  - ConnectorHealthBadge

## 8) Connector Interface (Suggested)

```python
class ConnectorBase(Protocol):
    key: str
    name: str
    supports_read: bool
    supports_write: bool

    async def connect(self, config: dict) -> dict: ...
    async def disconnect(self, connector_id: str) -> dict: ...
    async def test(self, connector_id: str) -> dict: ...
    async def list_items(self, connector_id: str, cursor: str | None = None) -> dict: ...
    async def read_item(self, connector_id: str, item_id: str) -> dict: ...
    async def write_item(self, connector_id: str, payload: dict) -> dict: ...
```

## 9) Data Model (Detailed)

### 9.1 connectors
- id
- type (github, gdrive, mcp, etc.)
- name
- status (connected, degraded, disconnected)
- mode (read_only, read_write)
- config_json (non-secret)
- scopes_json
- created_at, updated_at

### 9.2 connector_credentials
- id
- connector_id
- secret_ref
- token_expires_at
- rotated_at

### 9.3 connector_runs
- id
- connector_id
- action (connect, test, sync, read, write)
- status (queued, running, success, failed)
- started_at, finished_at
- duration_ms
- error

### 9.4 connector_items
- connector_id
- external_id
- parent_external_id
- path
- mime
- size
- etag_or_hash
- permission_flags
- last_synced_at

### 9.5 connector_audit
- id
- connector_id
- actor (user/system)
- action
- policy_decision (allow, deny, require_approval)
- redacted_payload_json
- created_at

## 10) API Sketch (Detailed)

### 10.1 Lifecycle
- GET /connectors
- POST /connectors
- GET /connectors/{id}
- PATCH /connectors/{id}
- DELETE /connectors/{id}
- POST /connectors/{id}/connect
- POST /connectors/{id}/disconnect
- POST /connectors/{id}/test

### 10.2 Data Access
- GET /connectors/{id}/items
- GET /connectors/{id}/items/{item_id}
- POST /connectors/{id}/sync

### 10.3 Writes (Approval-Gated)
- POST /connectors/{id}/actions
- POST /connectors/{id}/actions/{action_id}/approve
- POST /connectors/{id}/actions/{action_id}/deny

### 10.4 Operations
- GET /connectors/{id}/runs
- GET /connectors/{id}/logs
- GET /connectors/{id}/health

## 11) Security and Compliance
- Consent-first auth and explicit scopes.
- Separate read-only and read-write capability flags.
- Per-action approval for all writes in Phase 1.
- Encrypt secrets at rest and redact in logs.
- Provider token refresh and rotation support.
- Connector-level kill switch and emergency revoke.
- Workspace-level policy controls:
  - Allowed connector types
  - Allowed write destinations
  - Allowed sync schedules

## 12) Reliability and Failure Isolation
- Per-connector timeout and retry policy.
- Circuit breaker per provider.
- Backoff with jitter for sync and list operations.
- Graceful degradation:
  - Connector errors never crash chat/build flows.
  - UI surfaces actionable status and last error.

## 13) Provider Ideation (Detailed)

### 13.1 Google Drive Connector
- Auth: OAuth 2.0 PKCE.
- Scopes:
  - Phase 1: drive.readonly
  - Phase 2 optional write: drive.file
- Operations:
  - list files/folders
  - export docs to markdown/plaintext
  - fetch metadata and permissions
- Risks:
  - MIME conversions and shared-drive policy edge cases.

### 13.2 GitHub Connector
- Auth: GitHub App or fine-grained PAT.
- Scopes:
  - repo read
  - pull request write (approval-gated)
- Operations:
  - list repos/branches/PRs/issues/check runs
  - pull PR diffs and files
  - post comment/review after approval
- Risks:
  - enterprise org policies and installation constraints.

### 13.3 MCP Connector
- Auth: local config/token depending on server.
- Operations:
  - register endpoint
  - capability discovery
  - route selected tools
- Risks:
  - variable server reliability and schema drift.

### 13.4 Jira or Linear Connector
- Operations:
  - list projects/sprints/issues
  - pull issue fields and comments
  - update status after approved action
- Value:
  - align generated work with sprint reality.

### 13.5 Notion or Confluence Connector
- Operations:
  - fetch pages/databases
  - permission-aware content extraction
  - citation mapping in agent responses
- Value:
  - better grounding for architecture and process guidance.

## 14) Execution Flows

### 14.1 Read from Google Drive
1. User connects Drive and grants read scope.
2. Cortex syncs metadata for selected folders.
3. User picks files for task context.
4. Agent uses extracted content with citations.

### 14.2 GitHub PR Review
1. User links repo and selects PR.
2. Cortex fetches diff and checks.
3. Reviewer agent generates findings.
4. User approves comment action.
5. Cortex posts review and logs audit trail.

### 14.3 MCP Tool Routing
1. User registers MCP server.
2. Cortex discovers tool capabilities.
3. User enables a subset of tools.
4. Agent calls tools through connector middleware with timeout policies.

## 15) Rollout Plan

### Phase A (Foundation)
- Connector framework and registry.
- UI shell and health panel.
- Google Drive read-only, GitHub read-only, MCP registration.

### Phase B (Workflow)
- Context injection UX.
- Incremental sync and indexing.
- Jira/Linear + Notion/Confluence connectors.

### Phase C (Controlled Writes)
- Approval broker for write actions.
- GitHub PR comments and Drive write-back.
- Org policy presets and audit exports.

### Phase D (Enterprise Hardening)
- Advanced key management integrations.
- Compliance reports and retention controls.
- Connector SLO dashboards.

## 16) Success Metrics
- Connector setup success rate.
- Median time to first synced item.
- Error rate by provider/action.
- Share of tasks that use connected context.
- Approval acceptance rate for write actions.
- Mean time to recover from connector failures.

## 17) Open Questions
- Preferred secret backend per OS (Windows Credential Manager, Keychain, libsecret, encrypted sqlite)?
- Tokens scoped per user profile or per workspace?
- Multi-account UX model for same provider?
- How strict should default write approvals be in team mode?
- Should Cortex support tenant-wide connector policy templates in Phase 1?
