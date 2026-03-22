'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import { AgentMode, ChatRole, FileAttachment } from '../lib/types';
import { uploadFile } from '../lib/api';

interface CommandBarProps {
  onSend: (text: string, mode: AgentMode, role: ChatRole, projectPath: string, attachments: FileAttachment[], selfHeal: boolean) => void;
  onStop?: () => void;
  isStreaming: boolean;
  contextTokens: number;
  contextLimit: number;
  defaultMode?: AgentMode;
}

const MODES: { key: AgentMode; icon: string; label: string; desc: string }[] = [
  { key: 'chat', icon: '💬', label: 'Chat', desc: 'Conversational AI' },
  { key: 'build', icon: '⚡', label: 'Build', desc: 'Generate projects' },
  { key: 'refactor', icon: '🔧', label: 'Refactor', desc: 'Bulk edits' },
];

const ROLES: { key: ChatRole; label: string; desc: string }[] = [
  { key: 'coder', label: 'Coder', desc: 'Write production code' },
  { key: 'architect', label: 'Architect', desc: 'Design systems' },
  { key: 'debug', label: 'Debug', desc: 'Find & fix bugs' },
  { key: 'quick', label: 'Quick', desc: 'Fast answers' },
  { key: 'explain', label: 'Explain', desc: 'Explain code' },
  { key: 'review', label: 'Review', desc: 'Code review' },
];

const SLASH_COMMANDS = [
  { cmd: '/build', mode: 'build' as AgentMode, desc: 'Full architect→coder pipeline', icon: '⚡' },
  { cmd: '/refactor', mode: 'refactor' as AgentMode, desc: 'Aider-powered bulk edit', icon: '🔧' },
  { cmd: '/review', mode: 'chat' as AgentMode, role: 'review' as ChatRole, desc: 'Code review agent', icon: '🔍' },
  { cmd: '/explain', mode: 'chat' as AgentMode, role: 'explain' as ChatRole, desc: 'Explain code or concept', icon: '📖' },
  { cmd: '/debug', mode: 'chat' as AgentMode, role: 'debug' as ChatRole, desc: 'Debug with reasoning', icon: '🐛' },
  { cmd: '/test', mode: 'chat' as AgentMode, role: 'coder' as ChatRole, desc: 'Generate and run tests', icon: '🧪' },
];

const PROMPT_SUGGESTIONS = [
  { text: 'Create a REST API with authentication', mode: 'build' as AgentMode },
  { text: 'Explain how this code works', mode: 'chat' as AgentMode },
  { text: 'Review this code for security issues', mode: 'chat' as AgentMode },
  { text: 'Create a React component for', mode: 'build' as AgentMode },
  { text: 'Write unit tests for', mode: 'chat' as AgentMode },
  { text: 'Debug this error:', mode: 'chat' as AgentMode },
  { text: 'Build a portfolio website with HTML, CSS, JS', mode: 'build' as AgentMode },
  { text: 'Create a Python CLI tool that', mode: 'build' as AgentMode },
];

