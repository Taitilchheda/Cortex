'use client';
import { useState } from 'react';
import { ChatMessage } from '../lib/types';
import { extractCodeBlocks } from '../lib/utils';
import { submitFeedback } from '../lib/api';

export default function MessageBubble({ message, sessionId }: { message: ChatMessage; sessionId?: string | null }) {
  const isUser = message.role === 'user';
  const cls = `msg ${isUser ? 'msg--user' : message.isError ? 'msg--err' : 'msg--ai'}`;

  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

  const handleFeedback = async (type: 'up' | 'down') => {
    if (!sessionId) return;
    setFeedback(type);
    try {
      await submitFeedback(sessionId, message.id, type);
    } catch { /* ignore */ }
  };

  return (
    <div className={cls} id={`msg-${message.id}`}>
      {!isUser && (
        <div className="msg__head" style={{ display: 'flex', justifyContent: 'space-between', width: '100%' }}>
          <div>
            <span>{message.isError ? '⚠ Error' : `🤖 ${message.mode || 'Assistant'}`}</span>
            {message.model && <span style={{ color: 'var(--text-4)' }}>· {message.model}</span>}
            {message.latency != null && message.latency > 0 && (
              <span className="latency">{(message.latency / 1000).toFixed(1)}s</span>
            )}
            {message.tokens != null && message.tokens > 0 && (
              <span className="tok-count">{message.tokens} tok</span>
            )}
          </div>
          {!message.isStreaming && !message.isError && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button 
                className="cmd-icon-btn" 
                onClick={() => handleFeedback('up')}
                style={{ filter: feedback === 'up' ? 'drop-shadow(0 0 4px var(--green))' : 'none', color: feedback === 'up' ? 'var(--green)' : '' }}
                title="Good response"
              >👍</button>
              <button 
                className="cmd-icon-btn" 
                onClick={() => handleFeedback('down')}
                style={{ filter: feedback === 'down' ? 'drop-shadow(0 0 4px var(--red))' : 'none', color: feedback === 'down' ? 'var(--red)' : '' }}
                title="Bad response"
              >👎</button>
            </div>
          )}
        </div>
      )}

      <div className="msg__body">
        <FormattedContent content={message.content} />
      </div>

      {message.isStreaming && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <div className="dots"><span /><span /><span /></div>
          <span style={{ fontSize: 11, color: 'var(--text-4)' }}>generating</span>
        </div>
      )}

      {message.attachments && message.attachments.length > 0 && (
        <div className="cmd-atts" style={{ marginTop: 6 }}>
          {message.attachments.map((att, i) => (
            <span key={i} className="cmd-att">
              {att.is_image ? '🖼' : '📄'} {att.name}
            </span>
          ))}
        </div>
      )}

      {/* Feature Request: Multi-Agent Model Conversation Mode -> implemented here as visual indication if mode is 'review' or 'debug' handling others' work */}
      {!isUser && !message.isStreaming && message.mode === 'review' && (
        <div style={{ marginTop: 10, padding: 10, background: 'var(--bg-inset)', borderRadius: 'var(--radius)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--amber)', marginBottom: 4 }}>🔍 Reviewing Changes</div>
          <p style={{ fontSize: 12, color: 'var(--text-3)' }}>The architecture and code generated above have been reviewed by this agent.</p>
        </div>
      )}
    </div>
  );
}

function FormattedContent({ content }: { content: string }) {
  const { parts } = extractCodeBlocks(content);
  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === 'string') return <TextBlock key={i} text={part} />;
        return <CodeBlock key={i} language={part.language} code={part.code} />;
      })}
    </>
  );
}

function TextBlock({ text }: { text: string }) {
  const segments = text.split(/(`[^`]+`)/g);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.startsWith('`') && seg.endsWith('`')) {
          return <code key={i} className="inline-code">{seg.slice(1, -1)}</code>;
        }
        return seg.split('\n\n').map((p, j) => <p key={`${i}-${j}`}>{p}</p>);
      })}
    </>
  );
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="code-wrap">
      <div className="code-bar">
        <span className="code-lang">{language}</span>
        <button className="code-copy" onClick={copy}>{copied ? '✓ Copied' : '📋 Copy'}</button>
      </div>
      <pre className="code-body">{code}</pre>
    </div>
  );
}
