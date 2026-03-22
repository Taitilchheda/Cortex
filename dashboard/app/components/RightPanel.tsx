'use client';
import { useState, useEffect } from 'react';
import { Session, AgentSettings } from '../lib/types';
import {
  fetchRecommendations, fetchModels, fetchRouter, updateRouter,
  fetchAgentSettings, updateAgentSettings
} from '../lib/api';

interface RightPanelProps {
  activeSession: Session | null;
  fileCount: number;
  isRunning: boolean;
  doneFiles: number;
  totalFiles: number;
  contextTokens: number;
  contextLimit: number;
}

type TabKey = 'context' | 'monitor' | 'advisor' | 'settings' | 'api';

const API_ENDPOINTS = [
  { method: 'GET', path: '/', desc: 'Server info + Ollama status' },
  { method: 'GET', path: '/health', desc: 'Full health check' },
  { method: 'POST', path: '/agent/build', desc: 'Build pipeline (SSE stream)' },
  { method: 'POST', path: '/agent/chat', desc: 'Chat with role routing (SSE)' },
  { method: 'POST', path: '/agent/aider', desc: 'Aider refactor (SSE)' },
  { method: 'POST', path: '/v1/chat/completions', desc: 'OpenAI-compatible endpoint' },
  { method: 'GET', path: '/v1/models', desc: 'Model list (OpenAI format)' },
  { method: 'POST', path: '/files/upload', desc: 'File upload (multipart)' },
  { method: 'GET', path: '/files/tree', desc: 'File tree for project path' },
  { method: 'GET', path: '/files/read', desc: 'Read file content' },
  { method: 'GET', path: '/config/router', desc: 'Current model routing' },
  { method: 'POST', path: '/config/router', desc: 'Update routing live' },
  { method: 'POST', path: '/system/recommend', desc: 'Model recommendations' },
  { method: 'GET', path: '/settings/agent', desc: 'Agent behaviour settings' },
  { method: 'POST', path: '/settings/agent', desc: 'Update agent settings' },
  { method: 'GET', path: '/notifications', desc: 'Recent notifications' },
  { method: 'DELETE', path: '/notifications', desc: 'Clear notifications' },
  { method: 'GET', path: '/sessions', desc: 'List sessions' },
  { method: 'GET', path: '/sessions/{id}', desc: 'Full session with replay' },
  { method: 'DELETE', path: '/sessions/{id}', desc: 'Delete session' },
  { method: 'POST', path: '/sessions/{id}/pin', desc: 'Pin/unpin session' },
  { method: 'GET', path: '/templates', desc: 'Project templates' },
  { method: 'GET', path: '/benchmarks', desc: 'Coding benchmarks' },
];

const ROLES = ['architect', 'coder', 'debug', 'quick', 'explain', 'review'];

