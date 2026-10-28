import type * as vscode from "vscode";
import type { Account, AccountQuota, AccountTier, FamilyQuota, ModelQuota, QuotaLimitInfo } from "../types.js";
import { LanguageServerClient } from "./language-server-client.js";
import { getCodeAssistBody, getUserAgent } from "./sqlite-utils.js";
import type { TokenManager } from "./token-manager.js";
import type { UsageTracker } from "./usage-tracker.js";

export const PRIMARY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
export const FALLBACK_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const KEY_QUOTA_CACHE = "openag.quota_cache.v1";

interface QuotaBucket {
  bucketId?: string;
  displayName?: string;
  description?: string;
  window?: string;
  resetTime?: string;
  remainingFraction?: number;
  remaining_fraction?: number;
  remaining?: {
    case?: string;
    value?: number;
    remainingFraction?: number;
  };
  fraction?: number;
}

interface QuotaGroup {
  displayName?: string;
  description?: string;
  buckets?: QuotaBucket[];
}

interface QuotaResponse {
  groups?: QuotaGroup[];
  buckets?: QuotaBucket[];
  description?: string;
  models?: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>;
}

export function extractRemainingFraction(b: QuotaBucket): number {
  if (typeof b.remainingFraction === "number") return b.remainingFraction;
  if (typeof (b as { remaining_fraction?: number }).remaining_fraction === "number") {
    return (b as { remaining_fraction?: number }).remaining_fraction!;
  }
  const rem = b.remaining;
  if (rem) {
    if (rem.case === "remainingFraction" && typeof rem.value === "number") return rem.value;
    if (typeof rem.remainingFraction === "number") return rem.remainingFraction;
    if (typeof rem.value === "number") return rem.value;
  }
  if (typeof b.fraction === "number") return b.fraction;
  return 1;
}

export function extractResetTime(b: QuotaBucket, pct: number): string | undefined {
  if (pct >= 100 && !b.description) return undefined;
  return b.resetTime;
}

