'use client';
import { useState, useEffect, useMemo, useCallback } from 'react';
import {
   GitBranch,
   GitCommit,
   RotateCcw,
   Check,
   Plus,
   Minus,
   AlertTriangle,
   Search,
   ArrowUpDown,
   Copy,
   CircleDashed,
   Link,
} from 'lucide-react';
import { toast } from 'sonner';
import {
   fetchGitStatus,
   commitGit,
   stageGitFile,
   stageAllGit,
   unstageGitFile,
   unstageAllGit,
   discardGitFile,
   checkoutGitRef,
   pullGit,
   pushGit,
} from '../lib/api';
import GitVisualizer from './GitVisualizer';

type ChangeFilter = 'all' | 'staged' | 'modified' | 'untracked' | 'conflict';
type HistoryFilter = 'all' | 'merge' | 'regular';
type HistorySort = 'newest' | 'oldest';

interface GitChange {
   path: string;
   staged_status: string;
   unstaged_status: string;
   status: 'staged' | 'modified' | 'untracked' | 'conflict' | 'staged+modified' | string;
}

interface GitCommitItem {
   hash: string;
   msg: string;
   date: string;
   author?: string;
   refs?: string;
   parents?: string[];
   is_merge?: boolean;
   graph?: string;
}

interface GitStatus {
  branch: string;
   upstream?: string | null;
   ahead?: number;
   behind?: number;
   detached?: boolean;
   repo_root?: string;
   local_branches?: string[];
   remote_branches?: string[];
  modified: string[];
  staged: string[];
   untracked?: string[];
   conflicts?: string[];
   changes?: GitChange[];
   counts?: {
      staged: number;
      modified: number;
      untracked: number;
      conflicts: number;
      total: number;
   };
   recent_commits: GitCommitItem[];
   last_updated?: number;
}

interface GitDashboardProps {
   globalSearchQuery?: string;
}

