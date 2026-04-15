'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Database, Search, RefreshCw } from 'lucide-react';
import { ragContext, ragIndexProject, ragStatus } from '../lib/api';
import { RagContextPayload, RagContextResult, RagStatusPayload } from '../lib/types';

interface RagContextEngineProps {
  activeFile?: { path: string; content: string } | null;
}

export default function RagContextEngine({ activeFile }: RagContextEngineProps) {
  const [projectPath, setProjectPath] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(8);
  const [indexCount, setIndexCount] = useState<number | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [error, setError] = useState('');
  const [payload, setPayload] = useState<RagContextPayload | null>(null);
  const [statusData, setStatusData] = useState<RagStatusPayload | null>(null);
  const [hint, setHint] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const remembered = localStorage.getItem('cortex-last-path') || '';
    if (remembered) {
      setProjectPath(remembered);
    }
  }, []);

  useEffect(() => {
    if (!activeFile?.path) return;
    const name = activeFile.path.split(/[\\/]/).pop() || activeFile.path;
    setQuery((prev) => (prev.trim() ? prev : `How is ${name} implemented?`));
  }, [activeFile?.path]);

  const statusLabel = useMemo(() => {
    if (indexCount === null) return 'Unknown';
    if (indexCount === 0) return 'Empty';
    return `${indexCount} files indexed`;
  }, [indexCount]);

  const progressPercent = useMemo(() => {
    const pct = Number(statusData?.progress_percent ?? 0);
    return Math.max(0, Math.min(Math.round(pct), 100));
  }, [statusData?.progress_percent]);

  const indexingActive = indexing || !!statusData?.is_indexing;

  const formatDuration = (seconds: number) => {
    const sec = Math.max(0, Math.round(seconds));
    const mins = Math.floor(sec / 60);
    const rem = sec % 60;
    if (mins <= 0) return `${rem}s`;
    return `${mins}m ${rem}s`;
  };

  const refreshStatus = useCallback(async (): Promise<RagStatusPayload | null> => {
    const path = projectPath.trim();
    if (!path) return null;
    setLoadingStatus(true);
    try {
      const res = await ragStatus(path) as RagStatusPayload & { detail?: string };
      if (res?.detail) throw new Error(typeof res.detail === 'string' ? res.detail : 'Unable to fetch index status');
      const nextCount = typeof res.indexed_files === 'number' ? res.indexed_files : 0;
      setIndexCount(nextCount);
      setStatusData(res);
      setError('');
      return res;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Status lookup failed';
      setError(msg);
      setStatusData(null);
      return null;
    } finally {
      setLoadingStatus(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (!projectPath.trim()) return;
    void refreshStatus();
  }, [projectPath, refreshStatus]);

  useEffect(() => {
    if (!projectPath.trim()) return;
    if (!statusData?.is_indexing) return;
    const timer = setInterval(() => {
      void refreshStatus();
    }, 1000);
    return () => clearInterval(timer);
  }, [projectPath, statusData?.is_indexing, refreshStatus]);

  const startIndex = async () => {
    const path = projectPath.trim();
    if (!path) return;
    setIndexing(true);
    try {
      const res = await ragIndexProject(path);
      if (res?.detail) throw new Error(typeof res.detail === 'string' ? res.detail : 'Failed to start indexing');
      setError('');
      setHint('Indexing started. This can take a few seconds for large projects.');
      await refreshStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Indexing request failed';
      setError(msg);
    } finally {
      setIndexing(false);
    }
  };

  const searchContext = async () => {
    const path = projectPath.trim();
    const q = query.trim();
    if (!path || !q) return;

    setLoadingSearch(true);
    try {
      const status = await refreshStatus();
      if ((status?.indexed_files || 0) <= 0 && (status?.processed_candidates || 0) <= 0) {
        setHint('No indexed files yet. Click Index Project first, then retry search.');
        setPayload(null);
        return;
      }

      const res = await ragContext(path, q, limit, 360);
      if (res?.detail) throw new Error(typeof res.detail === 'string' ? res.detail : 'Context search failed');
      setPayload(res as RagContextPayload);
      setError('');
      setHint((res as RagContextPayload).count > 0 ? 'Context retrieved successfully.' : 'Search completed but no matching snippets were found.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Context search failed';
      setError(msg);
      setPayload(null);
      setHint('');
    } finally {
      setLoadingSearch(false);
    }
  };

  return (
    <div className="rag-shell pro-card">
      <div className="rag-head">
        <div className="rag-title">
          <Database size={14} />
          <span>RAG Context Engine</span>
        </div>
        <button className="git-mini-btn" onClick={refreshStatus} disabled={loadingStatus || !projectPath.trim()}>
          <RefreshCw size={12} className={loadingStatus ? 'spin' : ''} />
          Status
        </button>
      </div>

      <div className="rag-subtitle">Retrieve ranked snippets from your indexed project context.</div>

      <div className="rag-controls">
        <label className="rag-label">Project Path</label>
        <input
          className="rag-input"
          value={projectPath}
          onChange={(e) => setProjectPath(e.target.value)}
          placeholder="F:/Cortex"
        />

        <div className="rag-actions">
          <button className="btn btn--sm" onClick={startIndex} disabled={indexing || !projectPath.trim()}>
            {indexing ? 'Indexing...' : 'Index Project'}
          </button>
          <span className="rag-status">Index: {statusLabel}</span>
        </div>

        <div className="rag-progress-wrap" aria-live="polite">
          <div className="rag-progress-track">
            <div
              className={`rag-progress-fill ${indexingActive ? 'is-active' : ''}`}
              style={{ width: `${Math.max(progressPercent, indexingActive ? 3 : 0)}%` }}
            />
          </div>
          <div className="rag-progress-meta">
            <span>{statusData?.status || (indexingActive ? 'in_progress' : 'idle')}</span>
            <span>{progressPercent}%</span>
            <span>
              {statusData?.eta_seconds != null
                ? `ETA ${formatDuration(statusData.eta_seconds)}`
                : indexingActive
                  ? 'Estimating ETA...'
                  : `Elapsed ${formatDuration(statusData?.elapsed_seconds || 0)}`}
            </span>
          </div>
        </div>

        {hint ? <div className="rag-hint">{hint}</div> : null}

        <label className="rag-label">Query</label>
        <textarea
          className="rag-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find where model routing fallback is implemented"
        />

        <div className="rag-actions">
          <select className="git-select" value={limit} onChange={(e) => setLimit(Number(e.target.value) || 8)}>
            <option value={5}>Top 5</option>
            <option value={8}>Top 8</option>
            <option value={12}>Top 12</option>
          </select>
          <button className="btn btn--primary btn--sm" onClick={searchContext} disabled={loadingSearch || !query.trim() || !projectPath.trim()}>
            <Search size={12} /> {loadingSearch ? 'Searching...' : 'Retrieve Context'}
          </button>
        </div>
      </div>

      {error ? <div className="rag-error">{error}</div> : null}

      {payload ? (
        <div className="rag-results">
          <div className="rag-results-meta">
            Engine: {payload.engine} · Results: {payload.count}
          </div>
          {payload.results.length === 0 ? (
            <div className="git-empty">No context snippets found for this query.</div>
          ) : (
            payload.results.map((item: RagContextResult) => (
              <div key={`${item.path}-${item.score}`} className="rag-card">
                <div className="rag-card-top">
                  <span className="rag-path" title={item.path}>{item.path}</span>
                  <span className="rag-score">score {item.score.toFixed(2)}</span>
                </div>
                <pre className="rag-snippet">{item.snippet}</pre>
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="rag-placeholder">Index the project and run a query to see retrieved context snippets here.</div>
      )}
    </div>
  );
}
