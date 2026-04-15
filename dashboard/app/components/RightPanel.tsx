'use client';
import { useState, useEffect } from 'react';
import { Session, AgentSettings, QueueTask, ToolRegistryItem, RouterMetrics } from '../lib/types';
import {
  fetchRecommendations, fetchModels, fetchRouter, updateRouter,
  fetchAgentSettings, updateAgentSettings, configureTools,
  fetchFeatureHealth, fetchContractHealth,
  fetchPreferences, setPreference,
  fetchToolsRegistry,
  fetchQueue, enqueueTask, deleteQueueTask, fetchRouterMetrics,
} from '../lib/api';
import { 
  Activity, 
  Lightbulb, 
  Settings, 
  Plug, 
  Binary, 
  HardDrive,
  Globe2,
  List,
  Database,
  Link2
} from 'lucide-react';
import CodeOutline from './CodeOutline';
import ModelPicker from './ModelPicker';
import HardwareDashboard from './HardwareDashboard';
import RagContextEngine from './RagContextEngine';
import ConnectorsPanel from './ConnectorsPanel';

interface RightPanelProps {
  activeSession: Session | null;
  fileCount: number;
  isRunning: boolean;
  doneFiles: number;
  totalFiles: number;
  contextTokens: number;
  contextLimit: number;
  activeFile?: { path: string; content: string } | null;
}

type TabKey = 'context' | 'monitor' | 'advisor' | 'settings' | 'api' | 'tools' | 'outline';
type ExtendedTabKey = TabKey | 'queue' | 'rag' | 'connectors';

interface RecommendationModel {
  model: string;
  rank?: string;
  specialty?: string;
  quality_score?: number | string | null;
  humaneval?: number | string | null;
  runtime_vram_gb?: number | string | null;
  fits_vram?: boolean;
  needs_ram_offload?: boolean;
  benchmark_source?: string;
  [key: string]: unknown;
}

interface RecommendationResponse {
  detail?: unknown;
  error?: string;
  data_sources?: {
    engine?: string;
    model_database?: string;
    scoring?: string;
    binary?: string;
    [key: string]: unknown;
  };
  llmfit_binary?: string;
  models?: RecommendationModel[];
  [key: string]: unknown;
}