export default function CommandBar({ onSend, onStop, isStreaming, contextTokens, contextLimit, defaultMode }: CommandBarProps) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AgentMode>(defaultMode || 'chat');
  const [role, setRole] = useState<ChatRole>('coder');
  const [projectPath, setProjectPath] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [selfHeal, setSelfHeal] = useState(false);
  const [showSlash, setShowSlash] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const startListening = () => {
    // @ts-ignore
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("Speech recognition is not supported in this browser.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event: any) => {
      let finalTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) finalTranscript += event.results[i][0].transcript;
      }
      if (finalTranscript) {
        setText(prev => prev + (prev.endsWith(' ') || !prev ? '' : ' ') + finalTranscript);
        adjustHeight();
      }
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognition.start();
  };

  // Sync mode from parent
  useEffect(() => {
    if (defaultMode) setMode(defaultMode);
  }, [defaultMode]);

  // Slash command detection
  useEffect(() => {
    setShowSlash(text.startsWith('/') && text.length < 12 && text.length > 0);
    setShowSuggestions(false);
  }, [text]);

  const handleSend = useCallback(() => {
    let finalText = text.trim();
    if (!finalText || isStreaming) return;

    let finalMode = mode;
    let finalRole = role;

    // Process slash commands
    for (const sc of SLASH_COMMANDS) {
      if (finalText.startsWith(sc.cmd + ' ') || finalText === sc.cmd) {
        finalMode = sc.mode;
        if (sc.role) finalRole = sc.role;
        finalText = finalText.slice(sc.cmd.length).trim() || finalText;
        break;
      }
    }

    onSend(finalText, finalMode, finalRole, projectPath, attachments, selfHeal);
    setText('');
    setAttachments([]);
    setShowSlash(false);
    setShowSuggestions(false);
  }, [text, mode, role, projectPath, attachments, selfHeal, isStreaming, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (const file of Array.from(files)) {
      try {
        const result = await uploadFile(file);
        setAttachments(prev => [...prev, result]);
      } catch { /* ignore */ }
    }
    if (fileRef.current) fileRef.current.value = '';
  };

  const removeAtt = (i: number) => setAttachments(prev => prev.filter((_, idx) => idx !== i));

  const adjustHeight = () => {
    const el = textRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    }
  };

  // Paste images from clipboard
  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          try {
            const result = await uploadFile(blob);
            setAttachments(prev => [...prev, result]);
          } catch { /* ignore */ }
        }
      }
    }
  };

  // Context gauge
  const gaugePercent = contextLimit > 0 ? Math.min((contextTokens / contextLimit) * 100, 100) : 0;
  const gaugeColor = gaugePercent < 50 ? 'green' : gaugePercent < 80 ? 'amber' : 'red';

  // Filtered slash commands
  const filteredSlash = showSlash
    ? SLASH_COMMANDS.filter(sc => sc.cmd.startsWith(text.trim().split(' ')[0]))
    : [];

  // Prompt suggestions when input is focused and empty
  const suggestions = showSuggestions && !text
    ? PROMPT_SUGGESTIONS.filter(s => s.mode === mode || mode === 'chat').slice(0, 4)
    : [];

  return (
    <div className="command-bar" id="command-bar">
      {/* Mode & Role row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <div className="cmd-modes">
          {MODES.map(m => (
            <button key={m.key}
              className={`cmd-mode ${mode === m.key ? 'active' : ''}`}
              onClick={() => setMode(m.key)}
              title={m.desc}
              id={`mode-${m.key}`}
            >
              {m.icon} {m.label}
            </button>
          ))}
        </div>

        {mode === 'chat' && (
          <div className="cmd-roles">
            {ROLES.map(r => (
              <button key={r.key}
                className={`cmd-role ${role === r.key ? 'active' : ''}`}
                onClick={() => setRole(r.key)}
                title={r.desc}
                id={`role-${r.key}`}
              >
                {r.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Project path (build/refactor) */}
      {(mode === 'build' || mode === 'refactor') && (
        <div className="cmd-path">
          <input
            placeholder="Project path (e.g., C:\my-project)"
            value={projectPath}
            onChange={e => setProjectPath(e.target.value)}
            id="project-path"
            aria-label="Project path"
          />
          {mode === 'build' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={selfHeal} onChange={e => setSelfHeal(e.target.checked)} style={{ accentColor: 'var(--violet)' }} />
              <span style={{ fontSize: 10, color: 'var(--text-3)' }}>Self-heal</span>
            </label>
          )}
        </div>
      )}

      {/* Attachments */}
      {attachments.length > 0 && (
        <div className="cmd-atts">
          {attachments.map((att, i) => (
            <span key={i} className="cmd-att">
              {att.is_image ? '🖼' : '📄'} {att.name}
              <button className="cmd-att-rm" onClick={() => removeAtt(i)} aria-label={`Remove ${att.name}`}>✕</button>
            </span>
          ))}
        </div>
      )}

      {/* Slash command autocomplete */}
      {filteredSlash.length > 0 && (
        <div style={{
          padding: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', marginBottom: 6,
        }}>
          {filteredSlash.map(sc => (
            <div key={sc.cmd} style={{
              padding: '6px 10px', borderRadius: 5, cursor: 'pointer',
              fontSize: 12, display: 'flex', gap: 8, alignItems: 'center',
              transition: 'background 0.15s',
            }}
            onClick={() => { setText(sc.cmd + ' '); setShowSlash(false); textRef.current?.focus(); }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <span>{sc.icon}</span>
              <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--violet)', fontWeight: 700 }}>{sc.cmd}</code>
              <span style={{ color: 'var(--text-4)', flex: 1 }}>{sc.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* Prompt suggestions */}
      {suggestions.length > 0 && (
        <div style={{
          padding: 4, background: 'var(--bg-elevated)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius)', marginBottom: 6,
        }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-4)', padding: '4px 8px', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Suggestions
          </div>
          {suggestions.map((s, i) => (
            <div key={i} style={{
              padding: '5px 10px', borderRadius: 5, cursor: 'pointer',
              fontSize: 12, color: 'var(--text-2)', transition: 'background 0.15s',
            }}
            onClick={() => { setText(s.text); setShowSuggestions(false); textRef.current?.focus(); }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              {s.text}
            </div>
          ))}
        </div>
      )}

      {/* Main input */}
      <div className="cmd-input-wrap">
        <textarea
          ref={textRef}
          className="cmd-textarea"
          placeholder={
            mode === 'build' ? 'Describe the project to build... (try /build)' :
            mode === 'refactor' ? 'Describe the refactoring... (try /refactor)' :
            'Ask anything, or type / for commands...'
          }
          value={text}
          onChange={e => { setText(e.target.value); adjustHeight(); }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocus={() => { if (!text) setShowSuggestions(true); }}
          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
          rows={1}
          id="main-input"
          aria-label="Message input"
        />
        <div className="cmd-actions">
          {isStreaming ? (
            <button className="cmd-send cmd-send-stop" onClick={onStop} style={{ background: 'var(--red-dim)', color: 'var(--red)', borderColor: 'var(--red)' }}>
              ⏹ Stop
            </button>
          ) : (
            <>
              <button className="cmd-icon-btn" onClick={startListening} title="Voice input" aria-label="Microphone">
                {isListening ? <span style={{ color: 'var(--red)', animation: 'pulse 1.5s infinite' }}>🎙</span> : '🎙'}
              </button>
              <button className="cmd-icon-btn" onClick={() => fileRef.current?.click()} title="Attach file (images, code, PDFs)" id="attach-btn" aria-label="Attach file">
                📎
              </button>
              <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={handleFile} accept="*/*" />
              <button
                className="cmd-send"
                onClick={handleSend}
                disabled={!text.trim() || isStreaming}
                id="send-btn"
                aria-label="Send message"
              >
                ▶ Send
              </button>
            </>
          )}
        </div>
      </div>

      {/* Context & Keyboard hints */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 5 }}>
        <div style={{ fontSize: 10, color: 'var(--text-4)', display: 'flex', gap: 10 }}>
          <span>Enter to send · Shift+Enter for newline</span>
          <span>/ for commands</span>
        </div>
        <div className="cmd-context-gauge" style={{ marginTop: 0 }}>
          <span>Context:</span>
          <div className="gauge-bar" style={{ width: 80 }}>
            <div className={`gauge-fill ${gaugeColor}`} style={{ width: `${gaugePercent}%` }} />
          </div>
          <span>{contextTokens.toLocaleString()} / {contextLimit.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}
