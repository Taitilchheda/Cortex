'use client';
import { useMemo } from 'react';
import { Box, Code, FunctionSquare, Layout, Type } from 'lucide-react';

interface Symbol {
  name: string;
  type: 'class' | 'function' | 'variable' | 'interface';
  line: number;
}

interface CodeOutlineProps {
  code: string;
  language: string;
  onSelectSymbol?: (line: number) => void;
}

export default function CodeOutline({ code, language, onSelectSymbol }: CodeOutlineProps) {
  const symbols = useMemo(() => {
    const syms: Symbol[] = [];
    const lines = code.split('\n');
    
    // Simple regex matching based on language
    const patterns: Record<string, { regex: RegExp; type: any }[]> = {
      'python': [
        { regex: /^\s*class\s+([A-Za-z0-9_]+)/, type: 'class' },
        { regex: /^\s*def\s+([A-Za-z0-9_]+)/, type: 'function' }
      ],
      'typescript': [
        { regex: /^\s*export\s+class\s+([A-Za-z0-9_]+)/, type: 'class' },
        { regex: /^\s*class\s+([A-Za-z0-9_]+)/, type: 'class' },
        { regex: /^\s*export\s+function\s+([A-Za-z0-9_]+)/, type: 'function' },
        { regex: /^\s*function\s+([A-Za-z0-9_]+)/, type: 'function' },
        { regex: /^\s*export\s+interface\s+([A-Za-z0-9_]+)/, type: 'interface' },
        { regex: /^\s*(?:const|let|var)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(/, type: 'function' }
      ]
    };
    
    // Default to JS/TS patterns if not matched
    const activePatterns = patterns[language] || patterns['typescript'];
    
    lines.forEach((line, idx) => {
      for (const p of activePatterns) {
        const match = line.match(p.regex);
        if (match) {
          syms.push({ name: match[1], type: p.type, line: idx + 1 });
          break;
        }
      }
    });
    
    return syms;
  }, [code, language]);

  const getIcon = (type: any) => {
    if (type === 'class') return <Box size={14} className="icon-blue" />;
    if (type === 'function') return <FunctionSquare size={14} className="icon-violet" />;
    if (type === 'interface') return <Layout size={14} className="icon-amber" />;
    return <Type size={14} className="icon-green" />;
  };

  if (!code) return <div className="empty-state">No file open</div>;
  if (symbols.length === 0) return <div className="empty-state">No symbols found</div>;

  return (
    <div className="outline-list">
      {symbols.map((s, idx) => (
        <div 
          key={idx} 
          className="outline-item" 
          onClick={() => onSelectSymbol?.(s.line)}
        >
          {getIcon(s.type)}
          <span className="outline-name">{s.name}</span>
          <span className="outline-line">L{s.line}</span>
        </div>
      ))}
    </div>
  );
}
