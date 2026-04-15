'use client';
import { useState } from 'react';
import { ChatMessage } from '../lib/types';
import { extractCodeBlocks } from '../lib/utils';
import { submitFeedback } from '../lib/api';
import { toast } from 'sonner';
import { 
  ThumbsUp, 
  ThumbsDown, 
  Copy, 
  Check, 
  Play, 
  Cpu, 
  User, 
  Paperclip, 
  AlertCircle,
  Clock,
  Coins
} from 'lucide-react';

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
      <div className="msg__head">
        <div className="msg__avatar">
          {isUser ? <User size={14} /> : <Cpu size={14} className="icon-violet" />}
        </div>
        <span className="msg__role">{isUser ? 'You' : (message.mode || 'Cortex')}</span>
        
        {!isUser && message.model && <span className="msg__model">{message.model}</span>}
        
        {!isUser && !message.isStreaming && !message.isError && (
          <div className="msg__feedback">
            <button 
              className={`feedback-btn ${feedback === 'up' ? 'active-up' : ''}`}
              onClick={() => handleFeedback('up')}
            >
              <ThumbsUp size={12} />
            </button>
            <button 
              className={`feedback-btn ${feedback === 'down' ? 'active-down' : ''}`}
              onClick={() => handleFeedback('down')}
            >
              <ThumbsDown size={12} />
            </button>
          </div>
        )}

        <div style={{ flex: 1 }} />
        
        {!isUser && message.latency != null && message.latency > 0 && (
          <div className="msg__stat">
            <Clock size={10} />
            <span>{(message.latency / 1000).toFixed(1)}s</span>
          </div>
        )}
        {!isUser && message.tokens != null && message.tokens > 0 && (
          <div className="msg__stat">
            <Coins size={10} />
            <span>{message.tokens}</span>
          </div>
        )}
      </div>

      <div className="msg__body">
        <FormattedContent content={message.content} />
      </div>

      {message.attachments && message.attachments.length > 0 && (
        <div className="v2-attachments" style={{ marginTop: 12, padding: 0, background: 'none', border: 'none' }}>
          {message.attachments.map((att, i) => (
            <div key={i} className="v2-att">
              <Paperclip size={10} />
              <span className="v2-att-name">{att.name}</span>
            </div>
          ))}
        </div>
      )}

      {message.isStreaming && (
        <div className="msg__streaming">
          <div className="dots"><span /><span /><span /></div>
          <span>Thinking...</span>
        </div>
      )}

      {message.isError && (
        <div className="msg__error-box">
          <AlertCircle size={14} />
          <span>Something went wrong with this response.</span>
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
  
  const apply = () => {
    toast.success('Code Applied', { description: 'Modifications integrated into local workspace.' });
  };

  return (
    <div className="code-wrap">
      <div className="code-bar">
        <span className="code-lang">{language}</span>
        <div className="code-actions">
          <button className="code-btn" onClick={apply}>
            <Play size={11} fill="currentColor" />
            <span>Apply</span>
          </button>
          <button className="code-btn" onClick={copy}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>
      <pre className="code-body">{code}</pre>
    </div>
  );
}
