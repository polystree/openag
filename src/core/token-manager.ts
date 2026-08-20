import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { Account, AccountQuota, AccountStatus, AccountTier, EffectiveQuota, OAuthTokens, OpenAGConfig } from "../types.js";
import type { UsageTracker } from "./usage-tracker.js";
import { USSBridge } from "./uss-bridge.js";

const KEY_ACCOUNTS = "openag.accounts.v1";
const KEY_ACTIVE = "openag.active_account.v1";
const KEY_CONFIG = "openag.config.v1";

function resolveModelFamily(modelName?: string): "gemini" | "claude" | "other" {
  if (!modelName) return "other";
  const lower = modelName.toLowerCase();
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void,
    private readonly usageTracker?: UsageTracker,
  ) {}

  public async initialize(): Promise<void> {
    this.accounts = this.context.globalState.get<Account[]>(KEY_ACCOUNTS, []);
    this.activeEmail = this.context.globalState.get<string>(KEY_ACTIVE, "");
    this.config = this.context.globalState.get<OpenAGConfig>(KEY_CONFIG, this.config);

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
        } catch { /* ignore parse error */ }
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

  public async updateConfig(newConfig: Partial<OpenAGConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    await this.context.globalState.update(KEY_CONFIG, this.config);
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
      ? { ...existing, tier: account.tier || existing.tier || "pro", status: account.status || existing.status, tokenExpiresAt, accessToken, refreshToken, updatedAt: now }
      : { id: `acc_${now}_${crypto.randomUUID().slice(0, 8)}`, email: account.email, alias: account.alias, tier: account.tier || "pro", status: account.status || "active", sortOrder: account.sortOrder ?? this.accounts.length, projectId: account.projectId, tokenExpiresAt, accessToken, refreshToken, createdAt: now, updatedAt: now };

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
    const target = this.accounts.find((a) => a.email.toLowerCase() === email.toLowerCase());
    if (!target || target.status === "disabled") return null;
    this.activeEmail = target.email;
    await this.context.globalState.update(KEY_ACTIVE, this.activeEmail);
    await this.persist();
    await this.syncActiveTokenToUss();
    this.onAccountChangeEmitter.fire();
    this.log(`Active account switched to: ${this.activeEmail}`);
    return target;
  }

  public getEffectiveQuota(email: string, quotas: Record<string, AccountQuota>, targetModel?: string): EffectiveQuota {
    const q = quotas[email.toLowerCase()];
    if (!q?.families || q.families.length === 0) return { percent: -1, resetTs: Infinity };

    const modelName = targetModel || this.usageTracker?.getActiveModel() || "";
    if (modelName) {
      if (q.models && q.models.length > 0) {
        const lowerModel = modelName.toLowerCase();
        const directModel = q.models.find((m) => m.name.toLowerCase() === lowerModel);
        if (directModel) {
          const resetTs = directModel.resetTime ? Date.parse(directModel.resetTime) : Infinity;
          return { percent: directModel.percent, resetTs: Number.isNaN(resetTs) ? Infinity : resetTs };
        }
      }

      const famKey = resolveModelFamily(modelName);
      if (famKey !== "other") {
        const fam = q.families.find((f) => f.key === famKey);
        if (fam) {
          const p5h = fam.limit5h?.percent ?? fam.percent ?? 100;
          const pWk = fam.limitWeekly?.percent ?? 100;
          const pct = Math.min(p5h, pWk);
          const resetStr = fam.limit5h?.resetTime ?? fam.resetTime ?? fam.limitWeekly?.resetTime;
          const resetTs = resetStr ? Date.parse(resetStr) : Infinity;
          return { percent: pct, resetTs: Number.isNaN(resetTs) ? Infinity : resetTs };
        }
      }
    }

    let minPct = 100, minResetTs = Infinity;
    for (const f of q.families) {
      const p5h = f.limit5h?.percent ?? f.percent ?? 100;
      const pWk = f.limitWeekly?.percent ?? 100;
      const pct = Math.min(p5h, pWk);
      minPct = Math.min(minPct, pct);
      const resetTime = f.limit5h?.resetTime ?? f.resetTime ?? f.limitWeekly?.resetTime;
      if (resetTime) {
        const ts = Date.parse(resetTime);
        if (!Number.isNaN(ts) && ts < minResetTs) minResetTs = ts;
      }
    }
    return { percent: minPct, resetTs: minResetTs };
  }

  public async autoSelectHighestQuota(quotas: Record<string, AccountQuota>, reason?: string, targetModel?: string): Promise<Account | null> {
    if (!this.isExtensionEnabled() || !this.isRotationEnabled() || this.accounts.length <= 1) return null;
    const available = this.accounts.filter((a) => a.status !== "disabled");
    if (available.length <= 1) return null;

    const model = targetModel || this.usageTracker?.getActiveModel() || "Gemini 3.7 Flash High";
    const activeEmail = this.activeEmail.toLowerCase();
    const activeInfo = this.getEffectiveQuota(activeEmail, quotas, model);

    let bestAcc: Account | null = null;
    let bestPct = -1;
    let bestResetTs = Infinity;

    for (const acc of available) {
      const info = this.getEffectiveQuota(acc.email, quotas, model);
      if (info.percent < 0) continue;
      if (info.percent > bestPct || (info.percent === bestPct && info.resetTs < bestResetTs)) {
        bestAcc = acc;
        bestPct = info.percent;
        bestResetTs = info.resetTs;
      }
    }

    if (!bestAcc || bestPct <= 0 || bestAcc.email.toLowerCase() === activeEmail || bestPct <= activeInfo.percent) {
      return null;
    }
    this.log(`[AutoRotate] Switching to highest-quota account ${bestAcc.email} (${bestPct}%) from ${this.activeEmail} (${activeInfo.percent}%) [model: ${model}, reason: ${reason || "auto"}]`);
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
        } catch { /* ignore parse error */ }
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
        account.updatedAt = Date.now();

        await this.context.secrets.store(this.getSecretKey(account.email), JSON.stringify({ accessToken: account.accessToken, refreshToken: account.refreshToken, expiryDateSeconds: account.tokenExpiresAt }));
        await this.persist();
        if (account.email.toLowerCase() === this.activeEmail.toLowerCase()) await this.syncActiveTokenToUss();
        return account.accessToken;
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
    });
    if (!res.ok) throw new Error(`Token refresh failed HTTP ${res.status}: ${await res.text()}`);
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
      this.lastSyncedEmail = active.email;
      this.lastSyncedToken = token;
      await USSBridge.setOAuthToken({
        accessToken: token,
        refreshToken: active.refreshToken || "",
        expiryDateSeconds: active.tokenExpiresAt,
        tokenType: "Bearer",
        isGcpTos: false,
      });
      void (async () => {
        try {
          await fetch("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "User-Agent": "Antigravity/2.5.5",
            },
            body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY", ideVersion: "2.5.5" } }),
          });
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

  public dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.onAccountChangeEmitter.dispose();
  }
}

