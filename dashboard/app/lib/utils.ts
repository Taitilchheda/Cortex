// Mission Control — Utilities
// Markdown parser, syntax highlight helper, uid generator

let uidCounter = 0;

export function uid(): string {
  return `mc-${Date.now()}-${++uidCounter}`;
}

export function formatTimestamp(ts: number): string {
  const date = new Date(ts * 1000);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

// ─── Markdown / Code Parsing ────────────────────────────────────
interface CodeBlock {
  language: string;
  code: string;
}

export function extractCodeBlocks(text: string): { parts: (string | CodeBlock)[]; } {
  const parts: (string | CodeBlock)[] = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Text before code block
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push({
      language: match[1] || 'text',
      code: match[2].trimEnd(),
    });
    lastIndex = regex.lastIndex;
  }

  // Remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return { parts };
}

export function detectLanguage(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescript',
    jsx: 'javascript', html: 'html', css: 'css', json: 'json',
    md: 'markdown', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    sql: 'sql', sh: 'bash', bat: 'batch', rs: 'rust',
    go: 'go', java: 'java', cpp: 'cpp', c: 'c',
  };
  return map[ext] || 'text';
}

export function getSessionIcon(type: string): string {
  switch (type) {
    case 'build': return '⚡';
    case 'refactor': return '🔧';
    case 'chat': return '💬';
    default: return '📝';
  }
}

export function getSessionColor(type: string): string {
  switch (type) {
    case 'build': return 'var(--accent-yellow)';
    case 'refactor': return 'var(--accent-orange)';
    case 'chat': return 'var(--accent-purple)';
    default: return 'var(--text-secondary)';
  }
}
