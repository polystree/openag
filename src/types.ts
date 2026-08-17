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
}

declare const __PKG_VERSION__: string | undefined;
export const EXTENSION_VERSION = typeof __PKG_VERSION__ !== "undefined" ? __PKG_VERSION__ : "1.0.0";
