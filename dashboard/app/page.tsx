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
  fetchAgentSettings
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
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { toast } from 'sonner';

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
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [sidebarVisible, setSidebarVisible] = useState(true);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    };
    init();
    fetchPinned().then(d => setPinnedIds(new Set(d.pinned || []))).catch(() => {});
  }, []);

  // Auto-index project when path changes
  useEffect(() => {
    if (lastBuildPath && lastBuildPath.length > 3) {
      const timer = setTimeout(async () => {
        try {
          await fetch('/project/index', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_path: lastBuildPath })
          });
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
      const full = await fetchSession(id);
      setActiveSession(full);

      if (full.type === 'build' || full.type === 'refactor') {
        setShowAgent(true);
        const events: BuildEvent[] = (full.events || []).map((e: any) => ({
          type: e.type, ...e.data
        }));
        setBuildEvents(events);

        // Reconstruct architect text
        const archText = events
          .filter((e: any) => e.type === 'architect_stream')
          .map((e: any) => e.delta || '')
          .join('');
        setArchitectText(archText);

        const fc = events.filter((e: any) => e.type === 'file_created').length;
        setFileCount(fc);
        setDoneFiles(fc);

        // Find total from log event
        const planLog = events.find((e: any) => e.type === 'log' && e.phase === 'architect_done');
        if (planLog?.plan?.files) setTotalFiles(planLog.plan.files.length);

        // Check if complete
        const isDone = events.some((e: any) => e.type === 'log' && e.phase === 'complete');
        setBuildComplete(isDone);
      } else {
        // Rebuild chat messages from events
        const msgs: ChatMessage[] = [];
        // Add user's original message
        if (full.title) {
          msgs.push({
            id: uid(), role: 'user', content: full.title, timestamp: full.created_at,
          });
        }
        for (const ev of full.events || []) {
          if (ev.type === 'chat_response') {
            msgs.push({
              id: uid(), role: 'assistant', content: ev.data?.content || '',
              timestamp: ev.timestamp || Date.now() / 1000,
              mode: ev.data?.model, model: ev.data?.model,
              tokens: ev.data?.tokens,
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
  const handleGlobalSearch = (query: string) => {
    setSearchQuery(query);
  };

  // ─── Mode Card Click ─────────────────────────────────────────
  const handleModeCardClick = (mode: AgentMode) => {
    setDefaultMode(mode);
    // Focus the input bar
    setTimeout(() => {
      const input = document.getElementById('main-input') as HTMLTextAreaElement;
      input?.focus();
    }, 100);
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
    attachments: FileAttachment[], selfHeal: boolean
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

      abortRef.current = new AbortController();

      await streamFetch(
        '/agent/chat',
        {
          task: text,
          mode: role,
          session_id: activeSessionId,
          attachments: attachments.length ? attachments : undefined
        },
        (event) => {
          if (event.type === 'session') {
            // Server assigned a session ID
            responseSessionId = event.session_id;
            setActiveSessionId(event.session_id);
          } else if (event.type === 'chat_stream') {
            const delta = event.delta || '';
            tokenCount++;
            fullContent += delta;
            setMessages(prev => {
              const updated = [...prev];
              const idx = updated.findIndex(m => m.id === assistantId);
              if (idx >= 0) {
                updated[idx] = { ...updated[idx], content: updated[idx].content + delta };
              }
              return updated;
            });
          } else if (event.type === 'error') {
            setMessages(prev => [...prev, {
              id: uid(), role: 'assistant', content: `⚠ ${event.message || 'Unknown error'}`,
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
      setIsStreaming(true);
      setBuildComplete(false);

      abortRef.current = new AbortController();

      await streamFetch(
        '/agent/build',
        { task: text, project_path: projectPath, self_heal: selfHeal },
        (event) => {
          const ev: BuildEvent = { type: event.type, ...event };
          setBuildEvents(prev => [...prev, ev]);

          if (event.type === 'architect_stream') {
            setArchitectText(prev => prev + (event.delta || ''));
          } else if (event.type === 'log') {
            if (event.phase === 'architect_done' && event.plan?.files) {
              setTotalFiles(event.plan.files.length);
            }
            if (event.phase === 'complete') {
              setBuildComplete(true);
            }
          } else if (event.type === 'file_created') {
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
      setIsStreaming(true);

      abortRef.current = new AbortController();

      await streamFetch(
        '/agent/aider',
        { instruction: text, project_path: projectPath },
        (event) => {
          setBuildEvents(prev => [...prev, { type: event.type, ...event }]);
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

        <div 
          className="panel-container sidebar-left" 
          style={{
            display: (isMobile && mobileSection !== 'nav') || !sidebarVisible ? 'none' : 'flex',
            width: sidebarWidth,
          }}
        >
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

        <div 
          className="panel-container workspace-center" 
          style={{ display: isMobile && mobileSection !== 'workspace' ? 'none' : 'flex' }}
        >
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
                {messages.map(msg => <MessageBubble key={msg.id} message={msg} />)}
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
                {!ollamaOk && (
                  <div className="status-warning-box">
                    <AlertCircle size={14} />
                    <span>Ollama is not responding. Ensure it's running on port 11434.</span>
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

        <div 
          className="panel-container sidebar-right" 
          style={isMobile && mobileSection !== 'insight' ? { display: 'none' } : undefined}
        >
          <RightPanel
            activeSession={activeSession}
            fileCount={fileCount}
            isRunning={isStreaming}
            doneFiles={doneFiles}
            totalFiles={totalFiles}
            contextTokens={contextTokens}
            contextLimit={contextLimit}
          />
        </div>
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
