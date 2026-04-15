'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, GitCommit, RefreshCw } from 'lucide-react';
import { fetchGitVisualizer } from '../lib/api';
import { GitVisualizerPayload, GitVisualizerNode } from '../lib/types';

interface GitVisualizerProps {
  repoPath: string;
  limit?: number;
}

export default function GitVisualizer({ repoPath, limit = 80 }: GitVisualizerProps) {
  const [data, setData] = useState<GitVisualizerPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const path = (repoPath || '').trim();
    if (!path) return;

    setLoading(true);
    setError('');
    try {
      const resp = await fetchGitVisualizer(path, limit);
      if (resp?.detail) {
        throw new Error(typeof resp.detail === 'string' ? resp.detail : 'Failed to load git graph');
      }
      setData(resp as GitVisualizerPayload);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load git visualizer';
      setError(message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [repoPath, limit]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const lanes = useMemo(() => {
    const base = data?.lanes || 1;
    return Math.max(1, Math.min(base, 10));
  }, [data?.lanes]);

  const rows: GitVisualizerNode[] = data?.nodes || [];

  return (
    <div className="gitviz-shell">
      <div className="gitviz-head">
        <div className="gitviz-title">
          <GitBranch size={14} />
          <span className="gitviz-title-text">Git Visualizer</span>
        </div>
        <button className="git-mini-btn" onClick={refresh} disabled={loading || !repoPath}>
          <RefreshCw size={12} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      </div>

      {(data?.branch || data?.count) ? (
        <div className="gitviz-subhead">
          {data?.branch ? <span className="gitviz-branch" title={data.branch}>{data.branch}</span> : null}
          <span>{data?.count || 0} commits</span>
          <span>{lanes} lane{lanes > 1 ? 's' : ''}</span>
        </div>
      ) : null}

      {error ? <div className="gitviz-error">{error}</div> : null}
      {!error && rows.length === 0 ? <div className="gitviz-empty">No commits available for visualization.</div> : null}

      {!error && rows.length > 0 ? (
        <div className="gitviz-list">
          {rows.map((node, idx) => {
            const laneWidth = 14;
            const railWidth = lanes * laneWidth;
            const dotLeft = Math.min(node.lane, lanes - 1) * laneWidth + 2;

            return (
              <div key={`${node.hash}-${idx}`} className="gitviz-row">
                <div className="gitviz-rails" style={{ width: railWidth }} aria-hidden="true">
                  {Array.from({ length: lanes }).map((_, laneIdx) => (
                    <span
                      key={`${node.hash}-${laneIdx}`}
                      className={`gitviz-rail ${laneIdx === node.lane ? 'active' : ''}`}
                      style={{ left: laneIdx * laneWidth + 6 }}
                    />
                  ))}
                  <span
                    className={`gitviz-dot ${node.is_head ? 'is-head' : ''} ${node.is_merge ? 'is-merge' : ''}`}
                    style={{ left: dotLeft }}
                  />
                </div>

                <div className="gitviz-meta">
                  <div className="gitviz-topline">
                    <GitCommit size={12} />
                    <span className="gitviz-hash">{node.hash}</span>
                    <span className="gitviz-date">{node.date}</span>
                  </div>
                  {node.refs?.length ? (
                    <div className="gitviz-refs">
                      {node.refs.slice(0, 3).map((ref) => (
                        <span key={`${node.hash}-${ref}`} className="gitviz-ref">{ref}</span>
                      ))}
                    </div>
                  ) : null}
                  <div className="gitviz-message">{node.message}</div>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
