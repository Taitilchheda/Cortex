'use client';
import { useState, useEffect, useMemo } from 'react';
import { Session, FileNode } from '../lib/types';
import { fetchFileTree, readFile, fetchModels, fetchRouter, pinSession } from '../lib/api';
import { formatBytes, formatTimestamp, getSessionIcon, truncate } from '../lib/utils';

interface LeftPanelProps {
  sessions: Session[];
  activeSessionId: string | null;
  pinnedIds: Set<string>;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onTogglePin: (id: string) => void;
  onFileSelect?: (path: string, content: string) => void;
  searchQuery: string;
}

type TabKey = 'sessions' | 'files' | 'models';

// Group sessions by relative date
function groupSessions(sessions: Session[], pinnedIds: Set<string>) {
  const now = Date.now() / 1000;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayTs = todayStart.getTime() / 1000;
  const yesterdayTs = todayTs - 86400;
  const weekTs = todayTs - 7 * 86400;

  const groups: { label: string; items: Session[] }[] = [];
  const pinned = sessions.filter(s => pinnedIds.has(s.id));
  const unpinned = sessions.filter(s => !pinnedIds.has(s.id));

  if (pinned.length) groups.push({ label: '📌 Pinned', items: pinned });

  const today = unpinned.filter(s => s.created_at >= todayTs);
  const yesterday = unpinned.filter(s => s.created_at >= yesterdayTs && s.created_at < todayTs);
  const week = unpinned.filter(s => s.created_at >= weekTs && s.created_at < yesterdayTs);
  const older = unpinned.filter(s => s.created_at < weekTs);

  if (today.length) groups.push({ label: 'Today', items: today });
  if (yesterday.length) groups.push({ label: 'Yesterday', items: yesterday });
  if (week.length) groups.push({ label: 'This Week', items: week });
  if (older.length) groups.push({ label: 'Older', items: older });

  return groups;
}