export default function RightPanel({
  activeSession, fileCount, isRunning, doneFiles, totalFiles, contextTokens, contextLimit
}: RightPanelProps) {
  const [tab, setTab] = useState<TabKey>('context');
  const [vram, setVram] = useState('12');
  const [ram, setRam] = useState('32');
  const [priority, setPriority] = useState('balanced');
  const [recommendation, setRecommendation] = useState<any>(null);
  const [models, setModels] = useState<string[]>([]);
  const [router, setRouter] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState('');
  const [settings, setSettings] = useState<AgentSettings>({
    auto_approve: 'ask', max_files: 50, max_retries: 1,
    self_heal_count: 3, review_on_build: false, test_on_build: false, context_limit: 32768,
  });
  const [tools, setTools] = useState({
    file_writer: true, bash: true, http_fetch: true, git: true
  });

  useEffect(() => {
    fetchModels().then(d => setModels(d.data?.map((m: any) => m.id) || [])).catch(() => {});
    fetchRouter().then(d => setRouter(d.router || {})).catch(() => {});
    fetchAgentSettings().then(d => setSettings(d)).catch(() => {});
  }, []);

  // Auto-switch to monitor when running
  useEffect(() => {
    if (isRunning) setTab('monitor');
  }, [isRunning]);

  const doRecommend = async () => {
    setLoading(true);
    try {
      const r = await fetchRecommendations(parseFloat(vram), parseFloat(ram), priority);
      setRecommendation(r);
    } catch { /* ignore */ }
    setLoading(false);
  };

  const applyRecommendation = async () => {
    if (!recommendation?.suggested_router) return;
    const result = await updateRouter(recommendation.suggested_router);
    setRouter(result.router);
  };

  const saveRouter = async () => {
    const result = await updateRouter(router);
    setRouter(result.router);
    setSaved('router');
    setTimeout(() => setSaved(''), 2000);
  };

  const saveSettings = async () => {
    const result = await updateAgentSettings(settings);
    setSettings(result);
    setSaved('settings');
    setTimeout(() => setSaved(''), 2000);
  };

  const saveTools = async () => {
    // Mock save, wait for v5 for full backend connection
    setSaved('tools');
    setTimeout(() => setSaved(''), 2000);
  };

  // Token usage
  const tok = activeSession?.token_usage;
  const tokPercent = contextLimit > 0 ? Math.min((contextTokens / contextLimit) * 100, 100) : 0;
  const tokColor = tokPercent < 50 ? 'green' : tokPercent < 80 ? 'amber' : 'red';

  return (
    <div className="right-panel" id="right-panel">
      <div className="rp-tabs">
        {(['context', 'monitor', 'advisor', 'settings', 'api'] as TabKey[]).map(t => (
          <button key={t} className={`rp-tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)} id={`rp-tab-${t}`}>
            {t === 'context' ? '🔍' : t === 'monitor' ? '📊' : t === 'advisor' ? '💡' : t === 'settings' ? '⚙' : '🔌'}
          </button>
        ))}
      </div>

      <div className="rp-scroll">
        {/* ── Context Inspector ── */}
        {tab === 'context' && (
          <>
            <div className="card">
              <div className="card__label">Context Window</div>
              <div className="tok-gauge">
                <div className="tok-bar">
                  <div className={`tok-fill ${tokColor}`} style={{ width: `${tokPercent}%` }} />
                </div>
                <div className="tok-nums">
                  <span>{contextTokens.toLocaleString()} used</span>
                  <span>{contextLimit.toLocaleString()} limit</span>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card__label">Files Created</div>
              <div className="card__val">{fileCount}</div>
              <div className="card__sub">this session</div>
            </div>

            {tok && tok.total_tokens ? (
              <>
                <div className="card">
                  <div className="card__label">Token Usage</div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
                    <div style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 800 }}>{(tok.total_prompt || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-4)' }}>Prompt</div>
                    </div>
                    <div style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 800 }}>{(tok.total_completion || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-4)' }}>Completion</div>
                    </div>
                    <div style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--cyan)' }}>{(tok.total_tokens || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-4)' }}>Total</div>
                    </div>
                  </div>
                </div>

                {tok.by_model && Object.keys(tok.by_model).length > 0 && (
                  <div className="card">
                    <div className="card__label">By Model</div>
                    {Object.entries(tok.by_model).map(([model, usage]) => (
                      <div key={model} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11 }}>
                        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{model}</span>
                        <span style={{ color: 'var(--text-4)' }}>{(usage.prompt + usage.completion).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="card">
                <div className="card__label">Token Usage</div>
                <div className="card__sub">No tokens used yet</div>
              </div>
            )}

            <div className="card">
              <div className="card__label">OpenAI Compatible</div>
              <div className="card__mono" style={{ marginTop: 4 }}>http://localhost:8000/v1</div>
              <div className="card__sub">API Key: local (any string)</div>
            </div>
          </>
        )}

        {/* ── Live Agent Monitor ── */}
        {tab === 'monitor' && (
          <>
            <div className="card">
              <div className="card__label">Agent Status</div>
              <div className="card__val" style={{ fontSize: 14, color: isRunning ? 'var(--violet)' : 'var(--green)' }}>
                {isRunning ? '● Running' : '○ Idle'}
              </div>
            </div>

            {isRunning && totalFiles > 0 && (
              <div className="card">
                <div className="card__label">File Progress</div>
                <div className="progress-outer" style={{ height: 6 }}>
                  <div className="progress-inner" style={{ width: `${Math.round((doneFiles / totalFiles) * 100)}%` }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 11 }}>
                  <span style={{ color: 'var(--green)', fontWeight: 700 }}>{doneFiles} / {totalFiles} files</span>
                  <span style={{ color: 'var(--text-4)' }}>{Math.round((doneFiles / totalFiles) * 100)}%</span>
                </div>
              </div>
            )}

            <div className="card">
              <div className="card__label">Session Type</div>
              <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'capitalize', color: 'var(--text-2)' }}>
                {activeSession?.type || 'None'}
              </div>
            </div>
          </>
        )}

        {/* ── Advisor ── */}
        {tab === 'advisor' && (
          <>
            <div className="card">
              <div className="card__label">Hardware Profile</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 10, color: 'var(--text-4)', fontWeight: 700 }}>GPU VRAM (GB)</label>
                  <input type="number" className="lp-search" style={{ width: '100%', marginTop: 3 }}
                    value={vram} onChange={e => setVram(e.target.value)} id="vram-input" />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ fontSize: 10, color: 'var(--text-4)', fontWeight: 700 }}>System RAM (GB)</label>
                  <input type="number" className="lp-search" style={{ width: '100%', marginTop: 3 }}
                    value={ram} onChange={e => setRam(e.target.value)} id="ram-input" />
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
                <label style={{ fontSize: 10, color: 'var(--text-4)', fontWeight: 700 }}>Priority</label>
                <select className="lp-search" style={{ width: '100%', marginTop: 3, cursor: 'pointer' }}
                  value={priority} onChange={e => setPriority(e.target.value)} id="priority-select">
                  <option value="speed">Speed</option>
                  <option value="balanced">Balanced</option>
                  <option value="quality">Quality</option>
                </select>
              </div>
              <button className="btn btn--primary" style={{ width: '100%', justifyContent: 'center', marginTop: 10 }}
                onClick={doRecommend} disabled={loading} id="recommend-btn">
                {loading ? 'Analyzing...' : '🔍 Analyze Models'}
              </button>
            </div>

            {recommendation?.models?.map((m: any, i: number) => (
              <div className="mr-card" key={i}>
                <div className="mr-head">
                  <span className="mr-name">{m.model}</span>
                  <span className={`mr-rank rank-${m.rank?.replace('+', '')}`}>{m.rank}</span>
                </div>
                <div className="mr-meta">
                  <span>{m.size_gb}GB</span>
                  <span>HumanEval: {m.humaneval}%</span>
                  <span>{m.specialty}</span>
                </div>
                <div style={{ marginTop: 4 }}>
                  {m.fits_vram
                    ? <span style={{ fontSize: 10, color: 'var(--green)', fontWeight: 700 }}>✓ Fits VRAM</span>
                    : m.needs_ram_offload
                      ? <span style={{ fontSize: 10, color: 'var(--amber)', fontWeight: 700 }}>⚠ RAM Offload</span>
                      : <span style={{ fontSize: 10, color: 'var(--red)', fontWeight: 700 }}>✕ Too Large</span>}
                </div>
              </div>
            ))}

            {recommendation && (
              <button className="btn btn--primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }}
                onClick={applyRecommendation} id="apply-rec-btn">✅ Apply Recommendations</button>
            )}
          </>
        )}

        {/* ── Settings ── */}
        {tab === 'settings' && (
          <>
            {/* Agent behaviour */}
            <div className="card">
              <div className="card__label">Agent Behaviour</div>

              <div className="setting-row" style={{ marginTop: 6 }}>
                <span className="setting-label">Auto-approve writes</span>
                <div className="setting-ctrl">
                  <select value={settings.auto_approve} onChange={e => setSettings({ ...settings, auto_approve: e.target.value })}>
                    <option value="ask">Always Ask</option>
                    <option value="always_proceed">Always Proceed</option>
                    <option value="ask_new_only">Ask for New Only</option>
                  </select>
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Max files per build</span>
                <div className="setting-ctrl">
                  <input type="number" value={settings.max_files} min={5} max={100}
                    onChange={e => setSettings({ ...settings, max_files: parseInt(e.target.value) || 50 })} />
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Max retries per file</span>
                <div className="setting-ctrl">
                  <input type="number" value={settings.max_retries} min={0} max={5}
                    onChange={e => setSettings({ ...settings, max_retries: parseInt(e.target.value) || 1 })} />
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Self-heal loop count</span>
                <div className="setting-ctrl">
                  <input type="number" value={settings.self_heal_count} min={0} max={5}
                    onChange={e => setSettings({ ...settings, self_heal_count: parseInt(e.target.value) || 3 })} />
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Context window limit</span>
                <div className="setting-ctrl">
                  <select value={settings.context_limit}
                    onChange={e => setSettings({ ...settings, context_limit: parseInt(e.target.value) })}>
                    <option value={4096}>4K</option>
                    <option value={8192}>8K</option>
                    <option value={16384}>16K</option>
                    <option value={32768}>32K</option>
                    <option value={131072}>128K</option>
                  </select>
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Review on build</span>
                <div className="setting-ctrl">
                  <input type="checkbox" checked={settings.review_on_build}
                    onChange={e => setSettings({ ...settings, review_on_build: e.target.checked })} />
                </div>
              </div>

              <div className="setting-row">
                <span className="setting-label">Test on build</span>
                <div className="setting-ctrl">
                  <input type="checkbox" checked={settings.test_on_build}
                    onChange={e => setSettings({ ...settings, test_on_build: e.target.checked })} />
                </div>
              </div>

              <button className="btn btn--primary btn--sm" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                onClick={saveSettings}>{saved === 'settings' ? '✅ Saved!' : '💾 Save Settings'}</button>
            </div>

            {/* Model Routing */}
            <div className="card">
              <div className="card__label">Model Routing</div>
              {ROLES.map(role => (
                <div className="setting-row" key={role} style={{ marginTop: role === ROLES[0] ? 6 : 0 }}>
                  <span className="setting-label">{role}</span>
                  <div className="setting-ctrl">
                    <select value={router[role] || ''} onChange={e => setRouter({ ...router, [role]: e.target.value })}
                      id={`router-${role}`}>
                      {models.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                </div>
              ))}
              <button className="btn btn--primary btn--sm" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                onClick={saveRouter} id="save-router-btn">{saved === 'router' ? '✅ Saved!' : '💾 Save Router'}</button>
            </div>

            {/* Configured Tools */}
            <div className="card">
              <div className="card__label">Tool Access</div>
              
              <div className="setting-row" style={{ marginTop: 6 }}>
                <span className="setting-label">File Writer</span>
                <div className="setting-ctrl">
                  <input type="checkbox" checked={tools.file_writer}
                    onChange={e => setTools({ ...tools, file_writer: e.target.checked })} />
                </div>
              </div>
              <div className="setting-row">
                <span className="setting-label">Terminal/Bash</span>
                <div className="setting-ctrl">
                  <input type="checkbox" checked={tools.bash}
                    onChange={e => setTools({ ...tools, bash: e.target.checked })} />
                </div>
              </div>
              <div className="setting-row">
                <span className="setting-label">HTTP Fetch</span>
                <div className="setting-ctrl">
                  <input type="checkbox" checked={tools.http_fetch}
                    onChange={e => setTools({ ...tools, http_fetch: e.target.checked })} />
                </div>
              </div>
              <div className="setting-row">
                <span className="setting-label">Git Commands</span>
                <div className="setting-ctrl">
                  <input type="checkbox" checked={tools.git}
                    onChange={e => setTools({ ...tools, git: e.target.checked })} />
                </div>
              </div>

              <button className="btn btn--primary btn--sm" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
                onClick={saveTools}>{saved === 'tools' ? '✅ Saved!' : '🔧 Configure Tools'}</button>
            </div>
          </>
        )}

        {/* ── API Docs ── */}
        {tab === 'api' && (
          <>
            <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--text-3)' }}>
              All endpoints on <code className="inline-code">localhost:8000</code>
            </div>
            {API_ENDPOINTS.map((ep, i) => (
              <div key={i} className="api-row">
                <div>
                  <span className={`api-method api-${ep.method}`}>{ep.method}</span>
                  <span className="api-path">{ep.path}</span>
                </div>
                <div className="api-desc">{ep.desc}</div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
