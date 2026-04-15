'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchHardwareStats } from '../lib/api';
import { HardwareStats } from '../lib/types';

const POLL_INTERVAL_MS = 3000;
const SMOOTHING_ALPHA = 0.28;

function pct(value?: number | null): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '--';
  return `${Math.round(value)}%`;
}

function ema(prev?: number | null, next?: number | null, alpha = SMOOTHING_ALPHA): number | undefined {
  if (typeof next !== 'number' || Number.isNaN(next)) {
    return typeof prev === 'number' && !Number.isNaN(prev) ? prev : undefined;
  }
  if (typeof prev !== 'number' || Number.isNaN(prev)) {
    return next;
  }
  return prev + (next - prev) * alpha;
}

function smoothStats(prev: HardwareStats | null, next: HardwareStats): HardwareStats {
  const cpuPrev = prev?.cpu?.utilization_pct ?? prev?.cpu?.percent;
  const cpuNext = next.cpu?.utilization_pct ?? next.cpu?.percent;

  const ramPrev = prev?.ram?.utilization_pct ?? prev?.memory?.percent;
  const ramNext = next.ram?.utilization_pct ?? next.memory?.percent;

  const gpuPrev = prev?.gpu?.utilization_pct;
  const gpuNext = next.gpu?.utilization_pct;

  return {
    ...next,
    cpu: {
      ...next.cpu,
      utilization_pct: ema(cpuPrev, cpuNext),
    },
    ram: {
      ...next.ram,
      used_mb: ema(prev?.ram?.used_mb, next.ram?.used_mb),
      utilization_pct: ema(ramPrev, ramNext),
    },
    gpu: {
      ...next.gpu,
      utilization_pct: ema(gpuPrev, gpuNext),
    },
  };
}

export default function HardwareDashboard() {
  const [stats, setStats] = useState<HardwareStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const hasLoadedRef = useRef(false);

  const pollStats = useCallback(async () => {
    if (!hasLoadedRef.current) setLoading(true);
    try {
      const row = await fetchHardwareStats();
      if (row) {
        setStats((prev) => smoothStats(prev, row));
        hasLoadedRef.current = true;
      }
      setError('');
    } catch {
      setError('Hardware telemetry unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    pollStats();
    const id = setInterval(pollStats, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [pollStats]);

  const cpuPct = useMemo(() => pct(stats?.cpu?.utilization_pct ?? stats?.cpu?.percent), [stats]);
  const ramPct = useMemo(() => pct(stats?.ram?.utilization_pct ?? stats?.memory?.percent), [stats]);
  const gpuPct = useMemo(() => pct(stats?.gpu?.utilization_pct), [stats]);

  return (
    <div className="pro-card">
      <div className="card__label">Hardware Dashboard</div>

      <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase' }}>CPU</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{cpuPct}</div>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase' }}>RAM</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{ramPct}</div>
          </div>
          <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
            <div style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase' }}>GPU</div>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{gpuPct}</div>
          </div>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          RAM usage: {stats?.ram?.used_mb ?? '--'} MB / {stats?.ram?.total_mb ?? '--'} MB
        </div>

        {error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>}
        {loading && <div style={{ fontSize: 11, color: 'var(--text-4)' }}>Reading hardware metrics...</div>}
      </div>
    </div>
  );
}
