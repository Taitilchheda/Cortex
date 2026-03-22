export interface Session {
  id: string;
  type: 'chat' | 'build' | 'refactor';
  title: string;
  created_at: number;
  updated_at?: number;
  file_count: number;
  project_path?: string;
  token_usage?: TokenUsage;
  pinned?: boolean;
}

export interface TokenUsage {
  total_prompt: number;
  total_completion: number;
  total_tokens: number;
  by_model?: Record<string, { prompt: number; completion: number }>;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  mode?: string;
  model?: string;
  isStreaming?: boolean;
  isError?: boolean;
  latency?: number;
  tokens?: number;
  attachments?: FileAttachment[];
}

export interface FileAttachment {
  name: string;
  mime?: string;
  is_image: boolean;
  size?: number;
  content?: string;
  data?: string;
}

export interface BuildEvent {
  type: string;
  [key: string]: any;
}

export type AgentMode = 'chat' | 'build' | 'refactor';
export type ChatRole = 'coder' | 'architect' | 'debug' | 'quick' | 'explain' | 'review';

export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
  modified?: number;
  children?: FileNode[];
}

export interface AgentSettings {
  auto_approve: string;
  max_files: number;
  max_retries: number;
  self_heal_count: number;
  review_on_build: boolean;
  test_on_build: boolean;
  context_limit: number;
}

export interface Notification {
  id: number;
  title: string;
  body: string;
  level: 'info' | 'success' | 'warning' | 'error';
  timestamp: number;
  read: boolean;
}
