'use client';
import { useState, useRef, useCallback, useEffect } from 'react';
import { AgentMode, ChatRole, FileAttachment } from '../lib/types';
import { uploadFile } from '../lib/api';
import { truncate } from '../lib/utils';
import { 
  Send, 
  Mic, 
  Paperclip, 
  MessageSquare, 
  Zap, 
  Hammer, 
  Settings, 
  Brain, 
  Code2, 
  Bug, 
  Sparkles, 
  Search, 
  StopCircle,
  X,
  FileText,
  Image as ImageIcon
} from 'lucide-react';

interface CommandBarProps {
  onSend: (text: string, mode: AgentMode, role: ChatRole, projectPath: string, attachments: FileAttachment[], selfHeal: boolean) => void;
  onStop?: () => void;
  isStreaming: boolean;
  contextTokens: number;
  contextLimit: number;
  defaultMode?: AgentMode;
}

const MODES: { key: AgentMode; icon: any; label: string; desc: string; color: string }[] = [
  { key: 'chat', icon: MessageSquare, label: 'Chat', desc: 'Conversational agent', color: '#8b5cf6' },
  { key: 'build', icon: Zap, label: 'Build', desc: 'Generate a project', color: '#3b82f6' },
  { key: 'refactor', icon: Hammer, label: 'Refactor', desc: 'Bulk modify code', color: '#f59e0b' },
];

const ROLES: { key: ChatRole; label: string; desc: string; icon: any; color: string }[] = [
  { key: 'auto', label: 'Auto', desc: 'Route by task intent', icon: Sparkles, color: '#22c55e' },
  { key: 'coder', label: 'Coder', desc: 'Writes production code', icon: Code2, color: '#3b82f6' },
  { key: 'debug', label: 'Debugger', desc: 'Finds and fixes bugs', icon: Bug, color: '#ef4444' },
  { key: 'architect', label: 'Architect', desc: 'System design expert', icon: Brain, color: '#8b5cf6' },
  { key: 'quick', label: 'Quick', desc: 'Fast answers', icon: Sparkles, color: '#10b981' },
  { key: 'review', label: 'Reviewer', desc: 'Audit code quality', icon: Search, color: '#64748b' },
];

const TEMPLATES = [
  { label: 'Bug Hunt', desc: 'Diagnose + steps to fix', prompt: 'Investigate the reported issue, list likely root causes, and propose a minimal fix with file/line references.', role: 'debug' as ChatRole },
  { label: 'Refactor Plan', desc: 'Safe restructuring checklist', prompt: 'Propose a refactor plan for this codebase. List risks, impacted modules, and stepwise commits.', role: 'architect' as ChatRole },
  { label: 'Add Tests', desc: 'Edge cases + fixtures', prompt: 'Add automated tests covering edge cases, failure paths, and performance-critical code. Provide file names and snippets.', role: 'coder' as ChatRole },
  { label: 'Docstring Pass', desc: 'Improve clarity', prompt: 'Improve documentation/comments for the touched functions. Keep edits minimal and precise.', role: 'review' as ChatRole },
  { label: 'Ship Checklist', desc: 'Pre-release QA', prompt: 'Produce a release checklist: tests to run, manual verification steps, and rollback plan.', role: 'review' as ChatRole },
];