export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];
  const results: PromiseSettledResult<R>[] = Array.from({ length: items.length });
  let idx = 0;

  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (idx < items.length) {
      const current = idx++;
      const item = items[current];
      if (item === undefined) break;
      try {
        const val = await fn(item);
        results[current] = { status: "fulfilled", value: val };
      } catch (reason) {
        results[current] = { status: "rejected", reason };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

export class QuotaMonitor {
  private readonly quotas = new Map<string, AccountQuota>();
  private readonly tierCheckedAt = new Map<string, number>();
  private static readonly TIER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  public static readonly DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
  private readonly cooldownTimers = new Map<string, NodeJS.Timeout>();
  private readonly priorityQueue = new Set<string>();
  private readonly lsClient: LanguageServerClient;
  private pollTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private isPollingAll = false;
  private modelsDiscovered = false;
  private static readonly IDLE_THRESHOLD_MS = 5 * 60 * 1000;
  private static readonly IDLE_POLL_INTERVAL_MS = 5 * 60 * 1000;
  private lastActivityTime = Date.now();

  constructor(
    private readonly tokenManager: TokenManager,
    private readonly log: (msg: string) => void,
    private readonly onQuotaUpdate?: (quota: AccountQuota) => void,
    private readonly usageTracker?: UsageTracker,
    private readonly context?: vscode.ExtensionContext,
    workspacePath?: string,
  ) {
    this.lsClient = new LanguageServerClient(
      workspacePath,
      (msg) => this.log(msg),
    );
    this.tokenManager.setQuotaMonitor?.(this);
    if (this.context) {
      const cached = this.context.globalState.get<Record<string, AccountQuota>>(KEY_QUOTA_CACHE, {});
      if (cached) {
        for (const [email, q] of Object.entries(cached)) {
          if (q && email) {
            this.quotas.set(email.toLowerCase(), q);
            if (q.cooldownExpiresAt) {
              if (q.cooldownExpiresAt <= Date.now()) {
                void this.onCooldownExpired(email);
              } else {
                this.scheduleCooldownPoll(email, q.cooldownExpiresAt);
              }
            }
          }
        }
      }
    }
    this.cleanupExpiredQuotas();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredQuotas(), 3600000);
  }

  public initialize(): void {
    this.tokenManager.onAccountChange(() => {
      this.invalidateLanguageServer();
      void this.pollAllAccounts();
    });
    this.startPolling();
    void this.pollAllAccounts();
  }

  public invalidateLanguageServer(): void {
    this.lsClient.invalidate();
  }

  public cleanupExpiredQuotas(): void {
    const now = Date.now();
    for (const [email, q] of this.quotas.entries()) {
      if (q.lastUpdated && now - q.lastUpdated > FIVE_HOURS && (!q.cooldownExpiresAt || q.cooldownExpiresAt <= now)) {
        this.quotas.delete(email);
      }
    }
    if (this.context) {
      void this.context.globalState.update(KEY_QUOTA_CACHE, this.getAllQuotas());
    }
  }

  public getQuota(email: string): AccountQuota | undefined {
    return this.quotas.get(email.toLowerCase());
  }

  public getAllQuotas(): Record<string, AccountQuota> {
    return Object.fromEntries(this.quotas);
  }

  public markAccountExhausted(email: string, modelFamily?: string, cooldownMs?: number): void {
    const emailKey = email.toLowerCase();
    const q = this.quotas.get(emailKey);
    if (!q) return;

    const now = Date.now();
    const famKey = modelFamily
      ? modelFamily.toLowerCase().includes("claude")
        ? "claude"
        : "gemini"
      : undefined;

    let effectiveResetTs = Infinity;
    for (const fam of q.families) {
      if (!famKey || fam.key === famKey) {
        fam.percent = 0;
        if (fam.limit5h) fam.limit5h.percent = 0;
        if (fam.resetTime) {
          const ts = Date.parse(fam.resetTime);
          if (!Number.isNaN(ts) && ts > now && ts < effectiveResetTs) {
            effectiveResetTs = ts;
          }
        }
        if (fam.limit5h?.resetTime) {
          const ts = Date.parse(fam.limit5h.resetTime);
          if (!Number.isNaN(ts) && ts > now && ts < effectiveResetTs) {
            effectiveResetTs = ts;
          }
        }
        if (fam.limitWeekly?.resetTime) {
          const ts = Date.parse(fam.limitWeekly.resetTime);
          if (!Number.isNaN(ts) && ts > now && ts < effectiveResetTs) {
            effectiveResetTs = ts;
          }
        }
      }
    }
    for (const m of q.models) {
      if (!famKey || m.family === famKey) {
        m.percent = 0;
        if (m.resetTime) {
          const ts = Date.parse(m.resetTime);
          if (!Number.isNaN(ts) && ts > now && ts < effectiveResetTs) {
            effectiveResetTs = ts;
          }
        }
      }
    }

    q.exhaustedAt = now;
    let cooldownExpiresAt: number;
    if (typeof cooldownMs === "number" && cooldownMs > 0) {
      cooldownExpiresAt = now + cooldownMs;
    } else if (effectiveResetTs !== Infinity) {
      cooldownExpiresAt = effectiveResetTs;
    } else {
      cooldownExpiresAt = now + QuotaMonitor.DEFAULT_COOLDOWN_MS;
    }
    q.cooldownExpiresAt = cooldownExpiresAt;

    for (const fam of q.families) {
      if (!famKey || fam.key === famKey) {
        if (!fam.resetTime) {
          fam.resetTime = new Date(cooldownExpiresAt).toISOString();
        }
      }
    }

    q.lastUpdated = now;
    this.quotas.set(emailKey, q);
    if (this.context) {
      void this.context.globalState.update(KEY_QUOTA_CACHE, this.getAllQuotas());
    }
    this.onQuotaUpdate?.(q);

    this.scheduleCooldownPoll(email, cooldownExpiresAt);
  }

  public scheduleCooldownPoll(email: string, cooldownExpiresAt: number): void {
    const emailKey = email.toLowerCase();
    const existing = this.cooldownTimers.get(emailKey);
    if (existing) {
      clearTimeout(existing);
      this.cooldownTimers.delete(emailKey);
    }

    const now = Date.now();
    const delayMs = Math.max(500, cooldownExpiresAt - now);

    this.log(
      `[Cooldown] Account ${email} marked in cooldown until ${new Date(cooldownExpiresAt).toISOString()} (in ${Math.round(delayMs / 1000)}s)`,
    );

    const timer = setTimeout(() => {
      this.cooldownTimers.delete(emailKey);
      void this.onCooldownExpired(email);
    }, delayMs);

    this.cooldownTimers.set(emailKey, timer);
  }

  public async onCooldownExpired(email: string): Promise<void> {
    const emailKey = email.toLowerCase();
    this.priorityQueue.add(emailKey);
    this.log(`[Cooldown] Cooldown expired for ${email}. Priority polling quota...`);

    try {
      const quota = await this.refreshAccountQuota(email);
      if (quota) {
        const hasRefilled =
          quota.families.some((f) => f.percent > 10) || quota.models.some((m) => m.percent > 10);
        if (hasRefilled) {
          quota.cooldownExpiresAt = undefined;
          quota.exhaustedAt = undefined;
          this.quotas.set(emailKey, quota);
          if (this.context) {
            void this.context.globalState.update(KEY_QUOTA_CACHE, this.getAllQuotas());
          }
          this.log(`[Cooldown] Account ${email} successfully rehabilitated! Quota refilled (> 10%).`);
          await this.tokenManager.restoreAccountStatus(email);
          this.onQuotaUpdate?.(quota);

          if (this.tokenManager.isExtensionEnabled() && this.tokenManager.isRotationEnabled()) {
            const model = this.usageTracker?.getActiveModel();
            void this.tokenManager.autoSelectHighestQuota(this.getAllQuotas(), `rehabilitation on ${email}`, model);
          }
        } else {
          this.log(`[Cooldown] Account ${email} still exhausted (quota <= 10%). Rescheduled cooldown poll.`);
          const now = Date.now();
          let nextExpiresAt = now + 60000;
          for (const f of quota.families) {
            if (f.resetTime) {
              const ts = Date.parse(f.resetTime);
              if (!Number.isNaN(ts) && ts > now) {
                nextExpiresAt = ts;
                break;
              }
            }
          }
          quota.cooldownExpiresAt = nextExpiresAt;
          this.quotas.set(emailKey, quota);
          if (this.context) {
            void this.context.globalState.update(KEY_QUOTA_CACHE, this.getAllQuotas());
          }
          this.scheduleCooldownPoll(email, nextExpiresAt);
        }
      }
    } catch (err) {
      this.log(`[Cooldown] Priority poll failed for ${email}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.priorityQueue.delete(emailKey);
    }
  }

  public getExhaustionEstimate(
    tokensPerMin: number,
    activeModel?: string,
  ): { estMinutesLeft: number; earliestResetMinutes: number } | null {
    if (tokensPerMin <= 0) return null;
    const active = this.tokenManager.getActiveAccount();
    if (!active) return null;
    const q = this.quotas.get(active.email.toLowerCase());
    if (!q) return null;

    const info = this.tokenManager.getEffectiveQuota(active.email, this.getAllQuotas(), activeModel);
    if (info.percent <= 0) return null;

    const estimatedTokensRemaining = Math.round((info.percent / 100) * 1000000);
    const estMinutesLeft = Math.max(1, Math.round(estimatedTokensRemaining / tokensPerMin));

    const now = Date.now();
    const earliestResetMinutes = info.resetTs > now && info.resetTs !== Infinity
      ? Math.max(1, Math.round((info.resetTs - now) / 60000))
      : 0;

    return { estMinutesLeft, earliestResetMinutes };
  }

  public async refreshAccountQuota(email: string): Promise<AccountQuota | null> {
    const acc = this.tokenManager.getAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
    return acc ? this.fetchAccountQuota(acc) : null;
  }

  public async fetchAccountQuota(account: Account, skipAutoRotation = false): Promise<AccountQuota | null> {
    if (!this.tokenManager.isExtensionEnabled()) return null;
    try {
      const accessToken = await this.tokenManager.getValidAccessToken(account);
      await this.discoverModels(accessToken);

      let tier = account.tier;
      const lastTierCheck = this.tierCheckedAt.get(account.email.toLowerCase()) ?? 0;
      if (!tier || tier === "unknown" || Date.now() - lastTierCheck > QuotaMonitor.TIER_CACHE_TTL_MS) {
        tier = await this.detectTier(account, accessToken);
        this.tierCheckedAt.set(account.email.toLowerCase(), Date.now());
        if (account.tier !== tier) {
          await this.tokenManager.updateAccountTier(account.email, tier);
        }
      }

      let data: QuotaResponse | null = null;
      try {
        const lsStatus = await this.lsClient.getUserStatus();
        if (lsStatus?.email && lsStatus.email.toLowerCase() === account.email.toLowerCase()) {
          const lsQuota = await this.lsClient.retrieveUserQuotaSummary();
          if (lsQuota && (lsQuota.groups || lsQuota.buckets)) {
            data = lsQuota as QuotaResponse;
            if (lsStatus.tier && lsStatus.tier.includes("pro")) {
              tier = "pro";
            }
          }
        }
      } catch (lsErr) {
        this.log(`Language server quota check skipped for ${account.email}: ${lsErr instanceof Error ? lsErr.message : String(lsErr)}`);
      }

      if (!data) {
        const res = await this.postCloudCode(
          "/v1internal:retrieveUserQuotaSummary",
          accessToken,
          JSON.stringify(account.projectId ? { project: account.projectId } : {}),
        );

        if (!res.ok) {
          const errText = await res.text();
          this.log(`Quota fetch failed for ${account.email} HTTP ${res.status}: ${errText}`);
          return null;
        }

        // SAFETY: Google Cloud internal quota endpoint response
        data = (await res.json()) as QuotaResponse;
      }
      let families: FamilyQuota[] = [];
      const models: ModelQuota[] = [];

      const groups = (data.groups && data.groups.length > 0)
        ? data.groups
        : (data.buckets && data.buckets.length > 0)
          ? [{ displayName: "All Models", buckets: data.buckets }]
          : [];

      if (groups.length > 0) {
        let gemini5h: QuotaLimitInfo | undefined, geminiWeekly: QuotaLimitInfo | undefined;
        let claude5h: QuotaLimitInfo | undefined, claudeWeekly: QuotaLimitInfo | undefined;

        for (const grp of groups) {
          const groupName = grp.displayName || "";
          const buckets = grp.buckets || [];

          for (const b of buckets) {
            const bId = (b.bucketId || "").toLowerCase();
            const bName = (b.displayName || "").toLowerCase();
            const isClaude = this.categorizeFamily(groupName, `${bId} ${bName}`) === "claude";
            const frac = extractRemainingFraction(b);
            const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
            const resetTime = extractResetTime(b, pct);

            const is5h =
              bId.includes("5h") ||
              bId.includes("hourly") ||
              (b.window || "").includes("5h") ||
              bName.includes("five hour") ||
              bName.includes("5 hour") ||
              bName.includes("5h");

            const isWk =
              bId.includes("weekly") ||
              (b.window || "").includes("week") ||
              bName.includes("weekly") ||
              bName.includes("week");

            const limitInfo: QuotaLimitInfo = { percent: pct, resetTime };

            if (isClaude) {
              if (is5h) claude5h = limitInfo;
              else if (isWk) claudeWeekly = limitInfo;
            } else {
              if (is5h) gemini5h = limitInfo;
              else if (isWk) geminiWeekly = limitInfo;
            }
          }
        }

        const geminiPct = Math.min(gemini5h?.percent ?? 100, geminiWeekly?.percent ?? 100);
        const claudePct = Math.min(claude5h?.percent ?? 100, claudeWeekly?.percent ?? 100);

        families = [
          {
            key: "gemini",
            label: "Gemini",
            percent: geminiPct,
            resetTime: (gemini5h && gemini5h.percent < 100) ? gemini5h.resetTime : (geminiWeekly && geminiWeekly.percent < 100) ? geminiWeekly.resetTime : undefined,
            limit5h: gemini5h,
            limitWeekly: geminiWeekly,
          },
          {
            key: "claude",
            label: "Claude",
            percent: claudePct,
            resetTime: (claude5h && claude5h.percent < 100) ? claude5h.resetTime : (claudeWeekly && claudeWeekly.percent < 100) ? claudeWeekly.resetTime : undefined,
            limit5h: claude5h,
            limitWeekly: claudeWeekly,
          },
        ];
      } else if (data.models && Object.keys(data.models).length > 0) {
        for (const [name, info] of Object.entries(data.models)) {
          const frac = info.quotaInfo ? extractRemainingFraction(info.quotaInfo as unknown as QuotaBucket) : 1;
          const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
          const resetTime = pct < 100 ? info.quotaInfo?.resetTime : undefined;
          models.push({ name, family: this.categorizeFamily(name), percent: pct, resetTime });
        }
        families = this.extractFamilyQuotas(models);
      } else {
        families = [
          { key: "gemini", label: "Gemini", percent: 100 },
          { key: "claude", label: "Claude", percent: 100 },
        ];
      }

      const quota: AccountQuota = { email: account.email, tier, families, models, lastUpdated: Date.now() };
      this.quotas.set(account.email.toLowerCase(), quota);
      if (this.context) {
        void this.context.globalState.update(KEY_QUOTA_CACHE, this.getAllQuotas());
      }
      this.onQuotaUpdate?.(quota);
      if (!skipAutoRotation) this.checkAutoRotation(account.email);
      return quota;
    } catch (e: unknown) {
      this.log(`Quota fetch failed for ${account.email}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private extractFamilyQuotas(models: ModelQuota[]): FamilyQuota[] {
    const map = new Map<"gemini" | "claude", { minPct: number; earliestReset?: string }>();
    for (const m of models) {
      if (m.family === "other") continue;
      const cur = map.get(m.family);
      if (!cur) {
        map.set(m.family, { minPct: m.percent, earliestReset: m.resetTime });
      } else {
        cur.minPct = Math.min(cur.minPct, m.percent);
        if (m.resetTime && (!cur.earliestReset || m.resetTime < cur.earliestReset)) cur.earliestReset = m.resetTime;
      }
    }
    const result: FamilyQuota[] = [];
    for (const [key, val] of map.entries()) {
      result.push({
        key,
        label: key === "gemini" ? "Gemini" : "Claude",
        percent: val.minPct,
        resetTime: val.earliestReset,
        limit5h: { percent: val.minPct, resetTime: val.earliestReset },
      });
    }
    if (!result.some((f) => f.key === "gemini")) result.push({ key: "gemini", label: "Gemini", percent: 100 });
    if (!result.some((f) => f.key === "claude")) result.push({ key: "claude", label: "Claude", percent: 100 });
    return result;
  }

  private async postCloudCode(
    path: string,
    accessToken: string,
    body: string,
    timeoutMs = 10000,
  ): Promise<Response> {
    const override = this.tokenManager.getConfig().endpointOverride?.trim();
    const primary = override || PRIMARY_ENDPOINT;
    const fallback = override ? null : FALLBACK_ENDPOINT;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": getUserAgent(),
    };

    try {
      const res = await fetch(`${primary}${path}`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok && fallback && (res.status === 404 || res.status === 403 || res.status >= 500)) {
        this.log(`Primary endpoint ${primary} returned HTTP ${res.status}, falling back to ${fallback}`);
        return await fetch(`${fallback}${path}`, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      }
      return res;
    } catch (err) {
      if (fallback) {
        this.log(`Primary endpoint ${primary} failed (${err instanceof Error ? err.message : String(err)}), falling back to ${fallback}`);
        return await fetch(`${fallback}${path}`, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      }
      throw err;
    }
  }

  private async discoverModels(accessToken: string): Promise<void> {
    if (this.modelsDiscovered) return;
    try {
      const res = await this.postCloudCode(
        "/v1internal:fetchAvailableModels",
        accessToken,
        JSON.stringify({}),
      );
      if (!res.ok) return;
      // SAFETY: Available models endpoint response structure
      const data = (await res.json()) as { models?: Record<string, { maxTokens?: number }> };
      if (data.models) this.usageTracker?.registerModelMetadata(data.models);
      this.modelsDiscovered = true;
    } catch (e: unknown) {
      this.log(`Model discovery skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async detectTier(account: Account, accessToken: string): Promise<AccountTier> {
    try {
      const res = await this.postCloudCode(
        "/v1internal:loadCodeAssist",
        accessToken,
        getCodeAssistBody(),
      );
      if (!res.ok) return account.tier || "pro";
      // SAFETY: Code assist subscription tier response payload
      const data = (await res.json()) as { paidTier?: { id?: string; name?: string }; tierId?: string; currentTier?: { id?: string; name?: string } };
      const raw = (data.paidTier?.id || data.paidTier?.name || data.tierId || data.currentTier?.id || data.currentTier?.name || "").toLowerCase();
      if (raw.includes("ultra")) return "ultra";
      if (raw.includes("pro") || raw.includes("advanced") || raw.includes("standard")) return "pro";
      if (raw.includes("plus")) return "plus";
      if (raw.includes("free")) return "free";
      return account.tier || "pro";
    } catch (e: unknown) {
      this.log(`Tier detection fallback for ${account.email}: ${e instanceof Error ? e.message : String(e)}`);
      return account.tier || "pro";
    }
  }

  private checkAutoRotation(email: string): void {
    if (!this.tokenManager.isExtensionEnabled() || !this.tokenManager.isRotationEnabled()) return;
    const model = this.usageTracker?.getActiveModel();
    void this.tokenManager.autoSelectHighestQuota(this.getAllQuotas(), `quota update on ${email}`, model);
  }

  public async pollActiveAccount(): Promise<void> {
    if (!this.tokenManager.isExtensionEnabled()) return;
    const active = this.tokenManager.getActiveAccount();
    if (active) await this.fetchAccountQuota(active);
  }

  public async pollAllAccounts(): Promise<void> {
    if (this.isPollingAll) return;
    this.isPollingAll = true;
    try {
      const accounts = this.tokenManager.getAccounts().filter((acc) => acc.status !== "disabled");
      accounts.sort((a, b) => {
        const aPriority = this.priorityQueue.has(a.email.toLowerCase()) ? 1 : 0;
        const bPriority = this.priorityQueue.has(b.email.toLowerCase()) ? 1 : 0;
        return bPriority - aPriority;
      });
      const concurrency = Math.min(4, Math.max(2, Math.floor(accounts.length / 3)));
      await runWithConcurrency(accounts, concurrency, async (acc) => {
        await this.fetchAccountQuota(acc, true);
        if (accounts.length > 6) {
          await new Promise((r) => setTimeout(r, 100));
        }
      });
      if (this.tokenManager.isExtensionEnabled() && this.tokenManager.isRotationEnabled()) {
        const model = this.usageTracker?.getActiveModel();
        void this.tokenManager.autoSelectHighestQuota(this.getAllQuotas(), "poll all accounts completion", model);
      }
    } finally {
      this.isPollingAll = false;
    }
  }

  private categorizeFamily(name: string, bucketId = ""): "gemini" | "claude" | "other" {
    const lower = `${name} ${bucketId}`.toLowerCase();
    if (
      lower.includes("claude") ||
      lower.includes("sonnet") ||
      lower.includes("opus") ||
      lower.includes("haiku") ||
      lower.includes("gpt") ||
      lower.includes("oss") ||
      lower.includes("3p")
    ) return "claude";
    if (lower.includes("gemini")) return "gemini";
    return "other";
  }

  public notifyActivity(): void {
    const wasIdle = Date.now() - this.lastActivityTime > QuotaMonitor.IDLE_THRESHOLD_MS;
    this.lastActivityTime = Date.now();
    if (wasIdle) {
      void this.pollActiveAccount();
      this.scheduleNextPoll();
    }
  }

  private getActivePollIntervalMs(): number {
    const cfgSec = this.tokenManager.getConfig().pollIntervalSeconds;
    const baseMs = typeof cfgSec === "number" && cfgSec >= 15 ? cfgSec * 1000 : 60000;
    return Math.max(baseMs, 60000);
  }

  private scheduleNextPoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    const isIdle = Date.now() - this.lastActivityTime > QuotaMonitor.IDLE_THRESHOLD_MS;
    const interval = isIdle ? QuotaMonitor.IDLE_POLL_INTERVAL_MS : this.getActivePollIntervalMs();

    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAllAccounts();
      } finally {
        this.scheduleNextPoll();
      }
    }, interval);
  }

  private startPolling(): void {
    this.scheduleNextPoll();
  }

  public restartPolling(): void {
    this.scheduleNextPoll();
  }

  public dispose(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    for (const timer of this.cooldownTimers.values()) {
      clearTimeout(timer);
    }
    this.cooldownTimers.clear();
    this.priorityQueue.clear();
  }
}
