import type * as vscode from "vscode";
import type { Account, AccountQuota, AccountTier, FamilyQuota, ModelQuota, QuotaLimitInfo } from "../types.js";
import type { TokenManager } from "./token-manager.js";
import type { UsageTracker } from "./usage-tracker.js";

const ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_BODY = JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", ideVersion: "2.5.5" } });
const FIVE_HOURS = 5 * 60 * 60 * 1000;
const KEY_QUOTA_CACHE = "openag.quota_cache.v1";

interface QuotaBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  resetTime?: string;
  remainingFraction?: number;
}

interface QuotaGroup {
  displayName?: string;
  buckets?: QuotaBucket[];
}

interface QuotaResponse {
  groups?: QuotaGroup[];
  models?: Record<string, { quotaInfo?: { remainingFraction?: number; resetTime?: string } }>;
}

export class QuotaMonitor {
  private readonly quotas = new Map<string, AccountQuota>();
  private pollTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private modelsDiscovered = false;

  constructor(
    private readonly tokenManager: TokenManager,
    private readonly log: (msg: string) => void,
    private readonly onQuotaUpdate?: (quota: AccountQuota) => void,
    private readonly usageTracker?: UsageTracker,
    private readonly context?: vscode.ExtensionContext,
  ) {
    if (this.context) {
      const cached = this.context.globalState.get<Record<string, AccountQuota>>(KEY_QUOTA_CACHE, {});
      if (cached) {
        for (const [email, q] of Object.entries(cached)) {
          if (q && email) this.quotas.set(email.toLowerCase(), q);
        }
      }
    }
    this.cleanupExpiredQuotas();
    this.cleanupTimer = setInterval(() => this.cleanupExpiredQuotas(), 3600000);
  }

  public initialize(): void {
    this.startPolling();
    void this.pollAllAccounts();
  }

