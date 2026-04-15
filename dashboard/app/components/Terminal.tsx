'use client';
import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TerminalProps {
  logs: string[];
}

export default function Terminal({ logs }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!termRef.current) return;

    term.current = new XTerm({
      cursorBlink: true,
      theme: {
        background: '#09090b',
        foreground: '#e4e4e7',
        cursor: '#3b82f6',
        selectionBackground: 'rgba(59, 130, 246, 0.3)',
      },
      fontSize: 12,
      fontFamily: 'var(--font-mono)',
      convertEol: true,
    });

    fitAddon.current = new FitAddon();
    term.current.loadAddon(fitAddon.current);
    term.current.open(termRef.current);
    fitAddon.current.fit();

    const handleResize = () => fitAddon.current?.fit();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      term.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (term.current && logs.length > 0) {
      // Basic approach: clear and re-write
      // In a real shell we'd stream, but for log display we can append
      const last = logs[logs.length - 1];
      term.current.writeln(last);
      term.current.scrollToBottom();
    }
  }, [logs]);

  return (
    <div 
      ref={termRef} 
      className="pro-terminal-container"
      style={{ height: '100%', width: '100%', background: '#09090b', padding: '10px' }}
    />
  );
}