export default function CommandBar({ onSend, onStop, isStreaming, contextTokens, contextLimit, defaultMode }: CommandBarProps) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AgentMode>(defaultMode || 'chat');
  const [role, setRole] = useState<ChatRole>('auto');
  const [projectPath, setProjectPath] = useState('');
  const [attachments, setAttachments] = useState<FileAttachment[]>([]);
  const [selfHeal, setSelfHeal] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (defaultMode) setMode(defaultMode);
  }, [defaultMode]);

  useEffect(() => {
    if ((mode === 'build' || mode === 'refactor') && !projectPath && typeof window !== 'undefined') {
      const remembered = localStorage.getItem('cortex-last-path') || '';
      if (remembered) setProjectPath(remembered);
    }
  }, [mode, projectPath]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPrefill = (event: Event) => {
      const custom = event as CustomEvent<{ text?: string; mode?: AgentMode; role?: ChatRole; projectPath?: string }>;
      const payload = custom.detail || {};
      if (payload.mode) setMode(payload.mode);
      if (payload.role) setRole(payload.role);
      if (payload.projectPath != null) setProjectPath(payload.projectPath);
      if (payload.text != null) {
        setText(payload.text);
        setTimeout(() => {
          adjustHeight();
          textRef.current?.focus();
        }, 0);
      }
    };

    window.addEventListener('cortex:prefill', onPrefill as EventListener);
    return () => window.removeEventListener('cortex:prefill', onPrefill as EventListener);
  }, []);

  const handleSend = useCallback(() => {
    let finalText = text.trim();
    if (!finalText || isStreaming) return;
    onSend(finalText, mode, role, projectPath, attachments, selfHeal);
    setText('');
    setAttachments([]);
    if (textRef.current) textRef.current.style.height = 'auto';
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
      el.style.height = Math.min(el.scrollHeight, 180) + 'px';
    }
  };

  const startListening = () => {
    // @ts-ignore
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event: any) => {
      const transcript = event.results[event.results.length - 1][0].transcript;
      setText(prev => prev + transcript);
      adjustHeight();
    };
    recognition.onend = () => setIsListening(false);
    recognition.start();
  };

  const gaugePercent = contextLimit > 0 ? Math.min((contextTokens / contextLimit) * 100, 100) : 0;
  const gaugeColor = gaugePercent < 50 ? 'var(--green)' : gaugePercent < 80 ? 'var(--amber)' : 'var(--red)';

  return (
    <div className="input-bar-v2" id="command-bar">
      {/* Settings bar */}
      <div className="input-v2-options">
        <div className="v2-modes">
          {MODES.map(m => (
            <button key={m.key} className={`v2-mode ${mode === m.key ? 'active' : ''}`} onClick={() => setMode(m.key)}>
               <m.icon size={12} strokeWidth={mode === m.key ? 3 : 2} style={{ color: mode === m.key ? m.color : 'inherit' }} />
               <span>{m.label}</span>
            </button>
          ))}
        </div>
        
        <div className="v2-divider" />
        
        {mode === 'chat' && (
          <div className="v2-roles">
             {ROLES.map(r => (
                <button key={r.key} className={`v2-role ${role === r.key ? 'active' : ''}`} onClick={() => setRole(r.key)}>
                   <r.icon size={12} strokeWidth={role === r.key ? 3 : 2} style={{ color: role === r.key ? r.color : 'inherit' }} />
                   <span>{r.label}</span>
                </button>
             ))}
          </div>
        )}
        
        {(mode === 'build' || mode === 'refactor') && (
           <div className="v2-path-box">
              <input 
                placeholder="Target project path..." 
                value={projectPath} 
                onChange={e => setProjectPath(e.target.value)}
              />
              <label className="v2-selfheal">
                <input type="checkbox" checked={selfHeal} onChange={e => setSelfHeal(e.target.checked)} />
                <span>Self-heal</span>
              </label>
           </div>
        )}

        <div style={{ flex: 1 }} />
        
        <div className="v2-gauge">
          <div className="v2-gauge-bar">
             <div className="v2-gauge-fill" style={{ width: `${gaugePercent}%`, background: gaugeColor }} />
          </div>
          <span style={{ color: gaugeColor }}>{contextTokens.toLocaleString()} tokens</span>
        </div>
      </div>

      <div className="input-v2-main">
        <textarea
          ref={textRef}
          className="v2-textarea"
          placeholder={
            mode === 'build' ? 'I want to build a...' :
            mode === 'refactor' ? 'What should we refactor?' :
            'Message Cortex...'
          }
          value={text}
          onChange={e => { setText(e.target.value); adjustHeight(); }}
          onKeyDown={handleKeyDown}
          rows={1}
          id="main-input"
        />

        <div className="v2-actions">
           {isStreaming ? (
             <button className="v2-stop-btn" onClick={onStop} title="Stop generation">
               <StopCircle size={18} />
             </button>
           ) : (
             <>
               <button className="v2-icon-btn" onClick={startListening} title="Voice" style={{ color: isListening ? 'var(--red)' : '' }}>
                 <Mic size={16} />
               </button>
               <button className="v2-icon-btn" onClick={() => fileRef.current?.click()} title="Attach">
                 <Paperclip size={16} />
               </button>
               <input ref={fileRef} type="file" multiple style={{ display: 'none' }} onChange={handleFile} />
               
               <button 
                 className="v2-send-btn" 
                 onClick={handleSend}
                 disabled={!text.trim() || isStreaming}
               >
                 <Send size={14} fill="currentColor" />
               </button>
             </>
           )}
        </div>
      </div>

      <div className="workflow-strip" aria-label="Current workflow policy">
        <span className="workflow-chip">Mode: {mode}</span>
        {mode === 'chat' && <span className="workflow-chip">Role: {role}</span>}
        {(mode === 'build' || mode === 'refactor') && (
          <>
            <span className="workflow-chip">Path: {projectPath ? truncate(projectPath, 28) : 'not set'}</span>
            <span className="workflow-chip">Self-heal: {selfHeal ? 'on' : 'off'}</span>
          </>
        )}
        <span className="workflow-chip">Attachments: {attachments.length}</span>
      </div>

      {/* Attachments UI */}
      {attachments.length > 0 && (
        <div className="v2-attachments">
          {attachments.map((att, i) => (
            <div key={i} className="v2-att">
              {att.is_image ? <ImageIcon size={12} /> : <FileText size={12} />}
              <span className="v2-att-name">{truncate(att.name, 12)}</span>
              <button className="v2-att-del" onClick={() => removeAtt(i)}><X size={10} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="template-row">
        {TEMPLATES.map(t => (
          <button
            key={t.label}
            className="template-chip"
            onClick={() => {
              setMode('chat');
              setRole(t.role);
              setText(t.prompt);
              setTimeout(() => adjustHeight(), 10);
            }}
          >
            <span className="t-label">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
