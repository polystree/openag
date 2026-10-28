import { mock } from "bun:test";
import { mockVscode, createMockExtensionContext } from "../mocks/vscode.js";

// Ensure vscode is mocked globally before imports
mock.module("vscode", () => mockVscode);

import type { Account, AccountQuota, AccountTier, FamilyQuota, OpenAGConfig } from "../../src/types.js";
import { TokenManager } from "../../src/core/token-manager.js";
import { QuotaMonitor } from "../../src/core/quota-monitor.js";

export function createTestAccount(overrides: Partial<Account> = {}): Account {
  const email = overrides.email || `user-${Math.random().toString(36).substring(7)}@gmail.com`;
  return {
    id: overrides.id || `acc-${Math.random().toString(36).substring(7)}`,
    email,
    alias: overrides.alias || email.split("@")[0],
    tier: overrides.tier || "pro",
    status: overrides.status || "active",
    health: overrides.health || "healthy",
    tokenExpiresAt: overrides.tokenExpiresAt || Math.floor(Date.now() / 1000) + 3600,
    sortOrder: overrides.sortOrder ?? 0,
    createdAt: overrides.createdAt || Date.now(),
    updatedAt: overrides.updatedAt || Date.now(),
    role: overrides.role || "primary",
    affinity: overrides.affinity || "all",
    ...overrides,
  };
}

export function createFamilyQuota(
  key: "gemini" | "claude",
  percent: number,
  limit5hPercent?: number,
  limit5hResetTime?: string,
  limitWeeklyPercent?: number,
  limitWeeklyResetTime?: string,
): FamilyQuota {
  return {
    key,
    label: key === "gemini" ? "Gemini Models" : "Claude Models",
    percent,
    resetTime: limit5hResetTime,
    limit5h: {
      percent: limit5hPercent ?? percent,
      resetTime: limit5hResetTime,
    },
    limitWeekly: {
      percent: limitWeeklyPercent ?? percent,
      resetTime: limitWeeklyResetTime,
    },
  };
}

export function createAccountQuota(
  email: string,
  families: FamilyQuota[],
  tier: AccountTier = "pro",
): AccountQuota {
  return {
    email: email.toLowerCase(),
    tier,
    families,
    models: [],
    lastUpdated: Date.now(),
  };
}

export async function setupTestTokenManager(options: {
  accounts?: Account[];
  activeEmail?: string;
  config?: Partial<OpenAGConfig>;
} = {}): Promise<{
  tokenManager: TokenManager;
  context: ReturnType<typeof createMockExtensionContext>;
  logs: string[];
}> {
  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);

  const initialGlobalState: Record<string, any> = {};
  if (options.accounts) {
    initialGlobalState["openag.accounts.v1"] = options.accounts;
  }
  if (options.activeEmail) {
    initialGlobalState["openag.active_account.v1"] = options.activeEmail;
  }
  if (options.config) {
    initialGlobalState["openag.config.v1"] = {
      enabled: true,
      rotationStrategy: "auto_highest",
      ...options.config,
    };
  }

  const context = createMockExtensionContext({
    globalState: initialGlobalState,
  });

  const tokenManager = new TokenManager(context as any, log);
  await tokenManager.initialize();

  const cfg = initialGlobalState["openag.config.v1"] || { enabled: true, hideEmail: false };
  (tokenManager as any).getConfig = () => cfg;

  return { tokenManager, context, logs };
}

export function setupTestQuotaMonitor(
  tokenManager: TokenManager,
  context: any,
  onQuotaUpdate?: (q: AccountQuota) => void,
): {
  quotaMonitor: QuotaMonitor;
  logs: string[];
} {
  const logs: string[] = [];
  const log = (msg: string) => logs.push(msg);
  const quotaMonitor = new QuotaMonitor(tokenManager, log, onQuotaUpdate, undefined, context);
  return { quotaMonitor, logs };
}
