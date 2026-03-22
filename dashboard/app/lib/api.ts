// Cortex — API Client
// All fetch calls to :8000

const API_BASE = 'http://localhost:8000';

// ─── SSE Parser ─────────────────────────────────────────────────
export function parseSSE(
  text: string,
  onEvent: (event: any) => void
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
  body: any,
  onEvent: (event: any) => void,
  onError?: (err: string) => void,
  signal?: AbortSignal
): Promise<void> {
  try {
    const resp = await fetch(`${API_BASE}${url}`, {
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
  } catch (err: any) {
    onError?.(err.message || 'Connection failed');
  }
}

// ─── REST Endpoints ─────────────────────────────────────────────
async function get(path: string) {
  const resp = await fetch(`${API_BASE}${path}`);
  return resp.json();
}
async function post(path: string, body?: any) {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}
async function del(path: string) {
  const resp = await fetch(`${API_BASE}${path}`, { method: 'DELETE' });
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
export const fetchTemplates = () => get('/templates');
export const fetchBenchmarks = () => get('/benchmarks');

// New endpoints per design doc
export const pinSession = (id: string, pinned: boolean) => post(`/sessions/${id}/pin`, { pinned });
export const fetchPinned = () => get('/sessions/pinned');
export const fetchFileTree = (path: string, depth = 3) => get(`/files/tree?path=${encodeURIComponent(path)}&depth=${depth}`);
export const readFile = (path: string) => get(`/files/read?path=${encodeURIComponent(path)}`);
export const fetchAgentSettings = () => get('/settings/agent');
export const updateAgentSettings = (settings: any) => post('/settings/agent', settings);
export const fetchNotifications = () => get('/notifications');
export const clearNotifications = () => del('/notifications');
export const submitFeedback = (sessionId: string, messageId: string, feedback: 'up' | 'down') => post(`/sessions/${sessionId}/feedback`, { message_id: messageId, feedback });
export const configureTools = (tools: any) => post('/settings/tools', { tools });

export async function uploadFile(file: File) {
  const formData = new FormData();
  formData.append('file', file);
  const resp = await fetch(`${API_BASE}/files/upload`, {
    method: 'POST',
    body: formData,
  });
  return resp.json();
}
