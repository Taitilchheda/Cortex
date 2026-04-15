'use client';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Session, FileNode } from '../lib/types';
import { fetchFileTree, readFile, searchSessions } from '../lib/api';
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
  FolderOpen,
  MessageSquare,
  Zap,
  Hammer,
  Search,
  MoreVertical,
  X,
  GitBranch,
  RefreshCw
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
  const [remoteSearchSessions, setRemoteSearchSessions] = useState<Session[] | null>(null);
  const [fileTree, setFileTree] = useState<FileNode[]>([]);
  const [fileExpanded, setFileExpanded] = useState<Set<string>>(new Set());
  const [fileFilter, setFileFilter] = useState('');
  const [fileRoot, setFileRoot] = useState('.');
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [fileStats, setFileStats] = useState({ dirs: 0, files: 0 });
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [router, setRouter] = useState<Record<string, string>>({});
  const [contextMenu, setContextMenu] = useState<{ type: 'session' | 'file'; id?: string; node?: FileNode; x: number; y: number } | null>(null);

  const isSearching = !!searchQuery || !!searchLocal;
  const filteredSessions = useMemo(() => {
    if (remoteSearchSessions) return remoteSearchSessions;
    const q = (searchQuery || searchLocal).toLowerCase();
    if (!q) return sessions;
    return sessions.filter(s => 
      s.title?.toLowerCase().includes(q) || 
      s.type?.toLowerCase().includes(q)
    );
  }, [sessions, searchQuery, searchLocal, remoteSearchSessions]);

  useEffect(() => {
    const q = (searchQuery || searchLocal).trim();
    if (!q) {
      setRemoteSearchSessions(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await searchSessions(q);
        if (!cancelled) {
          setRemoteSearchSessions(data.sessions || []);
        }
      } catch {
        if (!cancelled) {
          setRemoteSearchSessions(null);
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, searchLocal]);

  const grouped = useMemo(() => groupSessions(filteredSessions, pinnedIds, isSearching), [filteredSessions, pinnedIds, isSearching]);

  const displayedTree = useMemo(() => {
    const query = fileFilter.trim().toLowerCase();
    if (!query) return fileTree;
    return filterTree(fileTree, query);
  }, [fileTree, fileFilter]);

  useEffect(() => {
    if (!fileFilter.trim()) return;
    setFileExpanded(new Set(collectDirPaths(displayedTree)));
  }, [fileFilter, displayedTree]);

  useEffect(() => {
    if (activeTab === 'files') {
      const root = typeof window !== 'undefined' ? localStorage.getItem('cortex-last-path') || '.' : '.';
      loadTree(root);
    }
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === 'files') {
      setFileFilter((searchQuery || '').trim());
    }
  }, [searchQuery, activeTab]);

  const loadTree = async (path: string) => {
    setIsLoadingTree(true);
    try {
      const resp = await fetchFileTree(path);
      const tree = sortTree(resp.tree || resp.files || []);
      setFileTree(tree);
      setFileRoot(path);
      setFileStats(computeTreeStats(tree));
      const topDirs = new Set<string>();
      for (const node of tree) {
        if (node.is_dir) topDirs.add(node.path);
      }
      setFileExpanded(topDirs);
    } catch {
      setFileTree([]);
      setFileStats({ dirs: 0, files: 0 });
    } finally {
      setIsLoadingTree(false);
    }
  };

  const toggleDir = (path: string) => {
    setFileExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const expandAllDirs = () => {
    setFileExpanded(new Set(collectDirPaths(displayedTree)));
  };

  const collapseAllDirs = () => {
    setFileExpanded(new Set());
  };

  const handleFileClick = async (node: FileNode) => {
    if (node.is_dir) return;
    setSelectedFilePath(node.path);
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
            <div className="sidebar-head sidebar-head--files">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Files size={14} />
                <span className="sidebar-title">Project Files</span>
                <span className="files-count-pill">{fileStats.files}</span>
              </div>
              <div className="files-head-actions">
                <button className="files-head-btn" onClick={() => loadTree(fileRoot)} title="Refresh tree" aria-label="Refresh tree">
                  <RefreshCw size={12} className={isLoadingTree ? 'spin' : ''} />
                </button>
                <button className="files-head-btn" onClick={expandAllDirs} title="Expand all directories">Expand</button>
                <button className="files-head-btn" onClick={collapseAllDirs} title="Collapse all directories">Collapse</button>
              </div>
            </div>
            <div className="files-meta-row">
              <div className="files-meta" title={fileRoot}>
                {truncate(fileRoot || '.', 48)}
              </div>
              <div className="files-stats">{fileStats.dirs} dirs · {fileStats.files} files</div>
            </div>
            <div className="lp-search-box lp-search-box--files">
              <Search size={13} className="search-icon" />
              <input
                placeholder="Filter files..."
                value={fileFilter}
                onChange={e => setFileFilter(e.target.value)}
                autoComplete="off"
              />
              {fileFilter && (
                <button className="files-search-clear" onClick={() => setFileFilter('')}>
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="lp-scrollable files-scroll">
              {isLoadingTree ? (
                <div className="empty-state">Loading files...</div>
              ) : displayedTree.length === 0 ? (
                <div className="empty-state">No matching files</div>
              ) : (
                <FileTreeView 
                  nodes={displayedTree}
                  expanded={fileExpanded}
                  onToggleDir={toggleDir}
                  selectedPath={selectedFilePath}
                  onFileClick={handleFileClick}
                  onContextMenu={(e, node) => { e.preventDefault(); }}
                />
              )}
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
          <GitDashboard globalSearchQuery={searchQuery} />
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

function FileTreeView({
  nodes,
  depth = 0,
  expanded,
  onToggleDir,
  selectedPath,
  onFileClick,
  onContextMenu,
}: {
  nodes: FileNode[];
  depth?: number;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  selectedPath: string;
  onFileClick: (node: FileNode) => void;
  onContextMenu?: (e: React.MouseEvent, node: FileNode) => void;
}) {

  return (
    <div className="f-tree">
      {nodes.map((node) => {
        const ext = !node.is_dir && node.name.includes('.') ? node.name.split('.').pop() : '';
        const isExpanded = expanded.has(node.path);
        return (
        <div key={node.path} className="f-node">
          <div
            className={`f-row ${node.is_dir ? 'f-row--dir' : ''} ${selectedPath === node.path ? 'active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => node.is_dir ? onToggleDir(node.path) : onFileClick(node)}
            title={node.path}
            onContextMenu={(e) => onContextMenu?.(e, node)}
          >
            <span className={`f-chevron ${node.is_dir ? '' : 'is-placeholder'}`}>{node.is_dir ? (isExpanded ? <ChevronDown size={14}/> : <ChevronRight size={14}/>) : <ChevronRight size={14}/>}</span>
            <span className="f-icon">{node.is_dir ? (isExpanded ? <FolderOpen size={14}/> : <Folder size={14}/>) : <FileCode size={14}/>}</span>
            <span className="f-name">{node.name}</span>
            {!node.is_dir && ext && <span className="f-ext">{ext}</span>}
          </div>
          {node.is_dir && isExpanded && node.children && (
            <FileTreeView
              nodes={node.children}
              depth={depth + 1}
              expanded={expanded}
              onToggleDir={onToggleDir}
              selectedPath={selectedPath}
              onFileClick={onFileClick}
              onContextMenu={onContextMenu}
            />
          )}
        </div>
      )})}
    </div>
  );
}

function sortTree(nodes: FileNode[]): FileNode[] {
  const sorted = [...nodes].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return sorted.map(node =>
    node.is_dir && node.children?.length
      ? { ...node, children: sortTree(node.children) }
      : node
  );
}

function computeTreeStats(nodes: FileNode[]): { dirs: number; files: number } {
  let dirs = 0;
  let files = 0;
  for (const node of nodes) {
    if (node.is_dir) {
      dirs += 1;
      if (node.children?.length) {
        const nested = computeTreeStats(node.children);
        dirs += nested.dirs;
        files += nested.files;
      }
    } else {
      files += 1;
    }
  }
  return { dirs, files };
}

function collectDirPaths(nodes: FileNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.is_dir) {
      out.push(node.path);
      if (node.children?.length) {
        out.push(...collectDirPaths(node.children));
      }
    }
  }
  return out;
}

function filterTree(nodes: FileNode[], query: string): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    const nameMatch = node.name.toLowerCase().includes(query);
    if (node.is_dir) {
      const childMatches = node.children?.length ? filterTree(node.children, query) : [];
      if (nameMatch || childMatches.length > 0) {
        result.push({ ...node, children: childMatches });
      }
    } else if (nameMatch) {
      result.push(node);
    }
  }
  return result;
}
