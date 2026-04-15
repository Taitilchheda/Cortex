// Cortex — API Client
// All fetch calls to :8000

const ENV_API_BASE = (typeof process !== 'undefined' ? process.env.NEXT_PUBLIC_API_BASE : '') || '';

function normalizeBase(base: string): string {
  return String(base || '').trim().replace(/\/+$/, '');
}

function runtimeApiBase(): string {
  if (typeof window === 'undefined') return 'http://localhost:8000';
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const host = window.location.hostname || 'localhost';
  return `${protocol}//${host}:8000`;
}

function apiBaseCandidates(): string[] {
  const seen = new Set<string>();
  const bases = [
    normalizeBase(ENV_API_BASE),
    normalizeBase(runtimeApiBase()),
    'http://localhost:8000',
    'http://127.0.0.1:8000',
  ];
  const out: string[] = [];
  for (const base of bases) {
    if (!base || seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

async function requestWithFallback(path: string, init?: RequestInit): Promise<Response> {
  const bases = apiBaseCandidates();
  let lastErr: unknown = null;

  for (let i = 0; i < bases.length; i += 1) {
    try {
      return await fetch(`${bases[i]}${path}`, init);
    } catch (err) {
      lastErr = err;
      if (i === bases.length - 1) throw err;
    }
  }

  throw lastErr || new Error('Failed to fetch');
}

// ─── SSE Parser ─────────────────────────────────────────────────
export function parseSSE(
  text: string,
  onEvent: (event: Record<string, unknown>) => void
): void {
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data: ')) {
      const json = trimmed.slice(6);
      if (json === '[DONE]') return;
      try {
        const parsed = JSON.parse(json);
        onEvent(parsed);
      } catch {
        // skip invalid JSON
      }
    }
  }
}

// ─── Streaming Fetch ────────────────────────────────────────────
export async function streamFetch(
  url: string,
  body: Record<string, unknown>,
  onEvent: (event: Record<string, unknown>) => void,
  onError?: (err: string) => void,
  signal?: AbortSignal
): Promise<void> {
  try {
    const resp = await requestWithFallback(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      onError?.(text || `HTTP ${resp.status}`);
      return;
    }

    const reader = resp.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        parseSSE(part + '\n', onEvent);
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      parseSSE(buffer, onEvent);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Connection failed';
    onError?.(message);
  }
}

// ─── REST Endpoints ─────────────────────────────────────────────
async function get(path: string) {
  const resp = await requestWithFallback(path);
  return resp.json();
}
async function post(path: string, body?: unknown) {
  const resp = await requestWithFallback(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}
async function del(path: string) {
  const resp = await requestWithFallback(path, { method: 'DELETE' });
  return resp.json();
}

export const fetchHealth = () => get('/health');
export const fetchStatus = () => get('/status');
export const fetchSessions = () => get('/sessions');
export const fetchSession = (id: string) => get(`/sessions/${id}`);
export const deleteSession = (id: string) => del(`/sessions/${id}`);
export const clearSessions = () => del('/sessions');
export const fetchRouter = () => get('/config/router');
export const updateRouter = (router: Record<string, string>) => post('/config/router', { router });
export const fetchRecommendations = (vram_gb: number, ram_gb: number, priority: string) =>
  post('/system/recommend', { vram_gb, ram_gb, priority });
export const fetchModels = () => get('/v1/models');
export const fetchModelCatalog = () => get('/models/catalog');
export const fetchHardwareStats = () => get('/hardware/stats');
export const fetchTemplates = () => get('/templates');
export const fetchBenchmarks = () => get('/benchmarks');

// New endpoints per design doc
export const pinSession = (id: string, pinned: boolean) => post(`/sessions/${id}/pin`, { pinned });
export const fetchPinned = () => get('/sessions/pinned');
export const searchSessions = (query: string) => get(`/sessions/search?q=${encodeURIComponent(query)}`);
export const fetchFileTree = (path: string, depth = 3) => get(`/files/tree?path=${encodeURIComponent(path)}&depth=${depth}`);
export const readFile = (path: string) => get(`/files/read?path=${encodeURIComponent(path)}`);
export const writeFile = (path: string, content: string) => post('/files/write', { path, content });
export const indexProject = (projectPath: string) => post('/project/index', { project_path: projectPath });
export const searchProject = (projectPath: string, query: string, limit = 5) =>
  post('/project/search', { project_path: projectPath, query, limit });
export const ragIndexProject = (projectPath: string) => post('/rag/index', { project_path: projectPath });
export const ragStatus = (projectPath: string) => get(`/rag/status?project_path=${encodeURIComponent(projectPath)}`);
export const ragContext = (projectPath: string, query: string, limit = 8, snippetChars = 360) =>
  post('/rag/context', { project_path: projectPath, query, limit, snippet_chars: snippetChars });
export const fetchAgentSettings = () => get('/settings/agent');
export const updateAgentSettings = (settings: Record<string, unknown>) => post('/settings/agent', settings);
export const fetchNotifications = () => get('/notifications');
export const clearNotifications = () => del('/notifications');
export const submitFeedback = (sessionId: string, messageId: string, feedback: 'up' | 'down') => post(`/sessions/${sessionId}/feedback`, { message_id: messageId, feedback });
export const configureTools = (tools: unknown[]) => post('/settings/tools', { tools });
export const fetchFeatureHealth = () => get('/health/features');
export const fetchContractHealth = () => get('/health/contracts');
export const fetchRouterMetrics = () => get('/router/metrics');
export const resetRouterMetrics = () => post('/router/metrics/reset');
export const fetchGitStatus = (path: string) => get(`/git/status?path=${encodeURIComponent(path)}`);
export const fetchGitVisualizer = (path: string, limit = 120) =>
  get(`/git/visualizer?path=${encodeURIComponent(path)}&limit=${limit}`);
export const commitGit = (path: string, message: string, commit_all = true) => post('/git/commit', { path, message, commit_all });
export const stageGitFile = (path: string, filePath: string) => post('/git/stage', { path, file_path: filePath });
export const stageAllGit = (path: string) => post('/git/stage-all', { path });
export const unstageGitFile = (path: string, filePath: string) => post('/git/unstage', { path, file_path: filePath });
export const unstageAllGit = (path: string) => post('/git/unstage-all', { path });
export const discardGitFile = (path: string, filePath: string) => post('/git/discard', { path, file_path: filePath });
export const checkoutGitRef = (path: string, ref: string) => post('/git/checkout', { path, ref });
export const pullGit = (path: string) => post('/git/pull', { path });
export const pushGit = (path: string) => post('/git/push', { path });
export const fetchPreferences = () => get('/settings/preferences');
export const setPreference = (key: string, value: unknown) => post('/settings/preferences', { key, value });
export const fetchToolsRegistry = () => get('/tools/registry');
export const fetchQueue = () => get('/queue');
export const enqueueTask = (task: string, mode: string, project_path?: string) =>
  post('/queue', { task, mode, project_path });
export const deleteQueueTask = (taskId: string) => del(`/queue/${encodeURIComponent(taskId)}`);
export const fetchSkills = () => get('/skills');
export const reloadSkills = () => post('/skills/reload');
export const enableSkill = (skillName: string) => post(`/skills/${encodeURIComponent(skillName)}/enable`);
export const disableSkill = (skillName: string) => post(`/skills/${encodeURIComponent(skillName)}/disable`);
export const runSkill = (skillName: string, body?: Record<string, unknown>) => post(`/skills/${encodeURIComponent(skillName)}/run`, body || {});
export const fetchEnvironmentLatestPreview = () => get('/environments/latest/preview');
export const fetchEnvironmentSessionPreview = (sessionId: string) => get(`/environments/${encodeURIComponent(sessionId)}/preview`);

// Connectors
export const fetchConnectorProviders = () => get('/connectors/providers');
export const fetchConnectorOAuthServerSetup = () => get('/connectors/oauth/server-setup');
export const updateConnectorOAuthServerSetup = (body: {
  provider: string;
  enabled?: boolean;
  client_id?: string;
  client_secret?: string;
}) => post('/connectors/oauth/server-setup', body);
export const fetchConnectors = () => get('/connectors');
export const createConnector = (body: { type: string; name: string; mode?: string; config?: Record<string, unknown>; scopes?: string[] }) =>
  post('/connectors', body);
export const updateConnector = (id: string, body: { name?: string; mode?: string; config?: Record<string, unknown>; scopes?: string[] }) =>
  requestWithFallback(`/connectors/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());
export const deleteConnector = (id: string) => del(`/connectors/${encodeURIComponent(id)}`);
export const connectConnector = (id: string) => post(`/connectors/${encodeURIComponent(id)}/connect`);
export const startConnectorOAuth = (body: { connector_id: string; provider: string; return_url?: string }) =>
  post('/connectors/oauth/start', body);
export const disconnectConnector = (id: string) => post(`/connectors/${encodeURIComponent(id)}/disconnect`);
export const testConnector = (id: string) => post(`/connectors/${encodeURIComponent(id)}/test`);
export const syncConnector = (id: string) => post(`/connectors/${encodeURIComponent(id)}/sync`);
export const listConnectorItems = (id: string) => get(`/connectors/${encodeURIComponent(id)}/items`);
export const connectorRuns = (id: string) => get(`/connectors/${encodeURIComponent(id)}/runs`);

export async function uploadFile(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  const resp = await requestWithFallback('/files/upload', {
    method: 'POST',
    body: formData,
  });
  return resp.json();
}
