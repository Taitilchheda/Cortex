'use client';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import AppBar from './components/Header';
import LeftPanel from './components/Sidebar';
import MessageBubble from './components/MessageBubble';
import Breadcrumbs from './components/Breadcrumbs';
import CodeEditor from './components/CodeEditor';
import CommandBar from './components/InputBar';
import AgentOutput from './components/AgentOutput';
import RightPanel from './components/RightPanel';
import CommandPalette from './components/CommandPalette';
import ShortcutsModal from './components/ShortcutsModal';
import {
  ChatMessage, Session, BuildEvent, AgentMode, ChatRole, FileAttachment
} from './lib/types';
import {
  streamFetch, 
  fetchHealth, 
  fetchSessions, 
  fetchSession,
  deleteSession, 
  clearSessions, 
  pinSession, 
  fetchPinned,
  fetchFileTree, 
  readFile, 
  fetchAgentSettings,
  indexProject
} from './lib/api';
import { uid } from './lib/utils';
import {
  Cpu,
  MessageSquare,
  Zap,
  Hammer,
  AlertCircle,
  X,
  History as HistoryIcon,
  Files,
  Plus,
  GitBranch
} from 'lucide-react';
import {
  Panel,
  Group as PanelGroup,
  Separator as PanelResizeHandle,
  type GroupImperativeHandle,
  type Layout,
} from 'react-resizable-panels';
import { toast } from 'sonner';

type DesktopLayoutVariant = 'with-left' | 'without-left';

interface SessionEvent {
  type: string;
  data?: Record<string, unknown>;
  timestamp?: number;
}

interface SessionDetails extends Session {
  events?: SessionEvent[];
}

const PANEL_LAYOUT_STORAGE_PREFIX = 'cortex-desktop-layout-v1';
const DEFAULT_DESKTOP_LAYOUTS: Record<DesktopLayoutVariant, Layout> = {
  'with-left': {
    'left-panel': 22,
    'workspace-panel': 53,
    'right-panel': 25,
  },
  'without-left': {
    'workspace-panel': 74,
    'right-panel': 26,
  },
};

const getLayoutStorageKey = (variant: DesktopLayoutVariant) => `${PANEL_LAYOUT_STORAGE_PREFIX}:${variant}`;

const parseStoredLayout = (value: string | null): unknown => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const sanitizeLayout = (layout: unknown, fallback: Layout): Layout => {
  if (!layout || typeof layout !== 'object') return fallback;
  const source = layout as Record<string, unknown>;
  const normalized: Layout = {};
  let total = 0;

  for (const panelId of Object.keys(fallback)) {
    const value = source[panelId];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return fallback;
    }
    normalized[panelId] = value;
    total += value;
  }

  if (Math.abs(total - 100) > 0.5) return fallback;
  return normalized;
};

const readStoredLayouts = (): Record<DesktopLayoutVariant, Layout> => {
  if (typeof window === 'undefined') {
    return {
      'with-left': DEFAULT_DESKTOP_LAYOUTS['with-left'],
      'without-left': DEFAULT_DESKTOP_LAYOUTS['without-left'],
    };
  }

  return {
    'with-left': sanitizeLayout(
      parseStoredLayout(localStorage.getItem(getLayoutStorageKey('with-left'))),
      DEFAULT_DESKTOP_LAYOUTS['with-left']
    ),
    'without-left': sanitizeLayout(
      parseStoredLayout(localStorage.getItem(getLayoutStorageKey('without-left'))),
      DEFAULT_DESKTOP_LAYOUTS['without-left']
    ),
  };
};

const getDefaultDesktopLayouts = (): Record<DesktopLayoutVariant, Layout> => ({
  'with-left': { ...DEFAULT_DESKTOP_LAYOUTS['with-left'] },
  'without-left': { ...DEFAULT_DESKTOP_LAYOUTS['without-left'] },
});

