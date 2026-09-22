export type AccountStatus = "active" | "idle" | "disabled" | "error";

export type AccountTier = "free" | "plus" | "pro" | "ultra" | "unknown";

export type AccountHealth = "healthy" | "expired" | "tos_required" | "error";

export type ModelAffinity = "all" | "gemini" | "claude";

export type PoolRole = "primary" | "reserve";

export interface Account {
  id: string;
  email: string;
  alias?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt: number;
  tier: AccountTier;
  status: AccountStatus;
  health?: AccountHealth;
  healthError?: string;
  sortOrder: number;
  affinity?: ModelAffinity;
  role?: PoolRole;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BurnRateInfo {
  tokensPerMin: number;
  recentTurns: number;
  estMinutesToExhaustion?: number;
}

export interface EncryptedPoolExport {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: number;
}

export interface DecryptedPoolData {
  accounts: Account[];
  secrets: Record<string, OAuthTokens>;
  exportedAt: number;
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

export type RotationStrategy = "auto_highest" | "cache_optimized" | "round_robin";

export interface OpenAGConfig {
  enabled: boolean;
  hideEmail?: boolean;
  rotationStrategy?: RotationStrategy;
  endpointOverride?: string;
  pollIntervalSeconds?: number;
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
  thinkingTokens?: number;
  contentTokens?: number;
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
  cacheMissTokens?: number;
  thinkingTokens?: number;
  contentTokens?: number;
  totalTokens: number;
}

export interface ConversationStats extends TokenBucket {
  id: string;
  title: string;
  workspace: string;
  model: string;
  models?: Record<string, TokenBucket>;
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

export interface EffectiveQuota {
  percent: number;
  resetTs: number;
}

declare global {
  var __PKG_VERSION__: string | undefined;
}

export const EXTENSION_VERSION = globalThis.__PKG_VERSION__ ?? "1.0.0";

export enum OpenAGErrorCode {
  AUTH_INVALID_GRANT = "AUTH_INVALID_GRANT",
  AUTH_TOS_REQUIRED = "AUTH_TOS_REQUIRED",
  AUTH_TOKEN_EXPIRED = "AUTH_TOKEN_EXPIRED",
  AUTH_CREDENTIALS_MISSING = "AUTH_CREDENTIALS_MISSING",
  AUTH_INVALID_PASSPHRASE = "AUTH_INVALID_PASSPHRASE",
  AUTH_CORRUPTED_POOL = "AUTH_CORRUPTED_POOL",
  PATCHER_INSTALL_NOT_FOUND = "PATCHER_INSTALL_NOT_FOUND",
  PATCHER_WRITE_FAILED = "PATCHER_WRITE_FAILED",
  PATCHER_PATTERN_MISMATCH = "PATCHER_PATTERN_MISMATCH",
  DATABASE_READ_ERROR = "DATABASE_READ_ERROR",
  QUOTA_FETCH_FAILED = "QUOTA_FETCH_FAILED",
  QUOTA_EXHAUSTED = "QUOTA_EXHAUSTED",
  NETWORK_TIMEOUT = "NETWORK_TIMEOUT",
  NETWORK_ERROR = "NETWORK_ERROR",
}

export class OpenAGError extends Error {
  public readonly code: OpenAGErrorCode;
  public override readonly cause?: unknown;

  constructor(message: string, code: OpenAGErrorCode, cause?: unknown) {
    super(message);
    this.name = "OpenAGError";
    this.code = code;
    this.cause = cause;
  }
}

export class AuthError extends OpenAGError {
  constructor(message: string, code: OpenAGErrorCode, cause?: unknown) {
    super(message, code, cause);
    this.name = "AuthError";
  }
}

export class PatcherError extends OpenAGError {
  constructor(message: string, code: OpenAGErrorCode, cause?: unknown) {
    super(message, code, cause);
    this.name = "PatcherError";
  }
}

export class DatabaseError extends OpenAGError {
  constructor(message: string, code: OpenAGErrorCode, cause?: unknown) {
    super(message, code, cause);
    this.name = "DatabaseError";
  }
}

export class QuotaError extends OpenAGError {
  constructor(message: string, code: OpenAGErrorCode, cause?: unknown) {
    super(message, code, cause);
    this.name = "QuotaError";
  }
}

