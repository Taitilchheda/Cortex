'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchModelCatalog } from '../lib/api';
import { UnifiedModel } from '../lib/types';

const SOURCE_ORDER: Record<string, number> = {
  local: 0,
  cloud: 1,
  openrouter: 2,
};

type SourceFilter = 'all' | 'local' | 'cloud' | 'openrouter';


function toSourceFilter(value: string): SourceFilter {
  if (value === 'local' || value === 'cloud' || value === 'openrouter') {
    return value;
  }
  return 'all';
}

export default function ModelPicker() {
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [query, setQuery] = useState('');

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetchModelCatalog();
      const rows = Array.isArray(resp?.models) ? resp.models : [];
      setModels(rows);
    } catch {
      setError('Failed to load unified model catalog');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...models]
      .filter(m => sourceFilter === 'all' || m.source === sourceFilter)
      .filter(m => !q || m.name.toLowerCase().includes(q) || (m.provider || '').toLowerCase().includes(q))
      .sort((a, b) => {
        const sourceCmp = (SOURCE_ORDER[a.source] ?? 99) - (SOURCE_ORDER[b.source] ?? 99);
        if (sourceCmp !== 0) return sourceCmp;
        return a.name.localeCompare(b.name);
      });
  }, [models, sourceFilter, query]);

  const sourceCounts = useMemo(() => {
    const counts = { local: 0, cloud: 0, openrouter: 0 };
    for (const m of models) {
      if (m.source === 'local') counts.local += 1;
      else if (m.source === 'cloud') counts.cloud += 1;
      else if (m.source === 'openrouter') counts.openrouter += 1;
    }
    return counts;
  }, [models]);

  return (
    <div className="pro-card">
      <div className="card__label">Unified Model Picker</div>
      <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="lp-search"
            style={{ flex: 1, padding: '6px 8px' }}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter models"
          />
          <select
            className="setting-select"
            style={{ width: 132 }}
            value={sourceFilter}
            onChange={e => setSourceFilter(toSourceFilter(e.target.value))}
          >
            <option value="all">All Sources</option>
            <option value="local">Local</option>
            <option value="cloud">Cloud</option>
            <option value="openrouter">OpenRouter</option>
          </select>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-4)' }}>
          <span>{filtered.length} model(s)</span>
          <button className="btn--sm" onClick={loadCatalog} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        <div style={{ fontSize: 10, color: 'var(--text-4)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span>Local: {sourceCounts.local}</span>
          <span>Cloud: {sourceCounts.cloud}</span>
          <span>OpenRouter: {sourceCounts.openrouter}</span>
        </div>

        {error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>}

        <div style={{ display: 'grid', gap: 8, maxHeight: 260, overflow: 'auto', paddingRight: 2 }}>
          {filtered.slice(0, 50).map(model => (
            <div key={model.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={model.name}>
                    {model.name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-4)' }}>
                    {model.provider}
                  </div>
                </div>
                <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 999, background: 'var(--bg-hover)', textTransform: 'uppercase' }}>
                  {model.source}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 6, fontSize: 10, color: 'var(--text-3)' }}>
                <span>VRAM {model.vram_gb ?? '-'} GB</span>
                <span>Ctx {model.context_length ?? '-'}</span>
                <span>Rank {model.rank ?? '-'}</span>
              </div>
            </div>
          ))}

          {!loading && filtered.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-4)' }}>No models matched your filter.</div>
          )}
        </div>
      </div>
    </div>
  );
}
