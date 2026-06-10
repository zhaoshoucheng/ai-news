/**
 * AI Model Monitor - 类型定义
 */

// ── 配置相关 ──────────────────────────────────────────────────────

export interface SourceConfig {
  providers: ProviderConfig[];
  settings: Settings;
}

export interface ProviderConfig {
  id: string;
  name: string;
  rss: string[];
  api_endpoints: ApiEndpoint[];
  changelog_urls: string[];
}

export interface ApiEndpoint {
  name: string;
  url: string;
  auth_env: string;
  description: string;
}

export interface Settings {
  fetch_window_hours: number;
  similarity_threshold: number;
  slack_channel_id: string;
}

// ── 模型快照相关 ──────────────────────────────────────────────────

export interface ModelSnapshot {
  provider: string;
  fetched_at: string;
  models: ModelInfo[];
}

export interface ModelInfo {
  id: string;
  name?: string;
  created?: number;
  owned_by?: string;
  context_window?: number;
  max_output_tokens?: number;
  pricing?: {
    input_per_million?: number;
    output_per_million?: number;
  };
  capabilities?: string[];
  [key: string]: unknown;
}

// ── 变更检测相关 ──────────────────────────────────────────────────

export interface ChangeDetectionResult {
  provider: string;
  detected_at: string;
  has_changes: boolean;
  new_models: ModelInfo[];
  removed_models: ModelInfo[];
  changed_models: ModelChange[];
  rss_updates: RssItem[];
}

export interface ModelChange {
  model_id: string;
  changes: FieldChange[];
}

export interface FieldChange {
  field: string;
  old_value: unknown;
  new_value: unknown;
}

// ── RSS 相关 ──────────────────────────────────────────────────────

export interface RssItem {
  title: string;
  url: string;
  published_at?: string;
  summary?: string;
  source: string;
}

// ── 报告相关 ──────────────────────────────────────────────────────

export interface DailyReport {
  date: string;
  has_changes: boolean;
  changes: ChangeDetectionResult[];
  summary: string;
}

export interface WeeklyReport {
  week_start: string;
  week_end: string;
  generated_at: string;
  daily_reports: DailyReport[];
  summary: string;
}
