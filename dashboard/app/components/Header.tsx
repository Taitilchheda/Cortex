'use client';
import { useState, useEffect, useRef } from 'react';
import { Notification, Session } from '../lib/types';
import { fetchNotifications, clearNotifications } from '../lib/api';

interface AppBarProps {
  ollamaOk: boolean;
  modelCount: number;
  sessionCount: number;
  onGlobalSearch: (query: string) => void;
  sessions?: Session[];
}

export default function AppBar({ ollamaOk, modelCount, sessionCount, onGlobalSearch, sessions = [] }: AppBarProps) {
  const [time, setTime] = useState('');
  const [searchVal, setSearchVal] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);
  const [notifs, setNotifs] = useState<Notification[]>([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }));
    tick();
    const interval = setInterval(tick, 30000);
    return () => clearInterval(interval);
  }, []);

  // Poll notifications
  useEffect(() => {
    const poll = async () => {
      try {
        const data = await fetchNotifications();
        setNotifs(data.notifications || []);
      } catch { /* backend may be offline */ }
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, []);

  // ⌘K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        setSearchFocused(true);
      }
      if (e.key === 'Escape') {
        setSearchFocused(false);
        setNotifOpen(false);
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Search suggestions based on existing sessions
  const searchSuggestions = searchFocused && searchVal.length > 0
    ? sessions.filter(s =>
        (s.title || '').toLowerCase().includes(searchVal.toLowerCase()) ||
        s.type.includes(searchVal.toLowerCase()) ||
        (s.project_path || '').toLowerCase().includes(searchVal.toLowerCase())
      ).slice(0, 5)
    : [];

  const handleSearchSubmit = () => {
    if (searchVal.trim()) {
      onGlobalSearch(searchVal.trim());
      setSearchFocused(false);
    }
  };

  const unread = notifs.filter(n => !n.read).length;

  return (
    <div className="app-bar" id="app-bar">
      {/* Brand */}
      <div className="app-bar__brand">
        <div className="app-bar__logo" aria-label="Cortex logo">🚀</div>
        <span className="app-bar__title">Cortex</span>
        <span className="app-bar__ver">v5.0</span>
      </div>

      {/* Global Search with Suggestions */}
      <div style={{ position: 'relative', flex: '0 1 360px' }}>
        <div className="app-bar__search"
          onClick={() => { searchRef.current?.focus(); setSearchFocused(true); }}
          id="global-search"
        >
          <span style={{ fontSize: 13, color: 'var(--text-4)' }}>🔍</span>
          <input
            ref={searchRef}
            placeholder="Search sessions, files, prompts..."
            value={searchVal}
            onChange={e => setSearchVal(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') handleSearchSubmit();
              if (e.key === 'Escape') { setSearchFocused(false); searchRef.current?.blur(); }
            }}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
            aria-label="Global search"
          />
          <kbd>⌘K</kbd>
        </div>

        {/* Search suggestions dropdown */}
        {searchSuggestions.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', marginTop: 4,
            boxShadow: '0 8px 30px rgba(0,0,0,0.5)', zIndex: 300,
            overflow: 'hidden',
          }}>
            <div style={{ padding: '6px 10px', fontSize: 10, fontWeight: 700, color: 'var(--text-4)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
              Matching Sessions
            </div>
            {searchSuggestions.map(s => (
              <div key={s.id} style={{
                padding: '8px 12px', cursor: 'pointer', fontSize: 12,
                display: 'flex', alignItems: 'center', gap: 8,
                transition: 'background 0.15s',
              }}
              onClick={() => {
                onGlobalSearch(s.title || '');
                setSearchVal('');
                setSearchFocused(false);
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <span>{s.type === 'build' ? '⚡' : s.type === 'refactor' ? '🔧' : '💬'}</span>
                <span style={{ flex: 1, color: 'var(--text-1)' }}>{s.title}</span>
                <span style={{ fontSize: 10, color: 'var(--text-4)' }}>{s.type}</span>
              </div>
            ))}
          </div>
        )}

        {/* Contextual suggestions when empty */}
        {searchFocused && !searchVal && sessions.length > 0 && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0,
            background: 'var(--bg-surface)', border: '1px solid var(--border)',
            borderRadius: 'var(--radius)', marginTop: 4,
            boxShadow: '0 8px 30px rgba(0,0,0,0.5)', zIndex: 300,
          }}>
            <div style={{ padding: '6px 10px', fontSize: 10, fontWeight: 700, color: 'var(--text-4)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
              Recent Sessions
            </div>
            {sessions.slice(0, 5).map(s => (
              <div key={s.id} style={{
                padding: '8px 12px', cursor: 'pointer', fontSize: 12,
                display: 'flex', alignItems: 'center', gap: 8,
                transition: 'background 0.15s',
              }}
              onClick={() => {
                onGlobalSearch(s.title || s.id);
                setSearchFocused(false);
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                <span>{s.type === 'build' ? '⚡' : s.type === 'refactor' ? '🔧' : '💬'}</span>
                <span style={{ flex: 1, color: 'var(--text-2)' }}>{s.title}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Status cluster */}
      <div className="app-bar__status">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div
            className={`status-ring ${ollamaOk ? 'status-ring--ok' : 'status-ring--err'}`}
            style={{ color: ollamaOk ? 'var(--green)' : 'var(--red)' }}
            role="status"
            aria-label={ollamaOk ? 'Ollama connected' : 'Ollama disconnected'}
          />
          <span className="status-text" style={{ color: ollamaOk ? 'var(--green)' : 'var(--red)' }}>
            {ollamaOk ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        <span className="status-text"><b>{modelCount}</b> models</span>
        <span className="status-text">{sessionCount} sessions</span>
        <span className="status-text" style={{ opacity: 0.5 }}>{time}</span>

        {/* Notifications */}
        <div style={{ position: 'relative' }}>
          <button
            className="notif-btn"
            onClick={() => setNotifOpen(!notifOpen)}
            aria-label={`Notifications (${unread} unread)`}
            id="notif-btn"
          >
            🔔
            {unread > 0 && <span className="notif-badge">{unread}</span>}
          </button>

          {notifOpen && (
            <div style={{
              position: 'absolute', top: '100%', right: 0, width: 300,
              background: 'var(--bg-surface)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', padding: 10,
              boxShadow: '0 8px 30px rgba(0,0,0,0.5)', zIndex: 200,
              maxHeight: 320, overflowY: 'auto',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)' }}>Notifications</span>
                {notifs.length > 0 && (
                  <button className="btn btn--sm btn--danger" onClick={async () => {
                    await clearNotifications();
                    setNotifs([]);
                  }}>Clear</button>
                )}
              </div>
              {notifs.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-4)', textAlign: 'center', padding: 20 }}>
                  No notifications yet
                </div>
              ) : (
                notifs.slice().reverse().map(n => (
                  <div key={n.id} style={{
                    padding: 8, borderRadius: 6, marginBottom: 4,
                    background: n.level === 'error' ? 'var(--red-dim)' :
                      n.level === 'success' ? 'var(--green-dim)' :
                        n.level === 'warning' ? 'var(--amber-dim)' : 'var(--bg-elevated)',
                    fontSize: 11,
                  }}>
                    <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>{n.title}</div>
                    <div style={{ color: 'var(--text-3)', marginTop: 2 }}>{n.body}</div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
