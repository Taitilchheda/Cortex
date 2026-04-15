'use client';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Session, FileNode } from '../lib/types';
import { fetchFileTree, readFile, fetchModels, fetchRouter, searchSessions } from '../lib/api';
import { formatBytes, formatTimestamp, truncate } from '../lib/utils';
import { 
  History, 
  Files, 
  Cpu, 
  Plus, 
  Trash2, 
  Pin, 
  ChevronRight, 
  ChevronDown, 
  FileCode, 
  Folder,
  MessageSquare,
  Zap,
  Hammer,
  Search,
  MoreVertical,
  X,
  GitBranch
} from 'lucide-react';
import GitDashboard from './GitDashboard';

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
  activeTab?: 'sessions' | 'files' | 'agent' | 'git';
}

type TabKey = 'sessions' | 'files' | 'models' | 'agent' | 'git';

export default function Sidebar({
  sessions, activeSessionId, pinnedIds, onSelect, onNew, onDelete, 
  onClearAll, onTogglePin, onFileSelect, searchQuery, activeTab = 'sessions'
}: LeftPanelProps) {
  const [searchLocal, setSearchLocal] = useState('');
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [router, setRouter] = useState<Record<string, string>>({});
  const [contextMenu, setContextMenu] = useState<{ type: 'session' | 'file'; id?: string; node?: FileNode; x: number; y: number } | null>(null);

  const isSearching = !!searchQuery || !!searchLocal;
  const filteredSessions = useMemo(() => {
    const q = (searchQuery || searchLocal).toLowerCase();
    if (!q) return sessions;
    return sessions.filter(s => 
      s.title?.toLowerCase().includes(q) || 
      s.type?.toLowerCase().includes(q)
    );
  }, [sessions, searchQuery, searchLocal]);

  const grouped = useMemo(() => groupSessions(filteredSessions, pinnedIds, isSearching), [filteredSessions, pinnedIds, isSearching]);

  useEffect(() => {
    if (activeTab === 'files') {
      const root = typeof window !== 'undefined' ? localStorage.getItem('cortex-last-path') || '.' : '.';
      loadTree(root);
    }
  }, [activeTab]);

  const loadTree = async (path: string) => {
    try {
      const resp = await fetchFileTree(path);
      setFileTree(resp.files || []);
    } catch {
      setFileTree([]);
    }
  };

  const handleFileClick = async (node: FileNode) => {
    if (node.is_dir) return;
    try {
      const data = await readFile(node.path);
      onFileSelect?.(node.path, data.content || '');
    } catch { /* ignore */ }
  };

  const getSessIcon = (type: string) => {
    if (type === 'build') return <Zap size={14} className="icon-blue" />;
    if (type === 'refactor') return <Hammer size={14} className="icon-amber" />;
    return <MessageSquare size={14} className="icon-violet" />;
  };

  return (
    <div className="left-panel" id="left-panel">
      <div className="lp-container">
        {activeTab === 'sessions' && (
          <>
            <div className="lp-search-box">
              <Search size={14} className="search-icon" />
              <input
                placeholder="Search history..."
                value={searchLocal}
                onChange={e => setSearchLocal(e.target.value)}
                autoComplete="off"
              />
              {searchLocal && <button className="n-del" style={{ position: 'absolute', right: 28 }} onClick={() => setSearchLocal('')}><X size={12}/></button>}
            </div>

            <div className="lp-scrollable">
              {grouped.map(group => (
                <div className="nav-group" key={group.label}>
                  <div className="nav-label">{group.label}</div>
                  {group.items.map(s => (
                    <div
                      key={s.id}
                      className={`nav-item ${s.id === activeSessionId ? 'active' : ''}`}
                      onClick={() => onSelect(s.id)}
                    >
                      <span className="n-icon">{getSessIcon(s.type)}</span>
                      <div className="n-body">
                        <div className="n-title">{truncate(s.title || 'Untitled', 30)}</div>
                        <div style={{ fontSize: 9, opacity: 0.4, marginTop: 2 }}>{formatTimestamp(s.created_at)}</div>
                      </div>
                      {pinnedIds.has(s.id) && <Pin size={10} className="n-pin" />}
                      <button className="n-del" onClick={e => { e.stopPropagation(); onDelete(s.id); }}><Trash2 size={12} /></button>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

        {activeTab === 'files' && (
          <div className="sidebar-group">
            <div className="sidebar-head">
               <Files size={14} />
               <span className="sidebar-title">Project Files</span>
            </div>
            <div className="lp-scrollable">
               <FileTreeView 
                 nodes={fileTree} 
                 onFileClick={handleFileClick} 
                 onContextMenu={(e, node) => { e.preventDefault(); }} 
               />
            </div>
          </div>
        )}

        {activeTab === 'agent' && (
          <div className="sidebar-group">
            <div className="sidebar-head"><Cpu size={14}/><span className="sidebar-title">Agent Nodes</span></div>
            <div className="status-grid">
               <div className="status-card ok"><div className="status-val">Online</div><div className="status-lbl">Orchestrator</div></div>
               <div className="status-card ok"><div className="status-val">Available</div><div className="status-lbl">Code Review</div></div>
            </div>
          </div>
        )}

        {activeTab === 'git' && (
          <GitDashboard />
        )}
      </div>
    </div>
  );
}

function groupSessions(sessions: Session[], pinnedIds: Set<string>, isSearching: boolean) {
  if (isSearching) return [{ label: 'Search Results', items: sessions }];
  const groups: { label: string; items: Session[] }[] = [];
  const pinned = sessions.filter(s => pinnedIds.has(s.id));
  const unpinned = sessions.filter(s => !pinnedIds.has(s.id));
  if (pinned.length) groups.push({ label: 'Pinned', items: pinned });
  groups.push({ label: 'Recent', items: unpinned });
  return groups;
}

function FileTreeView({ nodes, depth = 0, onFileClick, onContextMenu }: any) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  return (
    <div className="f-tree">
      {nodes.map((node: any) => (
        <div key={node.path} className="f-node" style={{ paddingLeft: depth * 12 }}>
          <div className={`f-row ${node.is_dir ? 'f-row--dir' : ''}`} onClick={() => node.is_dir ? toggle(node.path) : onFileClick(node)}>
            <span className="f-chevron">{node.is_dir ? (expanded.has(node.path) ? <ChevronDown size={14}/> : <ChevronRight size={14}/>) : null}</span>
            <span className="f-icon">{node.is_dir ? <Folder size={14}/> : <FileCode size={14}/>}</span>
            <span className="f-name">{node.name}</span>
          </div>
          {node.is_dir && expanded.has(node.path) && node.children && (
            <FileTreeView nodes={node.children} depth={depth + 1} onFileClick={onFileClick} />
          )}
        </div>
      ))}
    </div>
  );
}
