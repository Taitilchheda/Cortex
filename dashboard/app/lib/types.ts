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
  routerDecision?: {
    requested_mode?: string;
    resolved_mode?: string;
    confidence?: number;
    fallback_applied?: boolean;
    reason?: string;
    matched_keywords?: string[];
    support_roles?: string[];
    quality_tier?: 'fast' | 'balanced' | 'high';
    latency_budget_ms?: number;
    auto_escalated?: boolean;
  };
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
export type ChatRole = 'auto' | 'coder' | 'architect' | 'debug' | 'quick' | 'explain' | 'review';

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
  local_only?: boolean;
  protected_paths?: string[];
}

export interface ToolRegistryItem {
  key: string;
  name: string;
  enabled: boolean;
}

export interface QueueTask {
  id: string;
  task: string;
  mode: string;
  project_path?: string;
  status: string;
  created_at: number;
}

export interface Notification {
  id: number;
  title: string;
  body: string;
  level: 'info' | 'success' | 'warning' | 'error';
  timestamp: number;
  read: boolean;
}

export interface UnifiedModel {
  id: string;
  name: string;
  source: string;
  provider: string;
  size_bytes?: number | null;
  size_gb?: number | null;
  vram_gb?: number | null;
  context_length?: number | null;
  pricing?: Record<string, unknown>;
  benchmarks?: {
    humaneval?: number | null;
    mbpp?: number | null;
  };
  rank?: string | null;
  specialty?: string | null;
  details?: Record<string, unknown>;
}

export interface HardwareStats {
  ts?: number;
  timestamp?: number;
  cpu?: {
    percent?: number;
    utilization_pct?: number;
    logical_cores?: number;
  };
  ram?: {
    used_mb?: number;
    total_mb?: number;
    utilization_pct?: number;
  };
  memory?: {
    total_gb?: number;
    used_gb?: number;
    percent?: number;
  };
  gpu?: {
    available?: boolean;
    device_count?: number;
    names?: string[];
    note?: string;
    utilization_pct?: number;
  };
}

export interface RouterMetrics {
  total: number;
  auto: number;
  manual: number;
  fallbacks: number;
  avg_confidence: number;
  by_role: Record<string, number>;
  specialist_consults: number;
  specialist_success: number;
  specialist_timeouts: number;
  specialist_hit_rate: number;
  avg_specialist_latency_ms: number;
  decompositions: number;
  auto_escalations: number;
  approval_blocks: number;
  quality_feedback: { up: number; down: number };
  confidence_threshold: number;
}
