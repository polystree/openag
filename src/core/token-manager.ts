import * as crypto from "node:crypto";
import * as vscode from "vscode";
import {
  type Account,
  type AccountQuota,
  type AccountStatus,
  type AccountTier,
  AuthError,
  type AutoSelectOptions,
  type BindingWindow,
  type BurnRateInfo,
  type EffectiveQuota,
  type FamilyQuota,
  type ModelAffinity,
  type OAuthTokens,
  type OpenAGConfig,
  OpenAGErrorCode,
  type PoolRole,
  type RotationStrategy,
} from "../types.js";
import { OAuthFlow } from "./oauth-flow.js";
import { exportPool, importPool } from "./pool-crypto.js";
import { FALLBACK_ENDPOINT, PRIMARY_ENDPOINT, type QuotaMonitor } from "./quota-monitor.js";
import { getCodeAssistBody, getUserAgent } from "./sqlite-utils.js";
import type { StatsManager } from "./stats-manager.js";
import type { UsageTracker } from "./usage-tracker.js";
import { USSBridge } from "./uss-bridge.js";
import { LanguageServerClient } from "./language-server-client.js";

const KEY_ACCOUNTS = "openag.accounts.v1";
const KEY_ACTIVE = "openag.active_account.v1";
const KEY_CONFIG = "openag.config.v1";

function resolveModelFamily(modelName?: string): "gemini" | "claude" | "argon" | "other" {
  if (!modelName) return "other";
  const lower = modelName.toLowerCase();
  if (lower.includes("argon")) {
    return "argon";
  }
  if (
    lower.includes("claude") ||
    lower.includes("sonnet") ||
    lower.includes("opus") ||
    lower.includes("haiku") ||
    lower.includes("gpt") ||
    lower.includes("oss")
  ) {
    return "claude";
  }
  if (lower.includes("gemini")) {
    return "gemini";
  }
  return "other";
}

export const HYSTERESIS_DELTA = 15;
export const DRAIN_WINDOW_MS = 30 * 60 * 1000;
export const IMMINENT_RESET_MS = 45 * 60 * 1000;

export function calculateEffectiveQuota(fam: FamilyQuota): EffectiveQuota {
  const p5h = fam.limit5h?.percent ?? fam.percent ?? 100;
  const pWk = fam.limitWeekly?.percent ?? 100;

  const t5hStr = fam.limit5h?.resetTime ?? fam.resetTime;
  const tWkStr = fam.limitWeekly?.resetTime;

  const t5h = t5hStr ? Date.parse(t5hStr) : Infinity;
  const validT5h = Number.isNaN(t5h) ? Infinity : t5h;

  const tWk = tWkStr ? Date.parse(tWkStr) : Infinity;
  const validTWk = Number.isNaN(tWk) ? Infinity : tWk;

  let percent: number;
  let resetTs: number;
  let bindingWindow: BindingWindow;

  if (pWk <= 0) {
    percent = 0;
    if (p5h < pWk) {
      bindingWindow = "5h";
      resetTs = validT5h;
    } else if (pWk < p5h) {
      bindingWindow = "weekly";
      resetTs = validTWk;
    } else {
      bindingWindow = "both";
      resetTs = Math.min(validT5h, validTWk);
    }
  } else if (p5h < pWk) {
    percent = Math.max(0, p5h);
    bindingWindow = "5h";
    resetTs = validT5h;
  } else if (pWk < p5h) {
    percent = Math.max(0, pWk);
    bindingWindow = "weekly";
    resetTs = validTWk;
  } else {
    percent = Math.max(0, p5h);
    bindingWindow = "both";
    resetTs = Math.min(validT5h, validTWk);
  }

  return {
    percent,
    resetTs,
    bindingWindow,
  };
}

function matchesModelAffinity(account: Account, modelFamily: "gemini" | "claude" | "argon" | "other"): boolean {
  if (!account.affinity || account.affinity === "all" || modelFamily === "other") return true;
  return account.affinity === modelFamily;
}