export default function LeftPanel({
  sessions, activeSessionId, pinnedIds, onSelect, onNew, onDelete, onClearAll, onTogglePin, onFileSelect, searchQuery,
}: LeftPanelProps) {
  const [tab, setTab] = useState<TabKey>('sessions');
  const [searchLocal, setSearchLocal] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [loadingTree, setLoadingTree] = useState(false);
  const [models, setModels] = useState<any[]>([]);
  const [router, setRouter] = useState<Record<string, string>>({});

  // Load models on mount
  useEffect(() => {
    fetchModels().then(d => setModels(d.data || [])).catch(() => {});
    fetchRouter().then(d => setRouter(d.router || {})).catch(() => {});
  }, []);

  // Filter sessions
  const query = searchLocal || searchQuery;
  const filtered = useMemo(() => {
    if (!query) return sessions;
    const q = query.toLowerCase();
    return sessions.filter(s =>
      (s.title || '').toLowerCase().includes(q) ||
      s.type.includes(q) ||
      (s.project_path || '').toLowerCase().includes(q)
    );
  }, [sessions, query]);

  const grouped = useMemo(() => groupSessions(filtered, pinnedIds), [filtered, pinnedIds]);

  // Load file tree
  const loadTree = async () => {
    if (!projectPath.trim()) return;
    setLoadingTree(true);
    try {
      const data = await fetchFileTree(projectPath.trim());
      setFileTree(data.tree || []);
    } catch {
      setFileTree([]);
    }
    setLoadingTree(false);
  };

  // Handle file click — fetch and show content
  const handleFileClick = async (node: FileNode) => {
    if (node.is_dir) return; // Directories toggle open in tree
    try {
      const data = await readFile(node.path);
      onFileSelect?.(node.path, data.content || '');
    } catch { /* ignore */ }
  };

  // Find which roles use each model
  const roleForModel = (modelName: string) => {
    return Object.entries(router)
      .filter(([_, m]) => m === modelName)
      .map(([role]) => role);
  };

  return (
    <div className="left-panel" id="left-panel">
      {/* Tabs */}
      <div className="lp-tabs">
        {(['sessions', 'files', 'models'] as TabKey[]).map(t => (
          <button
            key={t}
            className={`lp-tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
            id={`lp-tab-${t}`}
            aria-label={`${t} tab`}
          >
            {t === 'sessions' ? '📋' : t === 'files' ? '📂' : '🤖'} {t}
          </button>
        ))}
      </div>

      {/* ─── Sessions Tab ────────────────────── */}
      {tab === 'sessions' && (
        <>
          <div className="lp-header">
            <input
              className="lp-search"
              placeholder="Search sessions..."
              value={searchLocal}
              onChange={e => setSearchLocal(e.target.value)}
              aria-label="Search sessions"
              id="session-search"
            />
            <button className="new-btn" onClick={onNew} id="new-session-btn">✨ New</button>
          </div>

          <div className="session-scroller" id="session-list">
            {grouped.length === 0 && (
              <div style={{ textAlign: 'center', padding: '28px 12px', color: 'var(--text-4)', fontSize: 12 }}>
                {query ? 'No matching sessions' : 'No sessions yet'}
              </div>
            )}
            {grouped.map(group => (
              <div className="date-group" key={group.label}>
                <div className="date-label">{group.label}</div>
                {group.items.map(s => (
                  <div
                    key={s.id}
                    className={`s-card ${s.id === activeSessionId ? 'active' : ''} ${pinnedIds.has(s.id) ? 'pinned' : ''}`}
                    onClick={() => onSelect(s.id)}
                    onContextMenu={e => { e.preventDefault(); onTogglePin(s.id); }}
                    title="Right-click to pin/unpin"
                    id={`session-${s.id}`}
                  >
                    <span className="s-icon">{getSessionIcon(s.type)}</span>
                    <div className="s-body">
                      <div className="s-title">{truncate(s.title || 'Untitled', 28)}</div>
                      <div className="s-meta">
                        <span>{formatTimestamp(s.created_at)}</span>
                        {s.file_count > 0 && <span className="files">📄 {s.file_count}</span>}
                        {s.token_usage?.total_tokens ? (
                          <span className="tokens">{s.token_usage.total_tokens.toLocaleString()} tok</span>
                        ) : null}
                      </div>
                    </div>
                    <button className="s-del" onClick={e => { e.stopPropagation(); onDelete(s.id); }} aria-label="Delete session">✕</button>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {sessions.length > 0 && (
            <div className="lp-footer">
              <button className="btn btn--danger btn--sm" style={{ width: '100%', justifyContent: 'center' }}
                onClick={onClearAll} id="clear-all-btn">🗑 Clear All Sessions</button>
            </div>
          )}
        </>
      )}

      {/* ─── Files Tab ────────────────────────── */}
      {tab === 'files' && (
        <>
          <div className="lp-header" style={{ flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', gap: 6, width: '100%' }}>
              <input
                className="lp-search"
                placeholder="Paste project path..."
                value={projectPath}
                onChange={e => setProjectPath(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') loadTree(); }}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}
                id="file-path-input"
              />
              <button className="new-btn" onClick={loadTree} disabled={loadingTree}>
                {loadingTree ? '...' : '📂'}
              </button>
            </div>
          </div>
          <div className="fe-tree" id="file-tree">
            {fileTree.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '28px 12px', color: 'var(--text-4)', fontSize: 12 }}>
                Enter a path and press Enter to browse files
              </div>
            ) : (
              <FileTreeView nodes={fileTree} depth={0} onFileClick={handleFileClick} />
            )}
          </div>
        </>
      )}

      {/* ─── Models Tab ───────────────────────── */}
      {tab === 'models' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }} id="model-roster">
          {models.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '28px 12px', color: 'var(--text-4)', fontSize: 12 }}>
              No models found. Is Ollama running?
            </div>
          ) : (
            models.map((m: any) => {
              const roles = roleForModel(m.id);
              return (
                <div className="mr-card" key={m.id}>
                  <div className="mr-head">
                    <span className="mr-name">{m.id}</span>
                  </div>
                  <div className="mr-meta">
                    <span>Local · Ollama</span>
                  </div>
                  {roles.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      {roles.map(r => <span className="mr-role" key={r}>{r}</span>)}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ─── File Tree Renderer ──────────────────────────────────────────
function FileTreeView({ nodes, depth, onFileClick }: { nodes: FileNode[]; depth: number; onFileClick: (n: FileNode) => void }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  return (
    <>
      {nodes.map(node => (
        <div key={node.path}>
          <div
            className="fe-node"
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => node.is_dir ? toggle(node.path) : onFileClick(node)}
          >
            <span className="fe-icon">
              {node.is_dir ? (expanded.has(node.path) ? '📂' : '📁') :
                node.name.endsWith('.py') ? '🐍' :
                  node.name.endsWith('.ts') || node.name.endsWith('.tsx') ? '💠' :
                    node.name.endsWith('.js') || node.name.endsWith('.jsx') ? '🟨' :
                      node.name.endsWith('.css') ? '🎨' :
                        node.name.endsWith('.json') ? '📋' :
                          node.name.endsWith('.md') ? '📝' : '📄'}
            </span>
            <span className="fe-name">{node.name}</span>
            {!node.is_dir && node.size !== undefined && (
              <span className="fe-size">{formatBytes(node.size)}</span>
            )}
          </div>
          {node.is_dir && expanded.has(node.path) && node.children && (
            <FileTreeView nodes={node.children} depth={depth + 1} onFileClick={onFileClick} />
          )}
        </div>
      ))}
    </>
  );
}
