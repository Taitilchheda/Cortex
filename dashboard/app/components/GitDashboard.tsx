'use client';
import { useState, useEffect } from 'react';
import { GitBranch, GitCommit, GitPullRequest, RotateCcw, Check, Plus, Minus } from 'lucide-react';
import { toast } from 'sonner';

interface GitStatus {
  branch: string;
  modified: string[];
  staged: string[];
  recent_commits: { hash: string; msg: string; date: string }[];
}

export default function GitDashboard() {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      // Mock for now, but in a real app this would call /git/status
      const mock: GitStatus = {
        branch: 'main',
        modified: ['server/orchestrator.py', 'dashboard/page.tsx'],
        staged: ['server/api/memory.py'],
        recent_commits: [
          { hash: 'a1b2c3d', msg: 'Integrated long-term memory system', date: '2m ago' },
          { hash: 'e4f5g6h', msg: 'Added multi-file editor tabs', date: '15m ago' },
        ],
      };
      setStatus(mock);
    } catch { toast.error('Failed to sync Git status'); }
    setLoading(false);
  };

  useEffect(() => { fetchStatus(); }, []);

  return (
    <div className="git-sidebar">
      <div className="git-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px' }}>
         <div style={{ display: 'flex', alignItems: 'center', gap: 6, opacity: 0.8 }}>
            <GitBranch size={16} />
            <span style={{ fontSize: 13, fontWeight: 700 }}>{status?.branch || '...'}</span>
         </div>
         <button className="icon-btn" onClick={fetchStatus} title="Sync Repository">
            <RotateCcw size={14} className={loading ? 'spin' : ''} />
         </button>
      </div>

      <div className="git-section">
         <div className="git-label">Changes</div>
         {status?.modified.length === 0 && <div className="git-empty">No uncommitted changes</div>}
         {status?.modified.map(f => (
           <div key={f} className="git-item">
              <Minus size={12} className="icon-red" />
              <span className="git-file">{f}</span>
           </div>
         ))}
      </div>

      <div className="git-section">
         <div className="git-label">Staged</div>
         {status?.staged.length === 0 && <div className="git-empty">No staged changes</div>}
         {status?.staged.map(f => (
           <div key={f} className="git-item">
              <Plus size={12} className="icon-green" />
              <span className="git-file">{f}</span>
           </div>
         ))}
      </div>

      <div className="git-section">
         <div className="git-label">Recent Commits</div>
         {status?.recent_commits.map(c => (
           <div key={c.hash} className="git-commit">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                 <GitCommit size={12} />
                 <span className="commit-hash">{c.hash}</span>
                 <span className="commit-time">{c.date}</span>
              </div>
              <div className="commit-msg">{c.msg}</div>
           </div>
         ))}
      </div>

      <div style={{ padding: 14 }}>
         <button className="btn btn--primary" style={{ width: '100%', borderRadius: 6 }} onClick={() => toast.info('Commit functionality coming soon')}>
            <Check size={14} /> Commit All (WIP)
         </button>
      </div>
    </div>
  );
}