  public cleanupExpiredQuotas(): void {
    const now = Date.now();
    for (const [email, q] of this.quotas.entries()) {
      if (q.lastUpdated && now - q.lastUpdated > FIVE_HOURS) {
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

  public async refreshAccountQuota(email: string): Promise<AccountQuota | null> {
    const acc = this.tokenManager.getAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
    return acc ? this.fetchAccountQuota(acc) : null;
  }

  public async fetchAccountQuota(account: Account, skipAutoRotation = false): Promise<AccountQuota | null> {
    if (!this.tokenManager.isExtensionEnabled()) return null;
    try {
      const accessToken = await this.tokenManager.getValidAccessToken(account);
      await this.discoverModels(accessToken);
      const tier = await this.detectTier(account, accessToken);
      if (account.tier !== tier) {
        await this.tokenManager.updateAccountTier(account.email, tier);
      }

      const res = await fetch(`${ENDPOINT}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "User-Agent": "Antigravity/2.5.5" },
        body: JSON.stringify({ project: account.projectId || "" }),
      });

      if (!res.ok) {
        const errText = await res.text();
        this.log(`Quota fetch failed for ${account.email} HTTP ${res.status}: ${errText}`);
        return null;
      }

      // SAFETY: Google Cloud internal quota endpoint response
      const data = (await res.json()) as QuotaResponse;
      let families: FamilyQuota[] = [];
      const models: ModelQuota[] = [];

      if (data.groups && data.groups.length > 0) {
        let gemini5h: QuotaLimitInfo | undefined, geminiWeekly: QuotaLimitInfo | undefined;
        let claude5h: QuotaLimitInfo | undefined, claudeWeekly: QuotaLimitInfo | undefined;

        for (const grp of data.groups) {
          const name = grp.displayName || "";
          const isClaude = this.categorizeFamily(name) === "claude";
          const buckets = grp.buckets || [];

          for (const b of buckets) {
            const bId = (b.bucketId || "").toLowerCase();
            const pct = Math.round((b.remainingFraction ?? 1) * 100);
            const is5h = bId.includes("5h") || bId.includes("hourly") || (b.window || "").includes("5h");
            const isWk = bId.includes("weekly") || (b.window || "").includes("week");

            if (isClaude) {
              if (is5h) claude5h = { percent: pct, resetTime: b.resetTime };
              else if (isWk) claudeWeekly = { percent: pct, resetTime: b.resetTime };
            } else {
              if (is5h) gemini5h = { percent: pct, resetTime: b.resetTime };
              else if (isWk) geminiWeekly = { percent: pct, resetTime: b.resetTime };
            }
          }
        }

        families = [
          {
            key: "gemini",
            label: "Gemini",
            percent: gemini5h?.percent ?? geminiWeekly?.percent ?? 100,
            resetTime: gemini5h?.resetTime ?? geminiWeekly?.resetTime,
            limit5h: gemini5h,
            limitWeekly: geminiWeekly,
          },
          {
            key: "claude",
            label: "Claude",
            percent: claude5h?.percent ?? claudeWeekly?.percent ?? 100,
            resetTime: claude5h?.resetTime ?? claudeWeekly?.resetTime,
            limit5h: claude5h,
            limitWeekly: claudeWeekly,
          },
        ];
      } else if (data.models && Object.keys(data.models).length > 0) {
        for (const [name, info] of Object.entries(data.models)) {
          const pct = Math.round((info.quotaInfo?.remainingFraction ?? 1) * 100);
          models.push({ name, family: this.categorizeFamily(name), percent: pct, resetTime: info.quotaInfo?.resetTime });
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

  private async discoverModels(accessToken: string): Promise<void> {
    if (this.modelsDiscovered) return;
    try {
      const res = await fetch(`${ENDPOINT}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "User-Agent": "Antigravity/2.5.5" },
        body: JSON.stringify({}),
      });
      if (!res.ok) return;
      // SAFETY: Available models endpoint response structure
      const data = (await res.json()) as { models?: Record<string, { maxTokens?: number }> };
      if (data.models) this.usageTracker?.registerModelMetadata(data.models);
      this.modelsDiscovered = true;
    } catch { /* ignore discovery error */ }
  }

  private async detectTier(account: Account, accessToken: string): Promise<AccountTier> {
    try {
      const res = await fetch(`${ENDPOINT}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "User-Agent": "Antigravity/2.5.5" },
        body: CODE_ASSIST_BODY,
      });
      if (!res.ok) return account.tier || "pro";
      // SAFETY: Code assist subscription tier response payload
      const data = (await res.json()) as { paidTier?: { id?: string; name?: string }; tierId?: string; currentTier?: { id?: string; name?: string } };
      const raw = (data.paidTier?.id || data.paidTier?.name || data.tierId || data.currentTier?.id || data.currentTier?.name || "").toLowerCase();
      if (raw.includes("ultra")) return "ultra";
      if (raw.includes("pro") || raw.includes("advanced") || raw.includes("standard")) return "pro";
      if (raw.includes("plus")) return "plus";
      if (raw.includes("free")) return "free";
      return account.tier || "pro";
    } catch {
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
    const accounts = this.tokenManager.getAccounts().filter((acc) => acc.status !== "disabled");
    await Promise.allSettled(accounts.map((acc) => this.fetchAccountQuota(acc, true)));
    if (this.tokenManager.isExtensionEnabled() && this.tokenManager.isRotationEnabled()) {
      const model = this.usageTracker?.getActiveModel();
      void this.tokenManager.autoSelectHighestQuota(this.getAllQuotas(), "poll all accounts completion", model);
    }
  }

  private categorizeFamily(name: string): "gemini" | "claude" | "other" {
    const lower = name.toLowerCase();
    if (
      lower.includes("claude") ||
      lower.includes("sonnet") ||
      lower.includes("opus") ||
      lower.includes("haiku") ||
      lower.includes("gpt") ||
      lower.includes("oss")
    ) return "claude";
    if (lower.includes("gemini")) return "gemini";
    return "other";
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.pollAllAccounts(), 60000);
  }

  public dispose(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  }
}
