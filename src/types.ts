export type AccountStatus = "active" | "idle" | "disabled" | "error";

export type AccountTier = "free" | "plus" | "pro" | "ultra" | "unknown";

export interface Account {
  id: string;
  email: string;
  alias?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt: number;
  tier: AccountTier;
  status: AccountStatus;
  sortOrder: number;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ModelQuota {
  name: string;
  family: "gemini" | "claude" | "other";
  percent: number;
  resetTime?: string;
}

export interface QuotaLimitInfo {
  percent: number;
  resetTime?: string;
}

export interface FamilyQuota {
  key: "gemini" | "claude";
  label: string;
  percent: number;
  resetTime?: string;
  limit5h?: QuotaLimitInfo;
  limitWeekly?: QuotaLimitInfo;
}

export interface AccountQuota {
  email: string;
  tier: AccountTier;
  families: FamilyQuota[];
  models: ModelQuota[];
  lastUpdated: number;
}

export interface OpenAGConfig {
  enabled: boolean;
  hideEmail?: boolean;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: "info" | "warn" | "error" | "rotate";
  category: "USS" | "ROTATION" | "AUTH" | "QUOTA" | "SYSTEM";
  message: string;
  details?: string;
}

export interface ContextUsage {
  current: number;
  limit: number;
  model: string;
  percent: number;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiryDateSeconds: number;
  tokenType?: string;
  isGcpTos?: boolean;
}

export interface PatchItem {
  id: string;
  name: string;
  description: string;
  isPatched: boolean;
  canApply: boolean;
  warning?: string;
}

export interface PatcherStatus {
  supported: boolean;
  appRoot: string | null;
  version: string;
  error?: string;
  patches: PatchItem[];
}

export interface TokenBucket {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  totalTokens: number;
}

export interface RequestStats {
  id: string;
  timestamp: number;
  promptPreview: string;
  model: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  totalTokens: number;
}

export interface ConversationStats extends TokenBucket {
  id: string;
  title: string;
  workspace: string;
  model: string;
  turnCount: number;
  lastActive: number;
}

export interface HourlyTokenStats extends TokenBucket {
  hourLabel: string;
  hour: number;
  models: Record<string, TokenBucket>;
}

export interface DayTokenStats extends TokenBucket {
  date: string; // "YYYY-MM-DD"
  models: Record<string, TokenBucket>;
  conversations: Record<string, TokenBucket>;
}

export interface WeekTokenStats extends TokenBucket {
  weekLabel: string;
  startDate: string;
  endDate: string;
  models: Record<string, TokenBucket>;
}

export interface MonthTokenStats extends TokenBucket {
  monthLabel: string;
  startDate: string;
  endDate: string;
  models: Record<string, TokenBucket>;
}

export interface TokenStatsRegistry {
  days: Record<string, DayTokenStats>;
  conversations: Record<string, ConversationStats>;
  requests: RequestStats[];
  lastUpdated: number;
}

declare const __PKG_VERSION__: string | undefined;
export const EXTENSION_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "1.0.0";