export default function Cortex() {
  // ─── Core State ───────────────────────────────────────────────
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [ollamaOk, setOllamaOk] = useState(true);
  const [selfHealEnabled, setSelfHealEnabled] = useState(false);
  const [modelCount, setModelCount] = useState(0);

  // ─── Build State ──────────────────────────────────────────────
  const [showAgent, setShowAgent] = useState(false);
  const [buildEvents, setBuildEvents] = useState<BuildEvent[]>([]);
  const [architectText, setArchitectText] = useState('');
  const [fileCount, setFileCount] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);
  const [doneFiles, setDoneFiles] = useState(0);
  const [buildStartTime, setBuildStartTime] = useState<number | null>(null);
  const [lastBuildPath, setLastBuildPath] = useState('');
  const [lastBuildTask, setLastBuildTask] = useState('');
  const [buildComplete, setBuildComplete] = useState(false);

  // ─── UI State ─────────────────────────────────────────────────
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const [contextTokens, setContextTokens] = useState(0);
  const [contextLimit, setContextLimit] = useState(32768);
  const [openTabs, setOpenTabs] = useState<{ path: string; content: string }[]>([]);
  const [activeTabIdx, setActiveTabIdx] = useState(-1);

  const activeFile = useMemo(() => openTabs[activeTabIdx] || null, [openTabs, activeTabIdx]);
  const [defaultMode, setDefaultMode] = useState<AgentMode>('chat');
  const [isMobile, setIsMobile] = useState(false);
  const [mobileSection, setMobileSection] = useState<'nav' | 'workspace' | 'insight'>('workspace');
  const [activeTab, setActiveTab] = useState<'sessions' | 'files' | 'agent' | 'git'>('sessions');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [lastKnownPath, setLastKnownPath] = useState('');
  const [desktopLayouts, setDesktopLayouts] = useState<Record<DesktopLayoutVariant, Layout>>(getDefaultDesktopLayouts);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const panelGroupRef = useRef<GroupImperativeHandle | null>(null);

  // ─── Health Check (15s interval) ──────────────────────────────
  useEffect(() => {
    const check = async () => {
      try {
        const h = await fetchHealth();
        setOllamaOk(h.ollama?.status === 'connected');
        setModelCount(h.model_count || 0);
      } catch { setOllamaOk(false); }
    };
    check();
    const interval = setInterval(check, 15000);
    return () => clearInterval(interval);
  }, []);

  // ─── Load Sessions + Pinned ───────────────────────────────────
  useEffect(() => {
    const init = async () => {
      loadSessions();
      try {
        const setts = await fetchAgentSettings();
        setSelfHealEnabled(setts.test_on_build || false);
      } catch {}
      if (typeof window !== 'undefined') {
        const rememberedPath = localStorage.getItem('cortex-last-path') || '';
        if (rememberedPath) setLastKnownPath(rememberedPath);
      }
    };
    init();
    fetchPinned().then(d => setPinnedIds(new Set(d.pinned || []))).catch(() => {});
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setDesktopLayouts(readStoredLayouts());
  }, []);

  // Auto-index project when path changes
  useEffect(() => {
    if (lastBuildPath && lastBuildPath.length > 3) {
      const timer = setTimeout(async () => {
        try {
          await indexProject(lastBuildPath);
        } catch {}
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [lastBuildPath]);

  const loadSessions = async () => {
    try {
      const data = await fetchSessions();
      setSessions(data.sessions || []);
    } catch { /* Ollama may be offline */ }
  };

  // ─── Auto-scroll chat ────────────────────────────────────────
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // ─── Responsive check ───────────────────────────────────────────────────────
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 1100);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ─── Select Session (load full history) ──────────────────────
  const handleSelect = async (id: string) => {
    setActiveSessionId(id);
    setShowAgent(false);
    setBuildEvents([]);
    setOpenTabs([]);
    setActiveTabIdx(-1);
    setBuildComplete(false);
    setMessages([]);

    try {
      const full = await fetchSession(id) as SessionDetails;
      setActiveSession(full);

      if (full.type === 'build' || full.type === 'refactor') {
        setShowAgent(true);
        const events: BuildEvent[] = (full.events || []).map((e) => ({
          type: e.type,
          ...(e.data || {}),
        }));
        setBuildEvents(events);

        // Reconstruct architect text
        const archText = events
          .filter((e) => e.type === 'architect_stream')
          .map((e) => (typeof e.delta === 'string' ? e.delta : ''))
          .join('');
        setArchitectText(archText);

        const fc = events.filter((e) => e.type === 'file_created').length;
        setFileCount(fc);
        setDoneFiles(fc);

        // Find total from log event
        const planLog = events.find((e) => e.type === 'log' && e.phase === 'architect_done');
        if (Array.isArray(planLog?.plan?.files)) setTotalFiles(planLog.plan.files.length);

        // Check if complete
        const isDone = events.some((e) => e.type === 'log' && e.phase === 'complete');
        setBuildComplete(isDone);
      } else {
        // Rebuild chat messages from events
        const msgs: ChatMessage[] = [];
        // Replay full chat flow from events.
        for (const ev of full.events || []) {
          const data = ev.data || {};
          const timestamp = typeof ev.timestamp === 'number' ? ev.timestamp : Date.now() / 1000;

          if (ev.type === 'chat_start' && typeof data.task === 'string' && data.task) {
            msgs.push({
              id: uid(),
              role: 'user',
              content: data.task,
              timestamp,
            });
          }
          if (ev.type === 'chat_response') {
            const model = typeof data.model === 'string' ? data.model : undefined;
            const content = typeof data.content === 'string' ? data.content : '';
            const tokens = typeof data.tokens === 'number' ? data.tokens : undefined;
            msgs.push({
              id: uid(),
              role: 'assistant',
              content,
              timestamp,
              mode: model,
              model,
              tokens,
            });
          }
        }
        setMessages(msgs);
        // Estimate context tokens
        const totalTok = msgs.reduce((sum, m) => sum + Math.ceil((m.content?.length || 0) / 4), 0);
        setContextTokens(totalTok);
      }
    } catch { /* ignore */ }
  };

  // ─── New Session ──────────────────────────────────────────────
  const handleNew = () => {
    setActiveSessionId(null);
    setActiveSession(null);
    setMessages([]);
    setShowAgent(false);
    setBuildEvents([]);
    setArchitectText('');
    setFileCount(0);
    setDoneFiles(0);
    setTotalFiles(0);
    setContextTokens(0);
    setOpenTabs([]);
    setActiveTabIdx(-1);
    setBuildComplete(false);
  };

  // ─── Delete / Clear ───────────────────────────────────────────
  const handleDelete = async (id: string) => {
    try { await deleteSession(id); toast.success('Session deleted', { description: 'The session has been removed permanently.' }); } catch {}
    setSessions(prev => prev.filter(s => s.id !== id));
    if (id === activeSessionId) handleNew();
  };

  const handleClearAll = async () => {
    if (!confirm('Delete ALL sessions? This cannot be undone.')) return;
    try { await clearSessions(); toast.success('All sessions cleared', { description: 'Your history is now clean.' }); } catch {}
    setSessions([]);
    handleNew();
  };

  // ─── Pin / Unpin ──────────────────────────────────────────────
  const handleTogglePin = async (id: string) => {
    const newPinned = !pinnedIds.has(id);
    try { await pinSession(id, newPinned); } catch {}
    setPinnedIds(prev => {
      const next = new Set(prev);
      newPinned ? next.add(id) : next.delete(id);
      return next;
    });
    toast.success(newPinned ? 'Session pinned' : 'Session unpinned');
  };

  // ─── File Preview (Tabs) ─────────────────────────────────────────────
  const handleFileSelect = (path: string, content: string) => {
    setOpenTabs(prev => {
      const existing = prev.findIndex(t => t.path === path);
      if (existing !== -1) {
        setActiveTabIdx(existing);
        return prev;
      }
      const next = [...prev, { path, content }];
      setActiveTabIdx(next.length - 1);
      return next;
    });
    setShowAgent(false);
    setMessages([]);
  };

  const closeTab = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    const next = openTabs.filter((_, i) => i !== idx);
    setOpenTabs(next);
    if (activeTabIdx === idx) {
      setActiveTabIdx(next.length - 1);
    } else if (activeTabIdx > idx) {
      setActiveTabIdx(activeTabIdx - 1);
    }
  };

  // ─── Global Search ────────────────────────────────────────────
  const handleGlobalSearch = useCallback((query: string) => {
    const nextQuery = (query || '').trim();
    setSearchQuery(nextQuery);

    // If user is in a non-search panel, switch to sessions to show immediate results.
    if (nextQuery && activeTab === 'agent') {
      setActiveTab('sessions');
      if (!isMobile) {
        setSidebarVisible(true);
      } else {
        setMobileSection('nav');
      }
    }
  }, [activeTab, isMobile]);

  // ─── Mode Card Click ─────────────────────────────────────────
  const handleModeCardClick = (mode: AgentMode) => {
    setDefaultMode(mode);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cortex:prefill', { detail: { mode } }));
    }
  };

  const handleQuickStart = (payload: { text: string; mode: AgentMode; role?: ChatRole; projectPath?: string }) => {
    setDefaultMode(payload.mode);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('cortex:prefill', { detail: payload }));
    }
  };

  // ─── Continue Build ───────────────────────────────────────────
  const handleContinueBuild = () => {
    if (lastBuildTask && lastBuildPath) {
      handleSend(
        `Continue building: ${lastBuildTask}. Some files may already exist, generate the remaining files or improvements.`,
        'build', 'coder', lastBuildPath, [], false
      );
    }
  };

  // ─── Revert Build ─────────────────────────────────────────────
  const handleRevertBuild = async () => {
    if (!lastBuildPath) return;
    if (!confirm(`This will delete all generated files in:\n${lastBuildPath}\n\nAre you sure?`)) return;

    // Get list of files created in this session
    const createdFiles = buildEvents
      .filter(e => e.type === 'file_created')
      .map(e => e.path || '');

    for (const filePath of createdFiles) {
      try {
        // We can't delete from frontend directly, but we can tell the user
      } catch {}
    }

    // Show revert message
    setMessages(prev => [...prev, {
      id: uid(), role: 'assistant',
      content: `🔄 **Revert requested.** The following ${createdFiles.length} files were generated:\n\n${createdFiles.map(f => `- \`${f}\``).join('\n')}\n\nPlease manually delete these files or run:\n\`\`\`bash\n${createdFiles.map(f => `del "${f}"`).join('\n')}\n\`\`\``,
      timestamp: Date.now() / 1000,
    }]);
    setShowAgent(false);
  };

  const handleStop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      setIsStreaming(false);
      toast.info('Agent stopped manually.');
    }
  }, []);

  // ─── SEND ─────────────────────────────────────────────────────
  const handleSend = useCallback(async (
    text: string, mode: AgentMode, role: ChatRole, projectPath: string,
    attachments: FileAttachment[], selfHeal: boolean,
    approvedActions = false
  ) => {
    if (!ollamaOk) {
      toast.error('Ollama is not responding', { description: 'Please make sure Ollama is running locally.' });
      return;
    }
    if (isStreaming) {
      toast.warning('Agent is already running', { description: 'Please wait, or stop the current generator.' });
      return;
    }
    setOpenTabs([]);
    setActiveTabIdx(-1);
    setBuildComplete(false);

    // ─── CHAT MODE ──────────────────────────────────────────────
    if (mode === 'chat') {
      const userMsg: ChatMessage = {
        id: uid(), role: 'user', content: text, timestamp: Date.now() / 1000,
        attachments: attachments.length > 0 ? attachments : undefined,
      };
      setMessages(prev => [...prev, userMsg]);
      setShowAgent(false);
      setIsStreaming(true);

      const tStart = Date.now();
      const assistantId = uid();
      // Add empty assistant message that we'll stream into
      setMessages(prev => [...prev, {
        id: assistantId, role: 'assistant', content: '', timestamp: Date.now() / 1000,
        mode: role, model: '', isStreaming: true,
      }]);

      let responseSessionId = activeSessionId;
      let tokenCount = 0;
      let fullContent = '';
      let replayWithApproval = false;

      abortRef.current = new AbortController();

      await streamFetch(
        '/agent/chat',
        {
          task: text,
          mode: role,
          session_id: activeSessionId,
          attachments: attachments.length ? attachments : undefined,
          approved_actions: approvedActions,
        },
        (event) => {
          const ev = event as {
            type?: string;
            session_id?: string;
            delta?: string;
            message?: string;
            mode?: string;
            model?: string;
            confidence?: number;
            router_reason?: string;
            router_keywords?: string[];
            quality_tier?: 'fast' | 'balanced' | 'high';
            latency_budget_ms?: number;
            auto_escalated?: boolean;
            requested_mode?: string;
            resolved_mode?: string;
            fallback_applied?: boolean;
            reason?: string;
            matched_keywords?: string[];
            support_roles?: string[];
            risk_score?: number;
          };

          if (ev.type === 'session') {
            // Server assigned a session ID
            responseSessionId = ev.session_id || responseSessionId;
            if (ev.session_id) setActiveSessionId(ev.session_id);
          } else if (ev.type === 'log' && ev.resolved_mode) {
            setMessages(prev => {
              const updated = [...prev];
              const idx = updated.findIndex(m => m.id === assistantId);
              if (idx >= 0) {
                updated[idx] = {
                  ...updated[idx],
                  mode: ev.resolved_mode || updated[idx].mode,
                  routerDecision: {
                    requested_mode: ev.requested_mode,
                    resolved_mode: ev.resolved_mode,
                    confidence: ev.confidence,
                    fallback_applied: ev.fallback_applied,
                    reason: ev.reason,
                    matched_keywords: ev.matched_keywords,
                    support_roles: ev.support_roles,
                    quality_tier: ev.quality_tier,
                    latency_budget_ms: ev.latency_budget_ms,
                  },
                };
              }
              return updated;
            });
          } else if (ev.type === 'chat_stream') {
            const delta = ev.delta || '';
            tokenCount++;
            fullContent += delta;
            setMessages(prev => {
              const updated = [...prev];
              const idx = updated.findIndex(m => m.id === assistantId);
              if (idx >= 0) {
                updated[idx] = {
                  ...updated[idx],
                  content: updated[idx].content + delta,
                  mode: ev.mode || updated[idx].mode,
                  model: ev.model || updated[idx].model,
                  routerDecision: {
                    ...updated[idx].routerDecision,
                    confidence: ev.confidence,
                    reason: ev.router_reason || updated[idx].routerDecision?.reason,
                    matched_keywords: ev.router_keywords || updated[idx].routerDecision?.matched_keywords,
                    quality_tier: ev.quality_tier || updated[idx].routerDecision?.quality_tier,
                    latency_budget_ms: ev.latency_budget_ms || updated[idx].routerDecision?.latency_budget_ms,
                    auto_escalated: ev.auto_escalated || updated[idx].routerDecision?.auto_escalated,
                  },
                };
              }
              return updated;
            });
          } else if (ev.type === 'approval_required') {
            const reason = ev.reason || 'Approval is required for this high-risk action.';
            const risk = typeof ev.risk_score === 'number' ? ` (risk ${ev.risk_score})` : '';
            setMessages(prev => {
              const updated = [...prev];
              const idx = updated.findIndex(m => m.id === assistantId);
              if (idx >= 0) {
                updated[idx] = {
                  ...updated[idx],
                  content: `Approval required${risk}: ${reason}`,
                  isStreaming: false,
                  isError: true,
                };
              }
              return updated;
            });
            replayWithApproval = window.confirm(`${reason}\n\nProceed anyway?`);
          } else if (ev.type === 'error') {
            setMessages(prev => [...prev, {
              id: uid(), role: 'assistant', content: `⚠ ${ev.message || 'Unknown error'}`,
              timestamp: Date.now() / 1000, isError: true,
            }]);
          }
        },
        (err) => {
          setMessages(prev => {
            const updated = [...prev];
            const idx = updated.findIndex(m => m.id === assistantId);
            if (idx >= 0) {
              updated[idx] = {
                ...updated[idx],
                content: updated[idx].content || `Connection error: ${err}. Is the backend running on port 8000?`,
                isStreaming: false, isError: !updated[idx].content,
              };
            }
            return updated;
          });
        },
        abortRef.current.signal
      );

      // Finalize the assistant message
      const latency = Date.now() - tStart;
      setMessages(prev => {
        const updated = [...prev];
        const idx = updated.findIndex(m => m.id === assistantId);
        if (idx >= 0) {
          updated[idx] = {
            ...updated[idx],
            isStreaming: false,
            latency,
            tokens: tokenCount,
          };
        }
        return updated;
      });

      setContextTokens(prev => prev + Math.round(text.length / 4) + tokenCount);
      setIsStreaming(false);

      if (replayWithApproval) {
        return handleSend(text, mode, role, projectPath, attachments, selfHeal, true);
      }

      loadSessions();

    // ─── BUILD MODE ─────────────────────────────────────────────
    } else if (mode === 'build') {
      if (!projectPath) {
        setMessages(prev => [...prev,
          { id: uid(), role: 'user', content: text, timestamp: Date.now() / 1000 },
          { id: uid(), role: 'assistant', content: '⚠ **Project path is required for build mode.** Please enter a path where the files should be created (e.g., `C:\\my-project`).', timestamp: Date.now() / 1000, isError: true },
        ]);
        return;
      }

      setShowAgent(true);
      setMessages([]);
      setBuildEvents([]);
      setArchitectText('');
      setFileCount(0);
      setDoneFiles(0);
      setTotalFiles(0);
      setBuildStartTime(Date.now() / 1000);
      setLastBuildPath(projectPath);
      setLastBuildTask(text);
      if (typeof window !== 'undefined') {
        localStorage.setItem('cortex-last-path', projectPath);
      }
      setLastKnownPath(projectPath);
      setIsStreaming(true);
      setBuildComplete(false);

      abortRef.current = new AbortController();

      await streamFetch(
        '/agent/build',
        { task: text, project_path: projectPath, self_heal: selfHeal },
        (event) => {
          const parsed = event as {
            type?: string;
            delta?: string;
            phase?: string;
            plan?: { files?: unknown[] };
          };
          const ev: BuildEvent = { type: parsed.type || 'log', ...parsed };
          setBuildEvents(prev => [...prev, ev]);

          if (parsed.type === 'architect_stream') {
            setArchitectText(prev => prev + (parsed.delta || ''));
          } else if (parsed.type === 'log') {
            if (parsed.phase === 'architect_done' && parsed.plan?.files) {
              setTotalFiles(parsed.plan.files.length);
            }
            if (parsed.phase === 'complete') {
              setBuildComplete(true);
            }
          } else if (parsed.type === 'file_created') {
            setFileCount(prev => prev + 1);
            setDoneFiles(prev => prev + 1);
          }
        },
        (err) => {
          if (!err.includes('aborted')) setBuildEvents(prev => [...prev, { type: 'error', message: `Connection error: ${err}` }]);
        },
        abortRef.current.signal
      );

      setIsStreaming(false);
      loadSessions();

    // ─── REFACTOR MODE ──────────────────────────────────────────
    } else if (mode === 'refactor') {
      if (!projectPath) {
        setMessages(prev => [...prev,
          { id: uid(), role: 'user', content: text, timestamp: Date.now() / 1000 },
          { id: uid(), role: 'assistant', content: '⚠ **Project path is required for refactor mode.** Please enter the path to the project you want to refactor.', timestamp: Date.now() / 1000, isError: true },
        ]);
        return;
      }

      setShowAgent(true);
      setMessages([]);
      setBuildEvents([]);
      setArchitectText('');
      setBuildStartTime(Date.now() / 1000);
      setLastBuildPath(projectPath);
      if (typeof window !== 'undefined') {
        localStorage.setItem('cortex-last-path', projectPath);
      }
      setLastKnownPath(projectPath);
      setIsStreaming(true);

      abortRef.current = new AbortController();

      await streamFetch(
        '/agent/aider',
        { instruction: text, project_path: projectPath, approved_actions: approvedActions },
        (event) => {
          const ev = event as { type?: string; reason?: string };
          setBuildEvents(prev => [...prev, { type: ev.type || 'log', ...ev }]);
          if (ev.type === 'approval_required') {
            const reason = ev.reason || 'Approval required for refactor action.';
            const shouldProceed = window.confirm(`${reason}\n\nProceed with refactor?`);
            if (shouldProceed) {
              setTimeout(() => {
                handleSend(text, mode, role, projectPath, attachments, selfHeal, true);
              }, 0);
            }
          }
        },
        (err) => {
          if (!err.includes('aborted')) setBuildEvents(prev => [...prev, { type: 'error', message: err }]);
        },
        abortRef.current.signal
      );

      setIsStreaming(false);
      loadSessions();
    }
  }, [isStreaming, activeSessionId]);

  const showLeftPanel = isMobile ? mobileSection === 'nav' : sidebarVisible;
  const showWorkspacePanel = isMobile ? mobileSection === 'workspace' : true;
  const showRightPanel = isMobile ? mobileSection === 'insight' : true;
  const desktopLayoutVariant: DesktopLayoutVariant = showLeftPanel ? 'with-left' : 'without-left';
  const activeDesktopLayout = desktopLayouts[desktopLayoutVariant] ?? DEFAULT_DESKTOP_LAYOUTS[desktopLayoutVariant];

  const persistDesktopLayout = useCallback((variant: DesktopLayoutVariant, layout: Layout) => {
    const nextLayout = sanitizeLayout(layout, DEFAULT_DESKTOP_LAYOUTS[variant]);
    setDesktopLayouts(prev => ({ ...prev, [variant]: nextLayout }));
    if (typeof window !== 'undefined') {
      localStorage.setItem(getLayoutStorageKey(variant), JSON.stringify(nextLayout));
    }
  }, []);

  const handleLayoutChanged = useCallback((layout: Layout) => {
    if (isMobile) return;
    persistDesktopLayout(desktopLayoutVariant, layout);
  }, [isMobile, desktopLayoutVariant, persistDesktopLayout]);

  const handleResetDesktopLayout = useCallback(() => {
    if (isMobile) return;
    const resetLayout = DEFAULT_DESKTOP_LAYOUTS[desktopLayoutVariant];
    persistDesktopLayout(desktopLayoutVariant, resetLayout);
    panelGroupRef.current?.setLayout(resetLayout);
    toast.success('Panel layout reset', { description: 'Restored default panel proportions.' });
  }, [isMobile, desktopLayoutVariant, persistDesktopLayout]);

  useEffect(() => {
    if (isMobile) return;
    const raf = window.requestAnimationFrame(() => {
      panelGroupRef.current?.setLayout(activeDesktopLayout);
    });
    return () => window.cancelAnimationFrame(raf);
  }, [isMobile, activeDesktopLayout]);

  // ─── Render ───────────────────────────────────────────────────
  return (
    <div className="app-shell" id="app-shell">
      <ShortcutsModal />
      <CommandPalette
        sessions={sessions}
        onSelectSession={handleSelect}
        onNewSession={handleNew}
        onClearAll={handleClearAll}
        onGlobalSearch={handleGlobalSearch}
      />
      <AppBar 
        ollamaOk={ollamaOk} 
        modelCount={modelCount} 
        sessionCount={sessions.length}
        onGlobalSearch={handleGlobalSearch}
        sessions={sessions}
        activeSession={activeSession}
        activeFile={activeFile?.path || null}
      />

      <div className="main-content-area" id="cortex-panels">
        {/* Activity Bar (VS Code style) */}
        {!isMobile && (
          <div className="activity-bar">
            <button 
              className={`act-btn ${activeTab === 'sessions' ? 'active' : ''}`} 
              onClick={() => { setActiveTab('sessions'); setSidebarVisible(true); }}
              title="Sessions (Ctrl+Shift+H)"
            >
              <HistoryIcon size={20} />
            </button>
            <button 
              className={`act-btn ${activeTab === 'files' ? 'active' : ''}`} 
              onClick={() => { setActiveTab('files'); setSidebarVisible(true); }}
              title="Files (Ctrl+Shift+E)"
            >
              <Files size={20} />
            </button>
            <button 
              className={`act-btn ${activeTab === 'agent' ? 'active' : ''}`} 
              onClick={() => { setActiveTab('agent'); setSidebarVisible(true); }}
              title="Agent Status"
            >
              <Cpu size={20} />
            </button>
            <button 
              className={`act-btn ${activeTab === 'git' ? 'active' : ''}`} 
              onClick={() => { setActiveTab('git'); setSidebarVisible(true); }}
              title="Git History (Ctrl+Shift+G)"
            >
              <GitBranch size={20} />
            </button>
            <div style={{ flex: 1 }} />
            <button className="act-btn" onClick={handleNew} title="New Session (Ctrl+Shift+N)" style={{ color: 'var(--accent)', marginBottom: 12 }}>
               <Plus size={20} />
            </button>
            <button className="act-btn" onClick={() => setSidebarVisible(!sidebarVisible)} title="Toggle Sidebar (Ctrl+B)">
               <X size={18} style={{ transform: sidebarVisible ? 'none' : 'rotate(45deg)' }} />
            </button>
          </div>
        )}

        <PanelGroup
          orientation={isMobile ? 'vertical' : 'horizontal'}
          className="resizable-shell"
          disabled={isMobile}
          groupRef={panelGroupRef}
          defaultLayout={isMobile ? undefined : activeDesktopLayout}
          onLayoutChanged={handleLayoutChanged}
        >
          {showLeftPanel && (
            <>
              <Panel id="left-panel" defaultSize={22} minSize="16%" maxSize="34%">
                <div className="panel-container sidebar-left">
                  <LeftPanel
                    sessions={sessions}
                    activeSessionId={activeSessionId}
                    pinnedIds={pinnedIds}
                    onSelect={handleSelect}
                    onNew={handleNew}
                    onDelete={handleDelete}
                    onClearAll={handleClearAll}
                    onTogglePin={handleTogglePin}
                    onFileSelect={handleFileSelect}
                    searchQuery={searchQuery}
                    activeTab={activeTab}
                  />
                </div>
              </Panel>
              {!isMobile && (
                <PanelResizeHandle
                  className="panel-resize-handle"
                  onDoubleClick={handleResetDesktopLayout}
                  title="Drag to resize. Double-click to reset panel sizes."
                />
              )}
            </>
          )}

          {showWorkspacePanel && (
            <Panel id="workspace-panel" defaultSize={showLeftPanel ? 53 : 74} minSize="34%">
              <div className="panel-container workspace-center">
                <div className="workspace" id="workspace">
                  {/* ── Editor Tabs ── */}
                  {openTabs.length > 0 && !showAgent && (
                    <div className="editor-tabs">
                      {openTabs.map((t, i) => (
                        <div
                          key={t.path}
                          className={`editor-tab ${activeTabIdx === i ? 'active' : ''}`}
                          onClick={() => setActiveTabIdx(i)}
                        >
                          <span className="tab-name">{t.path.split(/[\\\/]/).pop()}</span>
                          <button className="tab-close" onClick={(e) => closeTab(e, i)}><X size={10} /></button>
                        </div>
                      ))}
                    </div>
                  )}

                  {activeFile && !showAgent ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                      <CodeEditor value={activeFile.content} path={activeFile.path} />
                    </div>
                  ) : showAgent ? (
                    <AgentOutput
                      events={buildEvents}
                      architectText={architectText}
                      isRunning={isStreaming}
                      totalFiles={totalFiles}
                      doneFiles={doneFiles}
                      startTime={buildStartTime}
                      buildComplete={buildComplete}
                      onContinue={handleContinueBuild}
                      onRevert={handleRevertBuild}
                      projectPath={lastBuildPath}
                    />
                  ) : messages.length > 0 ? (
                    <div className="chat-scroll" id="chat-container">
                      {messages.map(msg => <MessageBubble key={msg.id} message={msg} sessionId={activeSessionId} />)}
                      <div ref={chatEndRef} />
                    </div>
                  ) : (
                    <div className="ws-empty" id="empty-state">
                      <div className="pro-logo-large">
                        <Cpu size={48} color="var(--accent)" />
                      </div>
                      <div className="ws-empty__title">Cortex Pro</div>
                      <div className="ws-empty__desc">
                        The high-performance local AI coding environment.
                        Build, refactor, and chat with private models 100% on-device.
                      </div>
                      <div className="ws-empty__cards">
                        <div className="pro-mode-card" onClick={() => handleModeCardClick('chat')} id="mode-card-chat">
                          <MessageSquare size={20} className="icon-violet" />
                          <span>Chat</span>
                        </div>
                        <div className="pro-mode-card" onClick={() => handleModeCardClick('build')} id="mode-card-build">
                          <Zap size={20} className="icon-blue" />
                          <span>Build</span>
                        </div>
                        <div className="pro-mode-card" onClick={() => handleModeCardClick('refactor')} id="mode-card-refactor">
                          <Hammer size={20} className="icon-amber" />
                          <span>Refactor</span>
                        </div>
                      </div>
                      <div className="ws-empty__workflow">
                        <span className="ws-workflow-pill">Explore code</span>
                        <span className="ws-workflow-pill">Build features</span>
                        <span className="ws-workflow-pill">Review and ship</span>
                      </div>
                      <div className="ws-empty__actions">
                        <button
                          className="template-chip"
                          onClick={() => handleQuickStart({
                            mode: 'chat',
                            role: 'review',
                            text: 'Review this repository and list highest-severity risks with concrete fixes.',
                          })}
                        >
                          <span className="t-label">Run Design Review</span>
                          <span className="t-desc">Get a prioritized architecture and UX audit</span>
                        </button>
                        <button
                          className="template-chip"
                          onClick={() => handleQuickStart({
                            mode: 'build',
                            text: 'Create a production-ready feature with tests and docs.',
                            projectPath: lastKnownPath,
                          })}
                        >
                          <span className="t-label">Start Build Sprint</span>
                          <span className="t-desc">Scaffold feature flow and implementation plan</span>
                        </button>
                        <button
                          className="template-chip"
                          onClick={() => handleQuickStart({
                            mode: 'refactor',
                            text: 'Refactor this codebase for clarity and maintainability with minimal risk.',
                            projectPath: lastKnownPath,
                          })}
                        >
                          <span className="t-label">Start Refactor Sprint</span>
                          <span className="t-desc">Plan safe restructuring and staged edits</span>
                        </button>
                      </div>
                      {lastKnownPath && (
                        <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 6 }}>
                          Last workspace path: {lastKnownPath}
                        </div>
                      )}
                      {!ollamaOk && (
                        <div className="status-warning-box">
                          <AlertCircle size={14} />
                          <span>Ollama is not responding. Ensure it&apos;s running on port 11434.</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <CommandBar
                  onSend={handleSend}
                  onStop={handleStop}
                  isStreaming={isStreaming}
                  contextTokens={contextTokens}
                  contextLimit={contextLimit}
                  defaultMode={defaultMode}
                />
              </div>
            </Panel>
          )}

          {showWorkspacePanel && showRightPanel && !isMobile && (
            <PanelResizeHandle
              className="panel-resize-handle"
              onDoubleClick={handleResetDesktopLayout}
              title="Drag to resize. Double-click to reset panel sizes."
            />
          )}

          {showRightPanel && (
            <Panel id="right-panel" defaultSize={showLeftPanel ? 25 : 26} minSize="18%" maxSize="40%">
              <div className="panel-container sidebar-right">
                <RightPanel
                  activeSession={activeSession}
                  fileCount={fileCount}
                  isRunning={isStreaming}
                  doneFiles={doneFiles}
                  totalFiles={totalFiles}
                  contextTokens={contextTokens}
                  contextLimit={contextLimit}
                  activeFile={activeFile}
                />
              </div>
            </Panel>
          )}
        </PanelGroup>
      </div>

      {isMobile && (
        <div className="mobile-nav" role="tablist" aria-label="Mobile workspace switcher">
          <button className={mobileSection === 'nav' ? 'active' : ''} onClick={() => setMobileSection('nav')}>
            Sessions
          </button>
          <button className={mobileSection === 'workspace' ? 'active' : ''} onClick={() => setMobileSection('workspace')}>
            Workspace
          </button>
          <button className={mobileSection === 'insight' ? 'active' : ''} onClick={() => setMobileSection('insight')}>
            Insights
          </button>
        </div>
      )}

      {/* Agent Status Bar */}
      <div className="agent-strip" id="agent-strip" role="status" aria-label="Active agents" style={{ position: 'fixed', bottom: 16, right: 350, zIndex: 100 }}>
        {isStreaming ? (
          <div className={`agent-pill ${isStreaming ? 'agent-pill--running' : ''}`}>
            <span>{showAgent ? '⚡' : '💬'}</span>
            <span>{showAgent ? `Building · ${doneFiles}/${totalFiles || '?'} files` : 'Chatting...'}</span>
            {showAgent && totalFiles > 0 && (
              <div className="agent-mini-bar">
                <div className="agent-mini-fill" style={{ width: `${Math.round((doneFiles / totalFiles) * 100)}%` }} />
              </div>
            )}
          </div>
        ) : buildComplete ? (
          <div className="agent-pill agent-pill--done">
            <span>✅</span>
            <span>Build complete · {doneFiles} files</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
