'use client';
import { Editor } from '@monaco-editor/react';
import { useTheme } from 'next-themes';

interface CodeEditorProps {
  value: string;
  language?: string;
  path?: string;
  readOnly?: boolean;
}

export default function CodeEditor({ value, language, path, readOnly = true }: CodeEditorProps) {
  const { theme } = useTheme();

  // Map file extensions to Monaco languages
  const getLanguage = () => {
    if (language) return language;
    if (!path) return 'plaintext';
    const ext = path.split('.').pop()?.toLowerCase();
    const map: Record<string, string> = {
      'py': 'python',
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'html': 'html',
      'css': 'css',
      'json': 'json',
      'md': 'markdown',
      'txt': 'plaintext',
      'sh': 'shell',
      'bat': 'bat',
      'yaml': 'yaml',
      'yml': 'yaml',
    };
    return map[ext!] || 'plaintext';
  };

  return (
    <div className="pro-code-editor-container">
      <Editor
        height="100%"
        language={getLanguage()}
        value={value}
        theme={theme === 'dark' ? 'vs-dark' : 'light'}
        options={{
          readOnly,
          minimap: { enabled: true },
          fontSize: 13,
          fontFamily: 'var(--font-mono)',
          scrollbar: {
            vertical: 'visible',
            horizontal: 'visible',
            useShadows: false,
            verticalSliderSize: 4,
            horizontalSliderSize: 4,
          },
          lineNumbers: 'on',
          renderLineHighlight: 'all',
          cursorStyle: 'line',
          automaticLayout: true,
          padding: { top: 16, bottom: 16 },
          roundedSelection: true,
          scrollBeyondLastLine: false,
          fixedOverflowWidgets: true,
        }}
      />
    </div>
  );
}
