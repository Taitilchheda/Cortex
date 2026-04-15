'use client';
import { useState, useEffect, useRef } from 'react';
import { Notification, Session } from '../lib/types';
import { fetchNotifications, clearNotifications } from '../lib/api';
import { useTheme } from 'next-themes';
import { 
  Bell, 
  Search, 
  Moon, 
  Sun, 
  Monitor, 
  Command, 
  CheckCircle2, 
  AlertCircle,
  Activity,
  Layers,
  Cpu
} from 'lucide-react';

interface AppBarProps {
  ollamaOk: boolean;
  modelCount: number;
  sessionCount: number;
  onGlobalSearch: (query: string) => void;
  sessions?: Session[];
  activeSession?: Session | null;
  activeFile?: string | null;
}

import { ChevronRight, Folder } from 'lucide-react';

export default function AppBar({ 
  ollamaOk, modelCount, sessionCount, onGlobalSearch, sessions = [], 
  activeSession, activeFile 
}: AppBarProps) {
  const { theme, setTheme } = useTheme();
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

  useEffect(() => {
    const poll = async () => {
      try {
        const data = await fetchNotifications();
        setNotifs(data.notifications || []);
      } catch { /* ignore */ }
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleSearchSubmit = () => {
    if (searchVal.trim()) {
      onGlobalSearch(searchVal.trim());
      setSearchFocused(false);
    }
  };

  const unread = notifs.filter(n => !n.read).length;

  return (
    <div className="app-bar" id="app-bar">
      {/* Brand & Breadcrumbs */}
      <div className="app-bar__brand-group">
        <div className="app-bar__brand">
          <div className="app-bar__logo" aria-label="Cortex logo">
            <Cpu size={18} color="#fff" />
          </div>
          <span className="app-bar__title">Cortex Pro</span>
        </div>
        
        <div className="app-bar__divider" />
        
        <div className="app-bar__breadcrumbs">
          <ChevronRight size={14} className="bc-sep" />
          <span className="bc-item bc-session">
            {activeSession ? (activeSession.title || 'Untitled Session') : 'Welcome'}
          </span>
          {activeFile && (
            <>
              <ChevronRight size={14} className="bc-sep" />
              <Folder size={12} className="bc-icon" />
              <span className="bc-item bc-file">{activeFile.split(/[/\\]/).pop()}</span>
            </>
          )}
        </div>
      </div>

      {/* Global Search */}
      <div className="app-bar__search-container">
        <div className={`app-bar__search ${searchFocused ? 'focused' : ''}`}
          onClick={() => { searchRef.current?.focus(); setSearchFocused(true); }}
          id="global-search"
        >
          <Search size={14} className="search-icon" />
          <input
            ref={searchRef}
            placeholder="Search everything..."
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
          <div className="kbd-hint">
             <Command size={10} />
             <span>K</span>
          </div>
        </div>
      </div>

      {/* Status & Actions */}
      <div className="app-bar__status">
        <div className="status-badge">
          {ollamaOk ? <CheckCircle2 size={12} color="var(--green)" /> : <AlertCircle size={12} color="var(--red)" />}
          <span style={{ color: ollamaOk ? 'var(--green)' : 'var(--red)' }}>
            {ollamaOk ? 'Ollama' : 'Offline'}
          </span>
        </div>

        <div className="status-item">
          <Layers size={14} />
          <span>{modelCount}</span>
        </div>

        <div className="status-item">
          <Activity size={14} />
          <span>{sessionCount}</span>
        </div>

        <div className="status-divider" />

        <button
          className="icon-btn"
          onClick={() => {
            setTheme(theme === 'light' ? 'dark' : 'light');
          }}
          aria-label="Toggle theme"
        >
          <Moon size={16} />
        </button>

        <div style={{ position: 'relative' }}>
          <button
            className="icon-btn"
            onClick={() => setNotifOpen(!notifOpen)}
            id="notif-btn"
          >
            <Bell size={16} />
            {unread > 0 && <span className="notif-dot" />}
          </button>

          {notifOpen && (
            <div className="notif-dropdown">
              <div className="notif-header">
                <span>Notifications</span>
                {notifs.length > 0 && (
                  <button onClick={async () => {
                    await clearNotifications();
                    setNotifs([]);
                  }}>Clear</button>
                )}
              </div>
              <div className="notif-list">
                {notifs.length === 0 ? (
                  <div className="notif-empty">No new notifications</div>
                ) : (
                  notifs.slice().reverse().map(n => (
                    <div key={n.id} className={`notif-item ${n.level}`}>
                      <div className="notif-title">{n.title}</div>
                      <div className="notif-body">{n.body}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        
        <div className="time-display">{time}</div>
      </div>
    </div>
  );
}
