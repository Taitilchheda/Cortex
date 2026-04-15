'use client';
import { useState, useEffect } from 'react';
import { Session, AgentSettings } from '../lib/types';
import {
  fetchRecommendations, fetchModels, fetchRouter, updateRouter,
  fetchAgentSettings, updateAgentSettings, configureTools,
  fetchFeatureHealth, fetchContractHealth
} from '../lib/api';
import { 
  Activity, 
  Lightbulb, 
  Settings, 
  Plug, 
  Binary, 
  Cpu, 
  Database, 
  Zap,
  HardDrive,
  Globe2,
  List
} from 'lucide-react';
import CodeOutline from './CodeOutline';

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

const API_ENDPOINTS = [
  { method: 'GET', path: '/', desc: 'Server info + Ollama status' },
  { method: 'GET', path: '/health', desc: 'Full health check' },
  { method: 'POST', path: '/agent/build', desc: 'Build pipeline (SSE stream)' },
  { method: 'POST', path: '/agent/chat', desc: 'Chat with role routing (SSE)' },
  { method: 'POST', path: '/agent/aider', desc: 'Aider refactor (SSE)' },
  { method: 'POST', path: '/v1/chat/completions', desc: 'OpenAI-compatible' },
  { method: 'GET', path: '/v1/models', desc: 'Model list' },
];

const ROLES = ['architect', 'coder', 'debug', 'quick', 'explain', 'review'];

export default function RightPanel({
  activeSession, fileCount, isRunning, doneFiles, totalFiles, contextTokens, contextLimit, activeFile
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
    self_heal_count: 3, review_on_build: false, test_on_build: false, context_limit: 32768, local_only: false,
  });
  const [featureHealth, setFeatureHealth] = useState<any>(null);
  const [contractHealth, setContractHealth] = useState<any>(null);
  const [toolConfig, setToolConfig] = useState<Record<string, boolean>>({
    web_search: true,
    rag_index: false,
    code_review: true,
    telemetry: true,
  });
  const [toolSaving, setToolSaving] = useState(false);

  useEffect(() => {
    fetchModels().then(d => setModels(d.data?.map((m: any) => m.id) || [])).catch(() => {});
    fetchRouter().then(d => setRouter(d.router || {})).catch(() => {});
    fetchAgentSettings().then(d => setSettings(d)).catch(() => {});
    fetchFeatureHealth().then(setFeatureHealth).catch(() => {});
    fetchContractHealth().then(setContractHealth).catch(() => {});
    const stored = typeof window !== 'undefined' ? localStorage.getItem('cortex-tools') : null;
    if (stored) {
      try { setToolConfig(JSON.parse(stored)); } catch {}
    }
  }, []);

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
    setToolSaving(true);
    await configureTools(Object.entries(toolConfig).filter(([_, enabled]) => enabled).map(([k]) => k));
    localStorage.setItem('cortex-tools', JSON.stringify(toolConfig));
    setSaved('tools');
    setTimeout(() => setSaved(''), 2000);
    setToolSaving(false);
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
          <div className="pro-card">
             <div className="card__label">Agent Activity</div>
             <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                <div className={`status-ring ${isRunning ? 'status-ring--ok' : ''}`} style={{ background: isRunning ? 'var(--accent)' : 'var(--text-4)' }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{isRunning ? 'Processing Workspace' : 'Waiting for Input'}</span>
             </div>
             {featureHealth?.features && (
               <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)', display: 'grid', gap: 4 }}>
                 <div>Memory: {featureHealth.features.memory ? 'ok' : 'down'}</div>
                 <div>Web Search: {featureHealth.features.web_search ? 'ok' : 'down'}</div>
                 <div>Git: {featureHealth.features.git ? 'ok' : 'down'}</div>
                 <div>Local Only: {featureHealth.features.local_only ? 'on' : 'off'}</div>
               </div>
             )}
          </div>
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
               <button className="btn--primary btn--sm" style={{ width: '100%', marginTop: 12 }} onClick={doRecommend}>Run Analysis</button>
            </div>
            {recommendation?.models?.map((m: any, i: number) => (
              <div className="pro-card" key={i}>
                 <div className="pro-head"><span className="pro-name">{m.model}</span><span className="pro-badge">{m.rank}</span></div>
                 <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{m.specialty}</div>
              </div>
            ))}
          </>
        )}

        {tab === 'settings' && (
           <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="pro-card">
                 <div className="card__label">Agent Parameters</div>
                 <div className="setting-box">
                   <div className="setting-row">
                      <span className="setting-label">Self-Heal Loop</span>
                      <input type="number" className="setting-input" value={settings.self_heal_count} onChange={e => setSettings({...settings, self_heal_count: parseInt(e.target.value)})} />
                   </div>
                   <div className="setting-row">
                     <span className="setting-label">Local-only Mode</span>
                     <input
                      type="checkbox"
                      checked={!!settings.local_only}
                      onChange={e => setSettings({ ...settings, local_only: e.target.checked })}
                     />
                   </div>
                 </div>
                 <button className="btn--primary btn--sm" style={{ width: '100%', marginTop: 12 }} onClick={saveSettings}>{saved === 'settings' ? 'Saved' : 'Keep Changes'}</button>
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

        {tab === 'tools' && (
          <div className="pro-card">
            <div className="card__label">AI Tools</div>
            {['web_search', 'rag_index', 'code_review', 'telemetry'].map(t => (
              <label key={t} className="tool-toggle">
                <input type="checkbox" checked={toolConfig[t]} onChange={e => setToolConfig(prev => ({ ...prev, [t]: e.target.checked }))} />
                <div className="tool-label">{t.replace('_', ' ')}</div>
              </label>
            ))}
            <button className="btn--primary" onClick={saveTools} disabled={toolSaving}>{toolSaving ? 'Saving…' : 'Apply Tools'}</button>
            {contractHealth?.contracts && (
              <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-4)' }}>
                API contracts verified.
              </div>
            )}
          </div>
        )}

        {tab === 'api' && (
           <div className="lp-scrollable">
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
          <div className="lp-scrollable">
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