interface FeatureHealthResponse {
  features?: {
    memory?: boolean;
    web_search?: boolean;
    git?: boolean;
    local_only?: boolean;
    queue?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface ContractHealthResponse {
  contracts?: unknown;
  [key: string]: unknown;
}

const API_ENDPOINTS = [
  { method: 'GET', path: '/', desc: 'Server info + Ollama status' },
  { method: 'GET', path: '/health', desc: 'Full health check' },
  { method: 'POST', path: '/agent/build', desc: 'Build pipeline (SSE stream)' },
  { method: 'POST', path: '/agent/chat', desc: 'Chat with role routing (SSE)' },
  { method: 'POST', path: '/agent/aider', desc: 'Aider refactor (SSE)' },
  { method: 'POST', path: '/v1/chat/completions', desc: 'OpenAI-compatible' },
  { method: 'GET', path: '/v1/models', desc: 'Model list' },
  { method: 'GET', path: '/models/catalog', desc: 'Unified local/cloud catalog' },
  { method: 'GET', path: '/hardware/stats', desc: 'Hardware telemetry snapshot' },
  { method: 'GET', path: '/git/visualizer', desc: 'Commit lanes for Git Visualizer' },
  { method: 'POST', path: '/rag/context', desc: 'RAG context retrieval from project index' },
];

const ROLES = ['architect', 'coder', 'debug', 'quick', 'explain', 'review'];

export default function RightPanel({
  activeSession, fileCount, isRunning, doneFiles, totalFiles, contextTokens, contextLimit, activeFile
}: RightPanelProps) {
  const [tab, setTab] = useState<ExtendedTabKey>('context');
  const [vram, setVram] = useState('12');
  const [ram, setRam] = useState('32');
  const [priority, setPriority] = useState('balanced');
  const [recommendation, setRecommendation] = useState<RecommendationResponse | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [router, setRouter] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState('');
  const [settings, setSettings] = useState<AgentSettings>({
    auto_approve: 'ask', max_files: 50, max_retries: 1,
    self_heal_count: 3, review_on_build: false, test_on_build: false, context_limit: 32768, local_only: false, protected_paths: [],
  });
  const [protectedPathsText, setProtectedPathsText] = useState('');
  const [prefProjectPath, setPrefProjectPath] = useState('');
  const [prefDefaultMode, setPrefDefaultMode] = useState('chat');
  const [featureHealth, setFeatureHealth] = useState<FeatureHealthResponse | null>(null);
  const [contractHealth, setContractHealth] = useState<ContractHealthResponse | null>(null);
  const [toolRegistry, setToolRegistry] = useState<ToolRegistryItem[]>([]);
  const [toolConfig, setToolConfig] = useState<Record<string, boolean>>({});
  const [toolSaving, setToolSaving] = useState(false);
  const [prefSaving, setPrefSaving] = useState(false);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueSaving, setQueueSaving] = useState(false);
  const [queueDraftTask, setQueueDraftTask] = useState('');
  const [queueDraftMode, setQueueDraftMode] = useState('chat');
  const [queueDraftPath, setQueueDraftPath] = useState('');
  const [queueTasks, setQueueTasks] = useState<QueueTask[]>([]);
  const [routerMetrics, setRouterMetrics] = useState<RouterMetrics | null>(null);

  const refreshRouterMetrics = async () => {
    try {
      const data = await fetchRouterMetrics();
      setRouterMetrics(data.metrics || null);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchModels().then(d => {
      const raw = (d as { data?: unknown }).data;
      const rows = Array.isArray(raw) ? raw : [];
      const nextModels = rows
        .map((m) => {
          if (typeof m === 'object' && m !== null && 'id' in m) {
            const id = (m as { id?: unknown }).id;
            return typeof id === 'string' ? id : '';
          }
          return '';
        })
        .filter(Boolean);
      setModels(nextModels);
    }).catch(() => {});
    fetchRouter().then(d => setRouter(d.router || {})).catch(() => {});
    fetchAgentSettings().then(d => {
      setSettings(d);
      setProtectedPathsText((d.protected_paths || []).join('\n'));
    }).catch(() => {});
    fetchFeatureHealth().then(setFeatureHealth).catch(() => {});
    fetchContractHealth().then(setContractHealth).catch(() => {});
    fetchToolsRegistry().then(d => {
      const tools = d.tools || [];
      setToolRegistry(tools);
      setToolConfig(Object.fromEntries(tools.map((t: ToolRegistryItem) => [t.key, !!t.enabled])));
    }).catch(() => {});
    fetchPreferences().then(d => {
      const prefs = d.preferences || {};
      if (typeof prefs.default_project_path === 'string') setPrefProjectPath(prefs.default_project_path);
      if (typeof prefs.default_mode === 'string') setPrefDefaultMode(prefs.default_mode);
    }).catch(() => {});
    refreshQueue();
    refreshRouterMetrics();

    const metricsTimer = setInterval(() => {
      refreshRouterMetrics();
    }, 5000);

    return () => clearInterval(metricsTimer);
  }, []);

  useEffect(() => {
    if (isRunning) setTab('monitor');
  }, [isRunning]);

  const doRecommend = async () => {
    setLoading(true);
    setRecommendation(null);

    const parsedVram = Number.parseFloat(vram);
    const parsedRam = Number.parseFloat(ram);
    if (!Number.isFinite(parsedVram) || parsedVram <= 0 || !Number.isFinite(parsedRam) || parsedRam <= 0) {
      setRecommendation({ error: 'Enter valid positive VRAM and RAM values before running analysis.' });
      setLoading(false);
      return;
    }

    try {
      const r = await fetchRecommendations(parsedVram, parsedRam, priority) as RecommendationResponse;
      const detailError = Array.isArray(r?.detail)
        ? r.detail.map((d) => {
            if (typeof d === 'object' && d !== null && 'msg' in d) {
              const msg = (d as { msg?: unknown }).msg;
              return typeof msg === 'string' ? msg : JSON.stringify(d);
            }
            return JSON.stringify(d);
          }).join('; ')
        : (typeof r?.detail === 'string' ? r.detail : '');
      const apiError = typeof r?.error === 'string' ? r.error : detailError;
      if (apiError) {
        setRecommendation({ ...(r || {}), error: apiError });
      } else {
        setRecommendation(r);
      }
    } catch (err: unknown) {
      setRecommendation({
        error: err instanceof Error ? err.message : 'Failed to run analysis. Ensure backend is running on port 8000.',
      });
    } finally {
      setLoading(false);
    }
  };

  const saveRouter = async () => {
    const result = await updateRouter(router);
    setRouter(result.router);
    setSaved('router');
    setTimeout(() => setSaved(''), 2000);
  };

  const saveSettings = async () => {
    const parsedPaths = protectedPathsText
      .split(/\r?\n/)
      .map(p => p.trim())
      .filter(Boolean);
    const result = await updateAgentSettings({ ...settings, protected_paths: parsedPaths });
    setSettings(result);
    setProtectedPathsText((result.protected_paths || parsedPaths).join('\n'));
    setSaved('settings');
    setTimeout(() => setSaved(''), 2000);
  };

  const saveTools = async () => {
    setToolSaving(true);
    await configureTools(Object.entries(toolConfig).filter(([_, enabled]) => enabled).map(([k]) => k));
    setToolRegistry(prev => prev.map(t => ({ ...t, enabled: !!toolConfig[t.key] })));
    setSaved('tools');
    setTimeout(() => setSaved(''), 2000);
    setToolSaving(false);
  };

  const savePreferences = async () => {
    setPrefSaving(true);
    try {
      await Promise.all([
        setPreference('default_project_path', prefProjectPath),
        setPreference('default_mode', prefDefaultMode),
      ]);
      setSaved('prefs');
      setTimeout(() => setSaved(''), 2000);
    } finally {
      setPrefSaving(false);
    }
  };

  const refreshQueue = async () => {
    setQueueLoading(true);
    try {
      const d = await fetchQueue();
      setQueueTasks(d.tasks || []);
    } finally {
      setQueueLoading(false);
    }
  };

  const addQueueTask = async () => {
    const task = queueDraftTask.trim();
    if (!task) return;
    setQueueSaving(true);
    try {
      await enqueueTask(task, queueDraftMode, queueDraftPath.trim() || undefined);
      setQueueDraftTask('');
      await refreshQueue();
      setSaved('queue');
      setTimeout(() => setSaved(''), 2000);
    } finally {
      setQueueSaving(false);
    }
  };

  const removeQueueTask = async (id: string) => {
    await deleteQueueTask(id);
    await refreshQueue();
  };

  const tokPercent = contextLimit > 0 ? Math.min((contextTokens / contextLimit) * 100, 100) : 0;
  const tokColor = tokPercent < 50 ? 'var(--green)' : tokPercent < 80 ? 'var(--amber)' : 'var(--red)';

  return (
    <div className="right-panel" id="right-panel">
      <div className="lp-tabs">
        <button className={`lp-tab ${tab === 'context' ? 'active' : ''}`} onClick={() => setTab('context')} title="Inspector">
          <Binary size={18} strokeWidth={tab === 'context' ? 2.5 : 2} />
        </button>
        <button className={`lp-tab ${tab === 'monitor' ? 'active' : ''}`} onClick={() => setTab('monitor')} title="Monitor">
          <Activity size={18} strokeWidth={tab === 'monitor' ? 2.5 : 2} />
        </button>
        <button className={`lp-tab ${tab === 'advisor' ? 'active' : ''}`} onClick={() => setTab('advisor')} title="Advisor">
          <Lightbulb size={18} strokeWidth={tab === 'advisor' ? 2.5 : 2} />
        </button>
        <button className={`lp-tab ${tab === 'settings' ? 'active' : ''}`} onClick={() => setTab('settings')} title="Settings">
          <Settings size={18} strokeWidth={tab === 'settings' ? 2.5 : 2} />
        </button>
        <button className={`lp-tab ${tab === 'tools' ? 'active' : ''}`} onClick={() => setTab('tools')} title="AI Tools">
          <Globe2 size={18} strokeWidth={tab === 'tools' ? 2.5 : 2} />
        </button>
        <button className={`lp-tab ${tab === 'queue' ? 'active' : ''}`} onClick={() => setTab('queue')} title="Queue">
          <HardDrive size={18} strokeWidth={tab === 'queue' ? 2.5 : 2} />
        </button>
        <button className={`lp-tab ${tab === 'connectors' ? 'active' : ''}`} onClick={() => setTab('connectors')} title="Connectors">
          <Link2 size={18} strokeWidth={tab === 'connectors' ? 2.5 : 2} />
        </button>
        <button className={`lp-tab ${tab === 'rag' ? 'active' : ''}`} onClick={() => setTab('rag')} title="RAG Context">
          <Database size={18} strokeWidth={tab === 'rag' ? 2.5 : 2} />
        </button>
        <button className={`lp-tab ${tab === 'api' ? 'active' : ''}`} onClick={() => setTab('api')} title="API Reference">
          <Plug size={18} strokeWidth={tab === 'api' ? 2.5 : 2} />
        </button>
        <button className={`lp-tab ${tab === 'outline' ? 'active' : ''}`} onClick={() => setTab('outline')} title="Outline">
          <List size={18} strokeWidth={tab === 'outline' ? 2.5 : 2} />
        </button>
      </div>

      <div className="lp-scrollable" style={{ padding: 16 }}>
        {tab === 'context' && (
          <>
            <div className="pro-card">
              <div className="card__label">Context Window</div>
              <div className="tok-gauge">
                <div className="tok-bar">
                  <div className="tok-fill" style={{ width: `${tokPercent}%`, background: tokColor }} />
                </div>
                <div className="tok-nums">
                  <span>{contextTokens.toLocaleString()} used</span>
                  <span>{contextLimit.toLocaleString()} total</span>
                </div>
              </div>
            </div>

            <div className="pro-card">
              <div className="card__label">Session Metrics</div>
              <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                 <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 20, fontWeight: 700 }}>{fileCount}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase' }}>Files</div>
                 </div>
                 <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--accent)' }}>{(activeSession?.token_usage?.total_tokens || 0).toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase' }}>Tokens</div>
                 </div>
              </div>
            </div>
            
            <div className="pro-card">
              <div className="card__label">Local Server</div>
              <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>
                http://localhost:8000/v1
              </div>
            </div>
          </>
        )}

        {tab === 'monitor' && (
          <>
            <div className="pro-card">
               <div className="card__label">Agent Activity</div>
               <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <div className={`status-ring ${isRunning ? 'status-ring--ok' : ''}`} style={{ background: isRunning ? 'var(--accent)' : 'var(--text-4)' }} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{isRunning ? 'Processing Workspace' : 'Waiting for Input'}</span>
               </div>
               <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)' }}>
                 Build progress: {doneFiles}/{totalFiles || 0} files
               </div>
               {featureHealth?.features && (
                 <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)', display: 'grid', gap: 4 }}>
                   <div>Memory: {featureHealth.features.memory ? 'ok' : 'down'}</div>
                   <div>Web Search: {featureHealth.features.web_search ? 'ok' : 'down'}</div>
                   <div>Git: {featureHealth.features.git ? 'ok' : 'down'}</div>
                   <div>Local Only: {featureHealth.features.local_only ? 'on' : 'off'}</div>
                   <div>Queue: {featureHealth.features.queue ? 'ok' : 'down'}</div>
                 </div>
               )}
            </div>

            <div className="pro-card">
              <div className="card__label">Router Analytics</div>
              <div style={{ marginTop: 8, display: 'grid', gap: 6, fontSize: 11, color: 'var(--text-3)' }}>
                <div>Total decisions: {routerMetrics?.total ?? 0}</div>
                <div>Avg confidence: {routerMetrics?.avg_confidence ?? 0}</div>
                <div>Fallbacks: {routerMetrics?.fallbacks ?? 0}</div>
                <div>Specialist hit-rate: {routerMetrics?.specialist_hit_rate ?? 0}%</div>
                <div>Specialist latency: {routerMetrics?.avg_specialist_latency_ms ?? 0} ms</div>
                <div>Specialist timeouts: {routerMetrics?.specialist_timeouts ?? 0}</div>
                <div>Decompositions: {routerMetrics?.decompositions ?? 0}</div>
                <div>Auto-escalations: {routerMetrics?.auto_escalations ?? 0}</div>
                <div>Approval blocks: {routerMetrics?.approval_blocks ?? 0}</div>
                <div>
                  Feedback: up {routerMetrics?.quality_feedback?.up ?? 0} / down {routerMetrics?.quality_feedback?.down ?? 0}
                </div>
              </div>
            </div>
          </>
        )}

        {tab === 'advisor' && (
          <>
            <div className="pro-card">
               <div className="card__label">Hardware Profile</div>
               <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 8 }}>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-4)' }}>VRAM (GB)</label>
                    <input type="number" className="lp-search" value={vram} onChange={e => setVram(e.target.value)} style={{ padding: 4 }} />
                  </div>
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-4)' }}>RAM (GB)</label>
                    <input type="number" className="lp-search" value={ram} onChange={e => setRam(e.target.value)} style={{ padding: 4 }} />
                  </div>
               </div>
               <button className="btn--primary btn--sm" style={{ width: '100%', marginTop: 12 }} onClick={doRecommend} disabled={loading}>
                 {loading ? 'Running...' : 'Run Analysis'}
               </button>
               {loading && (
                 <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-4)' }}>
                   Running recommendation analysis...
                 </div>
               )}
            </div>
            {recommendation?.error && (
              <div className="pro-card" style={{ borderColor: 'rgba(255, 120, 120, 0.45)' }}>
                <div className="card__label">Recommendation Error</div>
                <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 6 }}>{String(recommendation.error)}</div>
              </div>
            )}
            {recommendation?.data_sources && (
              <div className="pro-card">
                <div className="card__label">Recommendation Sources</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6, display: 'grid', gap: 4 }}>
                  <div>Engine: {recommendation.data_sources.engine || 'n/a'}</div>
                  <div>Model database: {recommendation.data_sources.model_database || 'n/a'}</div>
                  <div>Scoring: {recommendation.data_sources.scoring || 'n/a'}</div>
                  <div>Binary: {recommendation.data_sources.binary || recommendation.llmfit_binary || 'not found'}</div>
                </div>
              </div>
            )}
            {recommendation?.models?.map((m, i) => (
              <div className="pro-card" key={i}>
                 <div className="pro-head"><span className="pro-name">{m.model}</span><span className="pro-badge">{m.rank}</span></div>
                 <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{m.specialty}</div>
                 <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6, display: 'grid', gap: 2 }}>
                   <div>Quality score: {m.quality_score ?? m.humaneval ?? '--'}</div>
                   <div>VRAM runtime: {m.runtime_vram_gb ?? '--'} GB · {m.fits_vram ? 'fits VRAM' : (m.needs_ram_offload ? 'RAM offload' : 'too large')}</div>
                   <div>Benchmark source: {m.benchmark_source || 'unknown'}</div>
                 </div>
              </div>
            ))}
            {recommendation && !recommendation?.error && Array.isArray(recommendation?.models) && recommendation.models.length === 0 && (
              <div className="pro-card">
                <div className="card__label">No Recommendations</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                  Analysis completed but returned no models for the provided hardware constraints.
                </div>
              </div>
            )}
            <HardwareDashboard />
            <ModelPicker />
          </>
        )}

        {tab === 'settings' && (
           <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="pro-card">
                 <div className="card__label">Agent Parameters</div>
                 <div className="setting-box">
                   <div className="setting-row">
                      <span className="setting-label">Self-Heal Loop</span>
                      <input type="number" className="setting-input" value={settings.self_heal_count} onChange={e => setSettings({...settings, self_heal_count: Number(e.target.value) || 0})} />
                   </div>
                   <div className="setting-row">
                     <span className="setting-label">Context Limit</span>
                     <input type="number" className="setting-input" value={settings.context_limit} onChange={e => setSettings({...settings, context_limit: Number(e.target.value) || 0})} />
                   </div>
                   <div className="setting-row">
                     <span className="setting-label">Local-only Mode</span>
                     <input
                      type="checkbox"
                      checked={!!settings.local_only}
                      onChange={e => setSettings({ ...settings, local_only: e.target.checked })}
                     />
                   </div>
                   <div style={{ marginTop: 10 }}>
                     <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-3)', marginBottom: 4 }}>Protected Paths (one per line)</div>
                     <textarea
                       className="setting-textarea"
                       value={protectedPathsText}
                       onChange={e => setProtectedPathsText(e.target.value)}
                       placeholder="F:/Cortex/server\nF:/Cortex/dashboard"
                     />
                   </div>
                 </div>
                 <button className="btn--primary btn--sm" style={{ width: '100%', marginTop: 12 }} onClick={saveSettings}>{saved === 'settings' ? 'Saved' : 'Keep Changes'}</button>
              </div>

              <div className="pro-card">
                <div className="card__label">Workspace Preferences</div>
                <div className="setting-box">
                  <div className="setting-row">
                    <span className="setting-label">Default Mode</span>
                    <select className="setting-select" value={prefDefaultMode} onChange={e => setPrefDefaultMode(e.target.value)}>
                      <option value="chat">chat</option>
                      <option value="build">build</option>
                      <option value="refactor">refactor</option>
                    </select>
                  </div>
                  <div className="setting-row" style={{ alignItems: 'flex-start' }}>
                    <span className="setting-label">Default Project</span>
                    <input
                      className="setting-input"
                      style={{ textAlign: 'left' }}
                      value={prefProjectPath}
                      onChange={e => setPrefProjectPath(e.target.value)}
                      placeholder="F:/Cortex"
                    />
                  </div>
                </div>
                <button className="btn--primary btn--sm" style={{ width: '100%', marginTop: 12 }} onClick={savePreferences}>
                  {prefSaving ? 'Saving...' : saved === 'prefs' ? 'Saved' : 'Save Preferences'}
                </button>
              </div>

              <div className="pro-card">
                 <div className="card__label">Routing Map</div>
                 <div className="setting-box">
                   {ROLES.map(role => (
                     <div className="setting-row" key={role}>
                        <span className="setting-label">{role}</span>
                        <select className="setting-select" value={router[role] || ''} onChange={e => setRouter({...router, [role]: e.target.value})}>
                          {models.map(m => <option key={m} value={m}>{m}</option>)}
                        </select>
                     </div>
                   ))}
                 </div>
                 <button className="btn--primary btn--sm" style={{ width: '100%', marginTop: 12 }} onClick={saveRouter}>Sync Router</button>
              </div>
           </div>
        )}

        {tab === 'rag' && (
          <RagContextEngine activeFile={activeFile} />
        )}

        {tab === 'connectors' && (
          <ConnectorsPanel />
        )}

        {tab === 'tools' && (
          <div className="pro-card">
            <div className="card__label">AI Tools</div>
            {toolRegistry.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-4)' }}>No tools discovered.</div>}
            {toolRegistry.map(t => (
              <label key={t.key} className="tool-toggle">
                <input type="checkbox" checked={!!toolConfig[t.key]} onChange={e => setToolConfig(prev => ({ ...prev, [t.key]: e.target.checked }))} />
                <div>
                  <div className="tool-label">{t.name}</div>
                  <div className="tool-desc">{t.key}</div>
                </div>
              </label>
            ))}
            <button className="btn--primary" onClick={saveTools} disabled={toolSaving}>{toolSaving ? 'Saving…' : 'Apply Tools'}</button>
            {Boolean(contractHealth?.contracts) && (
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-4)' }}>
                API contracts verified.
              </div>
            )}
          </div>
        )}

        {tab === 'queue' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="pro-card">
              <div className="card__label">Task Queue</div>
              <div className="setting-box">
                <div className="setting-row" style={{ alignItems: 'flex-start' }}>
                  <span className="setting-label">Task</span>
                  <textarea
                    className="setting-textarea"
                    value={queueDraftTask}
                    onChange={e => setQueueDraftTask(e.target.value)}
                    placeholder="Describe the task to queue"
                  />
                </div>
                <div className="setting-row">
                  <span className="setting-label">Mode</span>
                  <select className="setting-select" value={queueDraftMode} onChange={e => setQueueDraftMode(e.target.value)}>
                    <option value="chat">chat</option>
                    <option value="build">build</option>
                    <option value="refactor">refactor</option>
                  </select>
                </div>
                <div className="setting-row">
                  <span className="setting-label">Project Path</span>
                  <input
                    className="setting-input"
                    style={{ textAlign: 'left' }}
                    value={queueDraftPath}
                    onChange={e => setQueueDraftPath(e.target.value)}
                    placeholder="Optional"
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className="btn--primary btn--sm" style={{ flex: 1 }} onClick={addQueueTask} disabled={queueSaving || !queueDraftTask.trim()}>
                  {queueSaving ? 'Queueing...' : 'Add Task'}
                </button>
                <button className="btn--sm" style={{ flex: 1 }} onClick={refreshQueue}>
                  Refresh
                </button>
              </div>
            </div>

            <div className="pro-card">
              <div className="card__label">Pending Tasks</div>
              {queueLoading && <div style={{ fontSize: 11, color: 'var(--text-4)' }}>Loading queue...</div>}
              {!queueLoading && queueTasks.length === 0 && <div style={{ fontSize: 11, color: 'var(--text-4)' }}>No queued tasks.</div>}
              {!queueLoading && queueTasks.map(task => (
                <div key={task.id} className="queue-item">
                  <div style={{ minWidth: 0 }}>
                    <div className="queue-item__title">{task.task}</div>
                    <div className="queue-item__meta">{task.mode} • {task.status}</div>
                  </div>
                  <button className="queue-item__delete" onClick={() => removeQueueTask(task.id)}>Remove</button>
                </div>
              ))}
              {saved === 'queue' && <div style={{ marginTop: 8, fontSize: 11, color: 'var(--green)' }}>Task queued.</div>}
            </div>
          </div>
        )}

          {tab === 'api' && (
            <div className="rp-section">
              {API_ENDPOINTS.map((ep, i) => (
                <div key={i} className="api-row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                   <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, fontWeight: 900, background: 'var(--bg-hover)', padding: '2px 4px', borderRadius: 2 }}>{ep.method}</span>
                      <code style={{ fontSize: 11, color: 'var(--text-1)' }}>{ep.path}</code>
                   </div>
                   <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 4 }}>{ep.desc}</div>
                </div>
              ))}
           </div>
        )}

        {tab === 'outline' && (
          <div className="rp-section">
            <CodeOutline 
               code={activeFile?.content || ''} 
               language={activeFile?.path?.split('.').pop() || 'plaintext'} 
            />
          </div>
        )}
      </div>
    </div>
  );
}