export default function GitDashboard({ globalSearchQuery = '' }: GitDashboardProps) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
   const [repoPath, setRepoPath] = useState('');
   const [draftRepoPath, setDraftRepoPath] = useState('');
   const [checkoutTarget, setCheckoutTarget] = useState('');
   const [changeFilter, setChangeFilter] = useState<ChangeFilter>('all');
   const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
   const [historySort, setHistorySort] = useState<HistorySort>('newest');
   const [historySearch, setHistorySearch] = useState('');
   const [historyLimit, setHistoryLimit] = useState(10);
   const [showGraph, setShowGraph] = useState(false);
   const [showVisualizer, setShowVisualizer] = useState(false);
   const [showRefBadges, setShowRefBadges] = useState(false);
   const [commitMessage, setCommitMessage] = useState('');
   const [actionBusy, setActionBusy] = useState<string | null>(null);

   const errMessage = (err: unknown, fallback: string) => {
      if (err instanceof Error && err.message) return err.message;
      return fallback;
   };

   useEffect(() => {
      if (typeof window !== 'undefined') {
         const p = localStorage.getItem('cortex-last-path') || 'F:/Cortex';
         setRepoPath(p);
         setDraftRepoPath(p);
      }
   }, []);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
         if (!repoPath) return;
         const data = await fetchGitStatus(repoPath);
         if (!data || data.detail) {
            throw new Error(data?.detail || 'Unable to read repository status');
         }
         setStatus(data);
         setCheckoutTarget((prev) => prev || data.branch || '');
      } catch (err) {
         toast.error('Failed to sync Git status', { description: errMessage(err, 'Unknown git error') });
      }
    setLoading(false);
  }, [repoPath]);

   useEffect(() => {
      if (repoPath) void fetchStatus();
   }, [repoPath, fetchStatus]);

   useEffect(() => {
      if (status?.branch) {
         setCheckoutTarget(status.branch);
      }
   }, [status?.branch]);

   useEffect(() => {
      const q = (globalSearchQuery || '').trim();
      setHistorySearch(q);
   }, [globalSearchQuery]);

   const applyRepoPath = () => {
      const next = draftRepoPath.trim();
      if (!next) return;
      setRepoPath(next);
      if (typeof window !== 'undefined') {
         localStorage.setItem('cortex-last-path', next);
      }
   };

   const runGitAction = async (label: string, action: () => Promise<Record<string, unknown>>, success: string) => {
      setActionBusy(label);
      try {
         const response = await action();
         if (response?.detail) {
            throw new Error(String(response.detail));
         }
         toast.success(success);
         await fetchStatus();
      } catch (err) {
         toast.error(label, { description: errMessage(err, 'Git action failed') });
      } finally {
         setActionBusy(null);
      }
   };

   const copyHash = async (hash: string) => {
      try {
         await navigator.clipboard.writeText(hash);
         toast.success('Commit hash copied');
      } catch {
         toast.error('Copy failed');
      }
   };

   const handleCommit = async (commitAll: boolean) => {
      const message = commitMessage.trim();
      if (!repoPath) return;
      if (!message) {
         toast.warning('Commit message is required');
         return;
      }

      const label = commitAll ? 'Commit all' : 'Commit staged';
      await runGitAction(
         label,
         () => commitGit(repoPath, message, commitAll),
         commitAll ? 'Committed all changes' : 'Committed staged changes'
      );
      setCommitMessage('');
   };

   const allChanges = useMemo<GitChange[]>(() => {
      if (!status) return [];
      if (status.changes?.length) return status.changes;

      const out: GitChange[] = [];
      for (const path of status.staged || []) {
         out.push({ path, staged_status: 'M', unstaged_status: ' ', status: 'staged' });
      }
      for (const path of status.modified || []) {
         const existing = out.find((c) => c.path === path);
         if (existing) {
            existing.unstaged_status = 'M';
            existing.status = 'staged+modified';
         } else {
            out.push({ path, staged_status: ' ', unstaged_status: 'M', status: 'modified' });
         }
      }
      for (const path of status.untracked || []) {
         if (!out.some((c) => c.path === path)) {
            out.push({ path, staged_status: '?', unstaged_status: '?', status: 'untracked' });
         }
      }
      for (const path of status.conflicts || []) {
         const existing = out.find((c) => c.path === path);
         if (existing) {
            existing.status = 'conflict';
         } else {
            out.push({ path, staged_status: 'U', unstaged_status: 'U', status: 'conflict' });
         }
      }
      return out;
   }, [status]);

   const filteredChanges = useMemo(() => {
      if (changeFilter === 'all') return allChanges;
      return allChanges.filter((c) => {
         if (changeFilter === 'conflict') return c.status === 'conflict';
         if (changeFilter === 'untracked') return c.status === 'untracked';
         if (changeFilter === 'staged') return c.status === 'staged' || c.status === 'staged+modified';
         if (changeFilter === 'modified') return c.status === 'modified' || c.status === 'staged+modified';
         return true;
      });
   }, [allChanges, changeFilter]);

   const stagedChanges = useMemo(
      () => filteredChanges.filter((c) => c.staged_status !== ' ' && c.staged_status !== '?'),
      [filteredChanges]
   );

   const unstagedChanges = useMemo(
      () => filteredChanges.filter((c) => c.unstaged_status !== ' ' || c.status === 'untracked' || c.status === 'conflict'),
      [filteredChanges]
   );

   const visibleCommits = useMemo(() => {
      if (!status?.recent_commits?.length) return [];
      const needle = historySearch.trim().toLowerCase();
      let commits = status.recent_commits.filter((c) => {
         if (historyFilter === 'merge' && !c.is_merge) return false;
         if (historyFilter === 'regular' && c.is_merge) return false;
         if (!needle) return true;
         return [c.hash, c.msg, c.author || '', c.refs || '']
            .join(' ')
            .toLowerCase()
            .includes(needle);
      });

      if (historySort === 'oldest') {
         commits = [...commits].reverse();
      }
      return commits.slice(0, historyLimit);
   }, [status, historySearch, historyFilter, historySort, historyLimit]);

   const changeCounts = status?.counts || {
      staged: status?.staged?.length || 0,
      modified: status?.modified?.length || 0,
      untracked: status?.untracked?.length || 0,
      conflicts: status?.conflicts?.length || 0,
      total: allChanges.length,
   };

   const refsToBadges = (refs?: string) => {
      if (!refs) return [];
      return refs
         .replace(/[()]/g, '')
         .split(',')
         .map((r) => r.trim())
         .filter(Boolean);
   };

   const localBranches = status?.local_branches || [];

  return (
    <div className="git-sidebar">
         <div className="git-head git-head--detailed">
            <div className="git-head-top">
               <div className="git-branch-block">
                  <GitBranch size={16} />
                  <span className="git-branch-name">{status?.branch || '...'}</span>
                  {status?.upstream && (
                     <span className="git-branch-upstream"><Link size={10} /> {status.upstream}</span>
                  )}
               </div>
               <button className="icon-btn" onClick={fetchStatus} title="Refresh" disabled={loading}>
                  <RotateCcw size={14} className={loading ? 'spin' : ''} />
               </button>
            </div>

            <div className="git-branch-metrics">
               <span className="git-chip">Ahead {status?.ahead || 0}</span>
               <span className="git-chip">Behind {status?.behind || 0}</span>
               {status?.repo_root && <span className="git-chip git-chip--path" title={status.repo_root}>{status.repo_root}</span>}
            </div>

            <div className="git-toolbar">
               <button
                  className="btn btn--sm"
                  disabled={!!actionBusy || !repoPath}
                  onClick={() => runGitAction('Pull', () => pullGit(repoPath), 'Pulled latest changes')}
               >
                  Pull
               </button>
               <button
                  className="btn btn--sm"
                  disabled={!!actionBusy || !repoPath}
                  onClick={() => runGitAction('Push', () => pushGit(repoPath), 'Pushed to remote')}
               >
                  Push
               </button>
               <select className="git-select" value={checkoutTarget} onChange={(e) => setCheckoutTarget(e.target.value)}>
                  {localBranches.length === 0 && <option value="">No branches</option>}
                  {localBranches.map((b) => (
                     <option key={b} value={b}>{b}</option>
                  ))}
               </select>
               <button
                  className="btn btn--sm"
                  disabled={!!actionBusy || !checkoutTarget || checkoutTarget === status?.branch}
                  onClick={() => runGitAction('Checkout', () => checkoutGitRef(repoPath, checkoutTarget), `Checked out ${checkoutTarget}`)}
               >
                  Checkout
               </button>
            </div>

            <div className="git-path-controls">
               <input
                  className="git-path-input"
                  value={draftRepoPath}
                  onChange={(e) => setDraftRepoPath(e.target.value)}
                  onKeyDown={(e) => {
                     if (e.key === 'Enter') applyRepoPath();
                  }}
                  placeholder="Repository path"
               />
               <button className="btn btn--sm" onClick={applyRepoPath}>Apply</button>
            </div>
      </div>

         <div className="git-section git-section--dense">
            <div className="git-label">Working Tree</div>
            <div className="git-change-filters">
               <button className={`git-filter ${changeFilter === 'all' ? 'active' : ''}`} onClick={() => setChangeFilter('all')}>All {changeCounts.total}</button>
               <button className={`git-filter ${changeFilter === 'staged' ? 'active' : ''}`} onClick={() => setChangeFilter('staged')}>Staged {changeCounts.staged}</button>
               <button className={`git-filter ${changeFilter === 'modified' ? 'active' : ''}`} onClick={() => setChangeFilter('modified')}>Modified {changeCounts.modified}</button>
               <button className={`git-filter ${changeFilter === 'untracked' ? 'active' : ''}`} onClick={() => setChangeFilter('untracked')}>Untracked {changeCounts.untracked}</button>
               <button className={`git-filter ${changeFilter === 'conflict' ? 'active' : ''}`} onClick={() => setChangeFilter('conflict')}>Conflicts {changeCounts.conflicts}</button>
            </div>

            <div className="git-change-section-head">
               <span>Changes ({unstagedChanges.length})</span>
               <button
                  className="git-mini-btn"
                  disabled={!!actionBusy || !repoPath || unstagedChanges.length === 0}
                  onClick={() => runGitAction('Stage all', () => stageAllGit(repoPath), 'Staged all changes')}
               >
                  Stage All
               </button>
            </div>
            <div className="git-change-list">
               {unstagedChanges.length === 0 && <div className="git-empty">No unstaged changes</div>}
               {unstagedChanges.map((change) => (
                  <div key={`unstaged:${change.path}:${change.staged_status}${change.unstaged_status}`} className="git-item">
                     {change.status === 'conflict' ? (
                        <AlertTriangle size={12} className="icon-red" />
                     ) : change.status === 'untracked' ? (
                        <Plus size={12} className="icon-blue" />
                     ) : (
                        <Minus size={12} className="icon-red" />
                     )}
                     <span className="git-file">{change.path}</span>
                     <span className="git-status-code">{change.staged_status}{change.unstaged_status}</span>
                     <div className="git-row-actions">
                        <button
                           className="git-mini-btn"
                           disabled={!!actionBusy || !repoPath}
                           onClick={() => runGitAction('Stage file', () => stageGitFile(repoPath, change.path), `Staged ${change.path}`)}
                        >
                           Stage
                        </button>
                        <button
                           className="git-mini-btn git-mini-btn--danger"
                           disabled={!!actionBusy || !repoPath}
                           onClick={() => {
                              if (!confirm(`Discard local changes for ${change.path}?`)) return;
                              runGitAction('Discard file', () => discardGitFile(repoPath, change.path), `Discarded ${change.path}`);
                           }}
                        >
                           Discard
                        </button>
                     </div>
                  </div>
               ))}
            </div>

            {stagedChanges.length > 0 ? (
               <>
                  <div className="git-change-section-head" style={{ marginTop: 8 }}>
                     <span>Staged Changes ({stagedChanges.length})</span>
                     <button
                        className="git-mini-btn"
                        disabled={!!actionBusy || !repoPath}
                        onClick={() => runGitAction('Unstage all', () => unstageAllGit(repoPath), 'Unstaged all changes')}
                     >
                        Unstage All
                     </button>
                  </div>
                  <div className="git-change-list">
                     {stagedChanges.map((change) => (
                        <div key={`staged:${change.path}:${change.staged_status}${change.unstaged_status}`} className="git-item">
                           <Check size={12} className="icon-green" />
                           <span className="git-file">{change.path}</span>
                           <span className="git-status-code">{change.staged_status}{change.unstaged_status}</span>
                           <div className="git-row-actions">
                              <button
                                 className="git-mini-btn"
                                 disabled={!!actionBusy || !repoPath}
                                 onClick={() => runGitAction('Unstage file', () => unstageGitFile(repoPath, change.path), `Unstaged ${change.path}`)}
                              >
                                 Unstage
                              </button>
                           </div>
                        </div>
                     ))}
                  </div>
               </>
            ) : (
               <div className="git-empty git-empty--inline">No staged changes</div>
            )}
      </div>

         <div className="git-section git-section--dense git-history-section">
            <div className="git-label">History</div>

            <div className="git-history-controls">
               <label className="git-search-wrap">
                  <Search size={12} />
                  <input
                     value={historySearch}
                     onChange={(e) => setHistorySearch(e.target.value)}
                     placeholder="Search commits"
                  />
               </label>

               <div className="git-history-controls-row">
                  <select className="git-select" value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value as HistoryFilter)}>
                     <option value="all">All</option>
                     <option value="merge">Merges</option>
                     <option value="regular">Regular</option>
                  </select>

                  <select className="git-select" value={historyLimit} onChange={(e) => setHistoryLimit(Number(e.target.value) || 10)}>
                     <option value={10}>10</option>
                     <option value={20}>20</option>
                     <option value={40}>40</option>
                  </select>

                  <button className="btn btn--sm" onClick={() => setHistorySort((s) => (s === 'newest' ? 'oldest' : 'newest'))}>
                     <ArrowUpDown size={12} /> {historySort === 'newest' ? 'Newest' : 'Oldest'}
                  </button>

                  <button className={`btn btn--sm ${showGraph ? '' : 'btn--secondary'}`} onClick={() => setShowGraph((v) => !v)}>
                     <CircleDashed size={12} /> {showGraph ? 'Graph' : 'No Graph'}
                  </button>

                  <button className={`btn btn--sm ${showRefBadges ? '' : 'btn--secondary'}`} onClick={() => setShowRefBadges((v) => !v)}>
                     {showRefBadges ? 'Refs On' : 'Refs Off'}
                  </button>

                  <button className={`btn btn--sm ${showVisualizer ? '' : 'btn--secondary'}`} onClick={() => setShowVisualizer((v) => !v)}>
                     <GitBranch size={12} /> {showVisualizer ? 'Visualizer On' : 'Visualizer Off'}
                  </button>
               </div>
            </div>

            {showVisualizer && <GitVisualizer repoPath={repoPath} limit={Math.max(40, historyLimit * 4)} />}

            <div className={`git-history-list ${showGraph ? 'git-history-list--graph' : ''}`}>
               {visibleCommits.length === 0 && <div className="git-empty">No commits in this filter</div>}

               {visibleCommits.map((c, idx) => {
                  const badges = refsToBadges(c.refs);
                  const headBadge = badges.find((b) => b.includes('HEAD ->'));
                  return (
                     <div key={`${c.hash}-${idx}`} className="git-commit-row">
                        {showGraph && (
                           <div className="git-graph-lane" aria-hidden="true">
                              <span className={`git-graph-dot ${c.is_merge ? 'is-merge' : ''} ${headBadge ? 'is-head' : ''}`} />
                              {idx < visibleCommits.length - 1 && <span className="git-graph-line" />}
                              {c.graph && c.graph.replace(/[\s|]/g, '') && <span className="git-graph-ascii">{c.graph}</span>}
                           </div>
                        )}

                        <div className="git-commit">
                           <div className="git-commit-top">
                              <div className="git-commit-main">
                                 <GitCommit size={12} />
                                 <button className="commit-hash commit-hash-btn" onClick={() => copyHash(c.hash)} title="Copy hash">
                                    {c.hash}
                                    <Copy size={10} />
                                 </button>
                                 <span className="commit-time">{c.date || 'recent'}</span>
                              </div>
                              {c.author && <span className="commit-author">{c.author}</span>}
                           </div>

                           <div className="commit-msg">{c.msg}</div>

                           {showRefBadges && badges.length > 0 && (
                              <div className="git-ref-list">
                                 {badges.slice(0, 2).map((b) => (
                                    <button
                                       key={b}
                                       className={`git-ref-badge ${b.includes('HEAD ->') ? 'is-head' : ''}`}
                                       onClick={() => {
                                          const branchCandidate = b.includes('HEAD ->') ? b.split('HEAD ->').pop()?.trim() : b;
                                          if (branchCandidate && localBranches.includes(branchCandidate)) {
                                             setCheckoutTarget(branchCandidate);
                                          }
                                       }}
                                    >
                                       {b}
                                    </button>
                                 ))}
                              </div>
                           )}
                        </div>
                     </div>
                  );
               })}
            </div>
      </div>

         <div className="git-actions">
            <div className="git-commit-input-row">
               <input
                  className="git-path-input"
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder="Commit message"
               />
            </div>
            <div className="git-toolbar">
               <button className="btn btn--sm" disabled={!!actionBusy || !commitMessage.trim()} onClick={() => handleCommit(false)}>
                  <Check size={14} /> Commit Staged
               </button>
               <button className="btn btn--primary btn--sm" disabled={!!actionBusy || !commitMessage.trim()} onClick={() => handleCommit(true)}>
                  <Check size={14} /> Commit All
               </button>
            </div>
            <div className="git-actions-note">Like VS Code Source Control: stage/unstage/discard files, then commit staged or commit all.</div>
      </div>
    </div>
  );
}