export class TokenManager {
  private accounts: Account[] = [];
  private activeEmail = "";
  private config: OpenAGConfig = { enabled: true };
  private readonly refreshPromises = new Map<string, Promise<string>>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly onAccountChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onAccountChange = this.onAccountChangeEmitter.event;
  private lastSyncedToken: string | null = null;
  private lastSyncedEmail: string | null = null;
  private selectAccountLock: Promise<void> = Promise.resolve();
  private lsClient?: LanguageServerClient;
  private statsManager?: StatsManager;
  private quotaMonitor?: QuotaMonitor;
  private lastAutoSelectTime = 0;
  private static readonly AUTO_SELECT_THROTTLE_MS = 3_000;
  private lastAccountSwitchTime = 0;
  private static readonly MIN_ROTATION_INTERVAL_MS = 30_000;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void,
    private readonly usageTracker?: UsageTracker,
    statsManager?: StatsManager,
  ) {
    this.statsManager = statsManager;
  }

  public setLanguageServerClient(client: LanguageServerClient): void {
    this.lsClient = client;
  }

  public setStatsManager(statsManager: StatsManager): void {
    this.statsManager = statsManager;
  }

  public setQuotaMonitor(quotaMonitor: QuotaMonitor): void {
    this.quotaMonitor = quotaMonitor;
  }

  public markAccountExhausted(email: string, model?: string, cooldownMs?: number): void {
    this.quotaMonitor?.markAccountExhausted(email, model, cooldownMs);
  }

  public async restoreAccountStatus(email: string): Promise<Account | null> {
    const acc = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!acc) return null;
    if (acc.status === "error") {
      acc.status = this.activeEmail.toLowerCase() === email.toLowerCase() ? "active" : "idle";
      acc.updatedAt = Date.now();
      await this.persist();
      this.onAccountChangeEmitter.fire();
    }
    return acc;
  }

  public getBurnRate(windowMinutes = 15): BurnRateInfo | null {
    if (this.statsManager && typeof this.statsManager.getBurnRate === "function") {
      return this.statsManager.getBurnRate(windowMinutes);
    }
    if (this.usageTracker) {
      const sm = (this.usageTracker as unknown as { statsManager?: StatsManager }).statsManager;
      if (sm && typeof sm.getBurnRate === "function") {
        return sm.getBurnRate(windowMinutes);
      }
    }
    return null;
  }

  public async initialize(): Promise<void> {
    this.accounts = this.context.globalState.get<Account[]>(KEY_ACCOUNTS, []);
    this.activeEmail = this.context.globalState.get<string>(KEY_ACTIVE, "");
    this.config = this.context.globalState.get<OpenAGConfig>(KEY_CONFIG, this.config);
    this.loadVscodeSettings();

    for (const acc of this.accounts) {
      const key = this.getSecretKey(acc.email);
      const stored = await this.context.secrets.get(key);
      if (acc.refreshToken || acc.accessToken) {
        await this.context.secrets.store(key, JSON.stringify({ accessToken: acc.accessToken || "", refreshToken: acc.refreshToken || "", tokenExpiresAt: acc.tokenExpiresAt || 0 }));
        acc.accessToken = undefined;
        acc.refreshToken = undefined;
      } else if (stored) {
        try {
          // SAFETY: stored secret contains serialized OAuthTokens JSON
          const parsed = JSON.parse(stored) as OAuthTokens;
          acc.accessToken = parsed.accessToken;
          acc.refreshToken = parsed.refreshToken;
          acc.tokenExpiresAt = parsed.expiryDateSeconds || acc.tokenExpiresAt;
        } catch (e: unknown) {
          this.log(`[TokenManager] Corrupted secret store for ${acc.email}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    if (!this.activeEmail && this.accounts.length > 0) this.activeEmail = this.accounts[0]?.email ?? "";
    this.startRefreshLoop();
    await this.syncActiveTokenToUss();
    this.log(`TokenManager initialized with ${this.accounts.length} accounts, active: ${this.activeEmail || "none"}`);
  }

  private getSecretKey(email: string): string {
    return `openag.secret.${email.toLowerCase()}`;
  }

  public getAccounts(): Account[] {
    return [...this.accounts];
  }

  public getActiveEmail(): string {
    return this.activeEmail;
  }

  public getConfig(): OpenAGConfig {
    return { ...this.config };
  }

  public isExtensionEnabled(): boolean {
    return this.config.enabled ?? true;
  }

  public isRotationEnabled(): boolean {
    return this.config.enabled ?? true;
  }

  public loadVscodeSettings(): void {
    if (!vscode.workspace?.getConfiguration) return;
    try {
      const wsCfg = vscode.workspace.getConfiguration("openag");
      const enabled = wsCfg.get<boolean>("enabled");
      const hideEmail = wsCfg.get<boolean>("hideEmail");
      const rotationStrategy = wsCfg.get<RotationStrategy>("rotationStrategy");
      const endpointOverride = wsCfg.get<string>("endpointOverride");
      const pollIntervalSeconds = wsCfg.get<number>("pollIntervalSeconds");

      let changed = false;
      if (typeof enabled === "boolean" && enabled !== this.config.enabled) {
        this.config.enabled = enabled;
        changed = true;
      }
      if (typeof hideEmail === "boolean" && hideEmail !== this.config.hideEmail) {
        this.config.hideEmail = hideEmail;
        changed = true;
      }
      if (rotationStrategy && rotationStrategy !== this.config.rotationStrategy) {
        this.config.rotationStrategy = rotationStrategy;
        changed = true;
      }
      if (typeof endpointOverride === "string" && endpointOverride !== (this.config.endpointOverride || "")) {
        this.config.endpointOverride = endpointOverride;
        changed = true;
      }
      if (typeof pollIntervalSeconds === "number" && pollIntervalSeconds !== this.config.pollIntervalSeconds) {
        this.config.pollIntervalSeconds = pollIntervalSeconds;
        changed = true;
      }
      if (changed) {
        void this.context.globalState.update(KEY_CONFIG, this.config);
        this.onAccountChangeEmitter.fire();
      }
    } catch {
      // Configuration read error in headless/test env
    }
  }

  public async updateConfig(newConfig: Partial<OpenAGConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    await this.context.globalState.update(KEY_CONFIG, this.config);
    if (vscode.workspace?.getConfiguration) {
      try {
        const wsCfg = vscode.workspace.getConfiguration("openag");
        for (const [k, v] of Object.entries(newConfig)) {
          if (v !== undefined) {
            await wsCfg.update(k, v, vscode.ConfigurationTarget.Global);
          }
        }
      } catch {
        // Configuration write error in headless/test env
      }
    }
    this.onAccountChangeEmitter.fire();
  }

  public async addOrUpdateAccount(account: Omit<Account, "id" | "createdAt" | "updatedAt">): Promise<Account> {
    const now = Date.now();
    const idx = this.accounts.findIndex((a) => a.email.toLowerCase() === account.email.toLowerCase());
    const existing = idx >= 0 ? this.accounts[idx] : undefined;
    const accessToken = account.accessToken || existing?.accessToken || "";
    const refreshToken = account.refreshToken || existing?.refreshToken || "";
    const tokenExpiresAt = account.tokenExpiresAt || existing?.tokenExpiresAt || 0;

    const updated: Account = existing
      ? { ...existing, tier: account.tier || existing.tier || "pro", status: account.status || existing.status, affinity: account.affinity ?? existing.affinity, role: account.role ?? existing.role, tokenExpiresAt, accessToken, refreshToken, updatedAt: now }
      : { id: `acc_${now}_${crypto.randomUUID().slice(0, 8)}`, email: account.email, alias: account.alias, tier: account.tier || "pro", status: account.status || "active", affinity: account.affinity || "all", role: account.role || "primary", sortOrder: account.sortOrder ?? this.accounts.length, projectId: account.projectId, tokenExpiresAt, accessToken, refreshToken, createdAt: now, updatedAt: now };

    await this.context.secrets.store(this.getSecretKey(account.email), JSON.stringify({ accessToken, refreshToken, expiryDateSeconds: tokenExpiresAt }));
    if (idx >= 0) this.accounts[idx] = updated;
    else this.accounts.push(updated);

    if (!this.activeEmail || this.accounts.length === 1) {
      this.activeEmail = updated.email;
      await this.context.globalState.update(KEY_ACTIVE, this.activeEmail);
    }

    await this.persist();
    await this.syncActiveTokenToUss();
    this.onAccountChangeEmitter.fire();
    return updated;
  }

  public async updateAccountMeta(
    email: string,
    meta: { alias?: string; affinity?: ModelAffinity; role?: PoolRole },
  ): Promise<Account | null> {
    const acc = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!acc) return null;
    if (meta.alias !== undefined) acc.alias = meta.alias;
    if (meta.affinity !== undefined) acc.affinity = meta.affinity;
    if (meta.role !== undefined) acc.role = meta.role;
    acc.updatedAt = Date.now();
    await this.persist();
    this.onAccountChangeEmitter.fire();
    return acc;
  }

  public async reauthAccount(email: string): Promise<Account> {
    const res = await OAuthFlow.startLogin();
    const existing = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    const updated = await this.addOrUpdateAccount({
      email: res.email,
      alias: existing?.alias,
      affinity: existing?.affinity,
      role: existing?.role,
      sortOrder: existing?.sortOrder ?? this.accounts.length,
      accessToken: res.tokens.accessToken,
      refreshToken: res.tokens.refreshToken,
      tokenExpiresAt: res.tokens.expiryDateSeconds,
      status: "active",
      tier: existing?.tier || "pro",
    });
    updated.health = "healthy";
    updated.healthError = undefined;
    await this.persist();
    this.onAccountChangeEmitter.fire();
    return updated;
  }

  public async removeAccount(email: string): Promise<boolean> {
    const initialLen = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.email.toLowerCase() !== email.toLowerCase());
    if (this.accounts.length === initialLen) return false;

    await this.context.secrets.delete(this.getSecretKey(email));
    if (this.activeEmail.toLowerCase() === email.toLowerCase()) {
      const next = this.accounts.find((a) => a.status !== "disabled");
      this.activeEmail = next?.email ?? "";
      await this.context.globalState.update(KEY_ACTIVE, this.activeEmail);
    }
    await this.persist();
    await this.syncActiveTokenToUss();
    this.onAccountChangeEmitter.fire();
    return true;
  }

  public async toggleAccountEnabled(email: string, enabled?: boolean): Promise<Account | null> {
    const target = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!target) return null;

    let newStatus: AccountStatus;
    if (enabled !== undefined) {
      newStatus = enabled ? "active" : "disabled";
    } else {
      newStatus = target.status === "disabled" ? "active" : "disabled";
    }

    target.status = newStatus;
    target.updatedAt = Date.now();

    if (newStatus === "disabled" && this.activeEmail.toLowerCase() === email.toLowerCase()) {
      const next = this.accounts.find((a) => a.status !== "disabled" && a.email.toLowerCase() !== email.toLowerCase());
      this.activeEmail = next?.email ?? "";
      await this.context.globalState.update(KEY_ACTIVE, this.activeEmail);
      await this.syncActiveTokenToUss();
    } else if (newStatus === "active" && !this.activeEmail) {
      this.activeEmail = target.email;
      this.lastAccountSwitchTime = Date.now();
      await this.context.globalState.update(KEY_ACTIVE, this.activeEmail);
      await this.syncActiveTokenToUss();
    }

    await this.persist();
    this.onAccountChangeEmitter.fire();
    this.log(`Account ${email} pool status: ${newStatus}`);
    return target;
  }

  public async updateAccountTier(email: string, tier: AccountTier): Promise<void> {
    const target = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (target && target.tier !== tier) {
      target.tier = tier;
      target.updatedAt = Date.now();
      await this.persist();
      this.onAccountChangeEmitter.fire();
    }
  }

  public async selectAccount(email: string): Promise<Account | null> {
    const prevLock = this.selectAccountLock;
    let resolveLock!: () => void;
    this.selectAccountLock = new Promise<void>((r) => { resolveLock = r; });

    try {
      await prevLock.catch(() => {});
      const target = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
      if (!target || target.status === "disabled") return null;
      this.activeEmail = target.email;
      this.lastAccountSwitchTime = Date.now();
      await this.context.globalState.update(KEY_ACTIVE, this.activeEmail);
      await this.persist();
      await this.syncActiveTokenToUss();
      this.onAccountChangeEmitter.fire();
      this.log(`Active account switched to: ${this.activeEmail}`);
      return target;
    } finally {
      resolveLock();
    }
  }

  public getEffectiveQuota(fam: FamilyQuota): EffectiveQuota;
  public getEffectiveQuota(email: string, quotas: Record<string, AccountQuota>, targetModel?: string): EffectiveQuota;
  public getEffectiveQuota(
    famOrEmail: FamilyQuota | string,
    quotas?: Record<string, AccountQuota>,
    targetModel?: string,
  ): EffectiveQuota {
    if (typeof famOrEmail === "object" && famOrEmail !== null && "key" in famOrEmail) {
      return calculateEffectiveQuota(famOrEmail);
    }

    const email = typeof famOrEmail === "string" ? famOrEmail : "";
    const quotaMap = quotas || {};
    const q = quotaMap[email.toLowerCase()];
    if (!q?.families || q.families.length === 0) {
      return { percent: -1, resetTs: Infinity, bindingWindow: "both" };
    }

    const modelName = targetModel || this.usageTracker?.getActiveModel() || "";
    if (modelName) {
      if (q.models && q.models.length > 0) {
        const lowerModel = modelName.toLowerCase();
        const directModel = q.models.find((m) => m.name.toLowerCase() === lowerModel);
        if (directModel) {
          const resetTs = directModel.resetTime ? Date.parse(directModel.resetTime) : Infinity;
          return {
            percent: directModel.percent,
            resetTs: Number.isNaN(resetTs) ? Infinity : resetTs,
            bindingWindow: "both",
          };
        }
      }

      const famKey = resolveModelFamily(modelName);
      if (famKey !== "other") {
        const fam = q.families.find((f) => f.key === famKey);
        if (fam) {
          return calculateEffectiveQuota(fam);
        }
        return { percent: 0, resetTs: Infinity, bindingWindow: "both" };
      }
    }

    let minPct = 100;
    let minResetTs = Infinity;
    let bindingWindow: BindingWindow = "both";

    for (const f of q.families) {
      const eff = calculateEffectiveQuota(f);
      if (eff.percent < minPct) {
        minPct = eff.percent;
        minResetTs = eff.resetTs;
        bindingWindow = eff.bindingWindow;
      } else if (eff.percent === minPct) {
        if (eff.resetTs < minResetTs) {
          minResetTs = eff.resetTs;
          bindingWindow = eff.bindingWindow;
        }
      }
    }
    return { percent: minPct, resetTs: minResetTs, bindingWindow };
  }

  public async autoSelectHighestQuota(
    quotasOrOptions?: Record<string, AccountQuota> | AutoSelectOptions,
    reason?: string,
    targetModel?: string,
    options?: AutoSelectOptions,
  ): Promise<Account | null> {
    if (!this.isExtensionEnabled() || !this.isRotationEnabled() || this.accounts.length <= 1) return null;
    const available = this.accounts.filter((a) => a.status !== "disabled");
    if (available.length <= 1) return null;

    let quotas: Record<string, AccountQuota>;
    let resolvedReason = reason;
    let resolvedTargetModel = targetModel;
    let resolvedOptions = options;

    if (
      quotasOrOptions &&
      ("isRateLimitFailover" in quotasOrOptions ||
        "forceSwitch" in quotasOrOptions ||
        "hysteresisDelta" in quotasOrOptions ||
        "quotas" in quotasOrOptions)
    ) {
      const opt = quotasOrOptions as AutoSelectOptions;
      quotas = opt.quotas || this.quotaMonitor?.getAllQuotas() || {};
      resolvedReason = opt.reason ?? resolvedReason;
      resolvedTargetModel = opt.targetModel ?? resolvedTargetModel;
      resolvedOptions = opt;
    } else {
      quotas = (quotasOrOptions as Record<string, AccountQuota>) || this.quotaMonitor?.getAllQuotas() || {};
    }

    const model = resolvedTargetModel || this.usageTracker?.getActiveModel() || "";
    const famKey = resolveModelFamily(model);
    const now = Date.now();
    const activeEmail = this.activeEmail.toLowerCase();
    const activeAcc = this.getActiveAccount();
    const activeInfo = this.getEffectiveQuota(activeEmail, quotas, model);

    // 1. Model Affinity Filtering
    const affinityMatched = available.filter((a) => matchesModelAffinity(a, famKey));
    const pool = affinityMatched.length > 0 ? affinityMatched : available;

    // 2. Reserve Pool: Use primary accounts unless all primary accounts are exhausted (<= 10%)
    const primaryPool = pool.filter((a) => (a.role || "primary") !== "reserve");
    const hasUsablePrimary = primaryPool.some((a) => this.getEffectiveQuota(a.email, quotas, model).percent > 10);
    const candidates = hasUsablePrimary ? primaryPool : pool;

    // 3. Tier Priority: Burn Ultra / Pro / Plus accounts before touching Free tier accounts
    const paidPool = candidates.filter((a) => a.tier !== "free");
    const hasUsablePaid = paidPool.some((a) => this.getEffectiveQuota(a.email, quotas, model).percent > 10);
    const tierCandidates = hasUsablePaid ? paidPool : candidates;

    const isRateLimitFailover =
      resolvedReason === "rate_limit_failover" || resolvedOptions?.isRateLimitFailover === true;
    const forceSwitch = Boolean(resolvedOptions?.forceSwitch);
    const isTest = LanguageServerClient.isTestEnvironment();

    if (!isTest && !isRateLimitFailover && !forceSwitch && !resolvedOptions?.ignoreThrottle) {
      if (now - this.lastAutoSelectTime < TokenManager.AUTO_SELECT_THROTTLE_MS) {
        return null;
      }
    }
    this.lastAutoSelectTime = now;

    const activeMatchesAffinity = activeAcc ? matchesModelAffinity(activeAcc, famKey) : true;
    const activeIsFreeWhenPaidAvailable = activeAcc?.tier === "free" && hasUsablePaid;

    // 4. Burn-Rate Predictive Refill Coordination (F3):
    // Compare time-to-exhaustion against time-to-refill
    const timeToRefillMs = activeInfo.resetTs - now;
    const timeToRefillMinutes =
      timeToRefillMs > 0 && activeInfo.resetTs !== Infinity
        ? Math.ceil(timeToRefillMs / 60000)
        : Infinity;

    const burnRate = this.getBurnRate();
    const tokensPerMin = burnRate?.tokensPerMin ?? 0;
    const remainingTokens = Math.max(0, Math.round((activeInfo.percent / 100) * 1000000));

    if (
      !isRateLimitFailover &&
      !forceSwitch &&
      !activeIsFreeWhenPaidAvailable &&
      activeMatchesAffinity &&
      activeInfo.percent > 5 &&
      timeToRefillMs > 0 &&
      activeInfo.resetTs !== Infinity
    ) {
      if (tokensPerMin > 0) {
        const timeToExhaustionMinutes = remainingTokens / tokensPerMin;
        if (timeToExhaustionMinutes >= timeToRefillMinutes) {
          this.log(
            `[AutoRotate (Predictive Refill)] Retaining active account ${activeEmail}: exhaustion headroom (${Math.round(timeToExhaustionMinutes)}m) >= refill (${timeToRefillMinutes}m) [burn: ${tokensPerMin} tok/min, quota: ${activeInfo.percent}%]`,
          );
          return null;
        }
      } else if (timeToRefillMs <= DRAIN_WINDOW_MS) {
        // Fallback when no recent burn-rate traffic: retain if within 30-minute drain window
        this.log(
          `[AutoRotate (Drain Window)] Retaining active account ${activeEmail}: imminent reset in ${Math.round(timeToRefillMs / 60000)}m <= 30m [quota: ${activeInfo.percent}%]`,
        );
        return null;
      }
    }

    const strategy: RotationStrategy = this.config.rotationStrategy || "auto_highest";

    // 5. Strategy Dispatch
    if (strategy === "cache_optimized" && !isRateLimitFailover && !forceSwitch) {
      // Sticky Cache: Stay on active account as long as it has > 15% quota, matches affinity, and is not free when paid is available
      if (!activeIsFreeWhenPaidAvailable && activeMatchesAffinity && activeInfo.percent > 15) {
        return null;
      }
    } else if (strategy === "round_robin" && !isRateLimitFailover && !forceSwitch) {
      // Round Robin with Timing Priority: prioritize imminent refill candidate (<= 45m) if one exists
      const imminentCandidate = tierCandidates.find((a) => {
        const qInfo = this.getEffectiveQuota(a.email, quotas, model);
        const timeToReset = qInfo.resetTs - now;
        return (
          timeToReset > 0 &&
          timeToReset <= IMMINENT_RESET_MS &&
          qInfo.percent > 10 &&
          a.email.toLowerCase() !== activeEmail
        );
      });

      if (imminentCandidate) {
        const qInfo = this.getEffectiveQuota(imminentCandidate.email, quotas, model);
        this.log(
          `[AutoRotate (Round-Robin Imminent)] Prioritizing imminent refill account ${imminentCandidate.email} (${qInfo.percent}%) from ${this.activeEmail}`,
        );
        return this.selectAccount(imminentCandidate.email);
      }

      const curIdx = tierCandidates.findIndex((a) => a.email.toLowerCase() === activeEmail);
      for (let offset = 1; offset <= tierCandidates.length; offset++) {
        const nextIdx = (curIdx + offset) % tierCandidates.length;
        const candidate = tierCandidates[nextIdx];
        if (!candidate) continue;
        const qInfo = this.getEffectiveQuota(candidate.email, quotas, model);
        if (qInfo.percent > 10 && candidate.email.toLowerCase() !== activeEmail) {
          this.log(
            `[AutoRotate (Round-Robin)] Cycling to next account ${candidate.email} (${qInfo.percent}%) from ${this.activeEmail} (${activeInfo.percent}%) [model: ${model}]`,
          );
          return this.selectAccount(candidate.email);
        }
      }
      return null;
    }

    // 6. Candidate Scoring (Auto-Highest & Cache-Optimized low-quota fallback)
    let bestAcc: Account | null = null;
    let bestScore = -1;
    let bestPct = -1;
    let bestResetTs = Infinity;

    for (const acc of tierCandidates) {
      const info = this.getEffectiveQuota(acc.email, quotas, model);
      if (info.percent <= 0) continue;

      const timeToReset = info.resetTs - now;
      const isImminent = timeToReset > 0 && timeToReset <= IMMINENT_RESET_MS && info.percent > 10;
      const tierBonus = acc.tier === "ultra" ? 20 : acc.tier === "pro" ? 10 : 0;
      const score = info.percent + (isImminent ? 1000 : 0) + tierBonus;

      if (score > bestScore || (score === bestScore && info.resetTs < bestResetTs)) {
        bestAcc = acc;
        bestScore = score;
        bestPct = info.percent;
        bestResetTs = info.resetTs;
      }
    }

    const activeTimeToReset = activeInfo.resetTs - now;
    const isActiveImminent =
      activeTimeToReset > 0 && activeTimeToReset <= IMMINENT_RESET_MS && activeInfo.percent > 10;
    const activeTierBonus = activeAcc?.tier === "ultra" ? 20 : activeAcc?.tier === "pro" ? 10 : 0;
    const activeScore =
      activeMatchesAffinity && !activeIsFreeWhenPaidAvailable
        ? activeInfo.percent + (isActiveImminent ? 1000 : 0) + activeTierBonus
        : -1;

    if (!bestAcc || bestPct <= 0 || bestAcc.email.toLowerCase() === activeEmail) {
      return null;
    }

    // Anti-Flapping Hysteresis (Prompt Cache Retention - F1):
    // Retain the active account unless:
    // a) Active account is exhausted (effective quota percent <= 10%),
    // b) It is an explicit rate limit failover (isRateLimitFailover = true),
    // c) Best candidate score exceeds active account score by strictly MORE than HYSTERESIS_DELTA (bestScore - activeScore > HYSTERESIS_DELTA), or
    // d) Candidate matches model affinity when active does not.
    const hysteresisDelta = resolvedOptions?.hysteresisDelta ?? HYSTERESIS_DELTA;
    const isActiveExhausted = activeInfo.percent <= 10;
    const candidateMatchesAffinityWhenActiveDoesNot =
      !activeMatchesAffinity && matchesModelAffinity(bestAcc, famKey);

    if (
      !isActiveExhausted &&
      !isRateLimitFailover &&
      !candidateMatchesAffinityWhenActiveDoesNot &&
      !activeIsFreeWhenPaidAvailable &&
      !forceSwitch
    ) {
      if (bestScore - activeScore <= hysteresisDelta) {
        this.log(
          `[AutoRotate (Hysteresis)] Retaining active account ${this.activeEmail} (${activeInfo.percent}%, score: ${activeScore}). Best candidate ${bestAcc.email} score ${bestScore} delta ${bestScore - activeScore} <= ${hysteresisDelta}`,
        );
        return null;
      }
    } else if (!isRateLimitFailover && !isActiveExhausted && !forceSwitch && bestScore <= activeScore) {
      return null;
    }

    if (!isTest && !isRateLimitFailover && !forceSwitch && !isActiveExhausted && !resolvedOptions?.ignoreThrottle) {
      if (now - this.lastAccountSwitchTime < TokenManager.MIN_ROTATION_INTERVAL_MS) {
        return null;
      }
    }

    this.log(
      `[AutoRotate] Switching to highest-quota account ${bestAcc.email} (${bestPct}%) from ${this.activeEmail} (${activeInfo.percent}%) [model: ${model}, reason: ${resolvedReason || "auto"}]`,
    );
    return this.selectAccount(bestAcc.email);
  }

  public getActiveAccount(): Account | null {
    if (!this.activeEmail) return null;
    return this.accounts.find((a) => a.email.toLowerCase() === this.activeEmail.toLowerCase()) ?? null;
  }

  public async getValidAccessToken(account: Account): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (!account.accessToken || !account.refreshToken) {
      const stored = await this.context.secrets.get(this.getSecretKey(account.email));
      if (stored) {
        try {
          // SAFETY: stored secret contains serialized OAuthTokens JSON
          const parsed = JSON.parse(stored) as OAuthTokens;
          account.accessToken = parsed.accessToken;
          account.refreshToken = parsed.refreshToken;
          account.tokenExpiresAt = parsed.expiryDateSeconds;
        } catch (e: unknown) {
          this.log(`[TokenManager] Corrupted secret store for ${account.email}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (account.accessToken && account.tokenExpiresAt > nowSec + 60) {
      return account.accessToken;
    }
    return this.forceRefreshToken(account);
  }

  public async forceRefreshToken(account: Account): Promise<string> {
    const key = account.email.toLowerCase();
    const inflight = this.refreshPromises.get(key);
    if (inflight) return inflight;

    const task = (async () => {
      try {
        if (!account.refreshToken) {
          const stored = await this.context.secrets.get(this.getSecretKey(account.email));
          if (stored) {
            // SAFETY: stored secret contains serialized OAuthTokens JSON
            const parsed = JSON.parse(stored) as OAuthTokens;
            account.refreshToken = parsed.refreshToken;
          }
        }
        if (!account.refreshToken) throw new Error(`Account ${account.email} has no refresh token`);

        this.log(`Refreshing access token for ${account.email}...`);
        const refreshed = await this.refreshOAuthToken(account.refreshToken);
        account.accessToken = refreshed.accessToken;
        account.tokenExpiresAt = refreshed.expiryDateSeconds;
        if (refreshed.refreshToken) account.refreshToken = refreshed.refreshToken;
        account.health = "healthy";
        account.healthError = undefined;
        account.updatedAt = Date.now();

        await this.context.secrets.store(this.getSecretKey(account.email), JSON.stringify({ accessToken: account.accessToken, refreshToken: account.refreshToken, expiryDateSeconds: account.tokenExpiresAt }));
        await this.persist();
        if (account.email.toLowerCase() === this.activeEmail.toLowerCase()) await this.syncActiveTokenToUss();
        this.onAccountChangeEmitter.fire();
        return account.accessToken;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const lower = msg.toLowerCase();
        if (lower.includes("invalid_grant") || lower.includes("revoked") || lower.includes("expired")) {
          account.health = "expired";
        } else if (lower.includes("tos") || lower.includes("terms")) {
          account.health = "tos_required";
        } else {
          account.health = "error";
        }
        account.healthError = msg;
        await this.persist();
        this.onAccountChangeEmitter.fire();
        throw err;
      } finally {
        this.refreshPromises.delete(key);
      }
    })();

    this.refreshPromises.set(key, task);
    return task;
  }

  public async refreshOAuthToken(refreshToken: string): Promise<OAuthTokens> {
    const creds = USSBridge.getClientCredentials();
    const params = new URLSearchParams({ client_id: creds.clientId, grant_type: "refresh_token", refresh_token: refreshToken });
    if (creds.clientSecret) params.set("client_secret", creds.clientSecret);
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new AuthError(`Token refresh failed HTTP ${res.status}: ${await res.text()}`, OpenAGErrorCode.AUTH_TOKEN_EXPIRED);
    // SAFETY: Google OAuth token endpoint response payload
    const data = (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; token_type?: string };
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiryDateSeconds: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
      tokenType: data.token_type || "Bearer",
    };
  }

  public async syncActiveTokenToUss(force = false): Promise<void> {
    if (!this.isExtensionEnabled()) return;
    const active = this.getActiveAccount();
    if (!active) return;
    try {
      const token = await this.getValidAccessToken(active);
      if (!force && this.lastSyncedEmail === active.email && this.lastSyncedToken === token) {
        return;
      }
      const isAccountSwitch = Boolean(this.lastSyncedEmail && this.lastSyncedEmail.toLowerCase() !== active.email.toLowerCase());
      this.lastSyncedEmail = active.email;
      this.lastSyncedToken = token;
      await USSBridge.setOAuthToken({
        accessToken: token,
        refreshToken: active.refreshToken || "",
        expiryDateSeconds: active.tokenExpiresAt,
        tokenType: "Bearer",
        isGcpTos: false,
      }, active.email);

      if (isAccountSwitch && this.lsClient) {
        this.log(`[LS] Account changed to ${active.email}, restarting language server to reload credentials...`);
        void this.lsClient.restartServer().then((ok) => {
          if (ok) {
            this.log(`[LS] Language server restarted successfully with account ${active.email}`);
          }
        });
      }
      void (async () => {
        try {
          const override = this.config.endpointOverride?.trim();
          const primary = override || PRIMARY_ENDPOINT;
          const fallback = override ? null : FALLBACK_ENDPOINT;
          const headers = {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": getUserAgent(),
          };
          const body = getCodeAssistBody();
          let res = await fetch(`${primary}/v1internal:loadCodeAssist`, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(10000),
          }).catch(() => null);

          if ((!res || (!res.ok && (res.status === 404 || res.status === 403 || res.status >= 500))) && fallback) {
            res = await fetch(`${fallback}/v1internal:loadCodeAssist`, {
              method: "POST",
              headers,
              body,
              signal: AbortSignal.timeout(10000),
            }).catch(() => null);
          }
        } catch (fetchErr: unknown) {
          this.log(`[USS] Code assist pre-warm failed: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
        }
      })();
    } catch (e: unknown) {
      this.log(`[USS] Failed to sync token to USS: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private startRefreshLoop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => void this.checkAndRefreshAll(), 300000);
  }

  private async checkAndRefreshAll(): Promise<void> {
    if (!this.isExtensionEnabled()) return;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const acc of this.accounts) {
      if (acc.status !== "disabled" && acc.tokenExpiresAt <= nowSec + 300) {
        try {
          await this.getValidAccessToken(acc);
        } catch (e: unknown) {
          this.log(`Background refresh failed for ${acc.email}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }

  private async persist(): Promise<void> {
    const metadataList = this.accounts.map(({ accessToken: _a, refreshToken: _r, ...rest }) => rest);
    await this.context.globalState.update(KEY_ACCOUNTS, metadataList);
  }

  public async exportAllAccounts(passphrase: string): Promise<string> {
    const secrets: Record<string, OAuthTokens> = {};
    for (const acc of this.accounts) {
      const stored = await this.context.secrets.get(this.getSecretKey(acc.email));
      if (stored) {
        try {
          // SAFETY: stored secret contains serialized OAuthTokens JSON
          secrets[acc.email.toLowerCase()] = JSON.parse(stored) as OAuthTokens;
        } catch { /* ignore parse error */ }
      } else if (acc.accessToken || acc.refreshToken) {
        secrets[acc.email.toLowerCase()] = {
          accessToken: acc.accessToken || "",
          refreshToken: acc.refreshToken || "",
          expiryDateSeconds: acc.tokenExpiresAt || 0,
        };
      }
    }
    return exportPool(this.accounts, secrets, passphrase);
  }

  public async importAccounts(serializedJson: string, passphrase: string): Promise<number> {
    const data = await importPool(serializedJson, passphrase);
    let imported = 0;
    for (const acc of data.accounts) {
      const sec = data.secrets[acc.email.toLowerCase()];
      await this.addOrUpdateAccount({
        email: acc.email,
        alias: acc.alias,
        tier: acc.tier || "pro",
        status: acc.status || "active",
        affinity: acc.affinity || "all",
        role: acc.role || "primary",
        sortOrder: acc.sortOrder ?? this.accounts.length,
        projectId: acc.projectId,
        accessToken: sec?.accessToken || acc.accessToken || "",
        refreshToken: sec?.refreshToken || acc.refreshToken || "",
        tokenExpiresAt: sec?.expiryDateSeconds || acc.tokenExpiresAt || 0,
      });
      imported++;
    }
    return imported;
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.onAccountChangeEmitter.dispose();
  }
}

