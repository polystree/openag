import * as vscode from "vscode";
import type { AccountQuota, AccountTier, ContextUsage } from "../types.js";

const makeBar = (p: number): string => {
  const f = Math.max(0, Math.min(10, Math.round(p / 10)));
  return "■".repeat(f) + "□".repeat(10 - f);
};

const fmtTime = (s?: string): string => {
  if (!s) return "";
  const target = new Date(s);
  const d = target.getTime() - Date.now();
  if (d <= 0 || Number.isNaN(d)) return "ready";
  const days = Math.floor(d / 864e5);
  const hrs = Math.floor((d % 864e5) / 36e5);
  const mins = Math.floor((d % 36e5) / 6e4);
  const rel = days > 0 ? `${days}d ${hrs}h` : hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
  const localClock = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${rel} (${localClock})`;
};

import type { StatsManager } from "../core/stats-manager.js";
import type { TokenManager } from "../core/token-manager.js";

export class StatusBarHUD {
  private readonly item: vscode.StatusBarItem;
  private currentEmail = "";
  private currentTier: AccountTier = "unknown";
  private currentQuota: AccountQuota | null = null;
  private currentContext: ContextUsage | null = null;
  private isRotating = false;
  private isEnabled = true;
  private rotateTimer: NodeJS.Timeout | null = null;
  private renderDebounce: NodeJS.Timeout | null = null;
  private readonly rateLimitedAccounts = new Map<string, { model?: string; resetTs: number }>();

  constructor(
    context: vscode.ExtensionContext,
    _statsManager?: StatsManager,
    private readonly tokenManager?: TokenManager,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "openag.openPanel";
    context.subscriptions.push(this.item);
    this.scheduleRender();
    this.item.show();
  }

  private getDisplayAccount(): string {
    const isHidden = this.tokenManager?.getConfig()?.hideEmail ?? false;
    if (!isHidden) return this.currentEmail;
    const accounts = this.tokenManager?.getAccounts() ?? [];
    const idx = accounts.findIndex((a) => a.email.toLowerCase() === this.currentEmail.toLowerCase());
    if (idx >= 0) {
      const acc = accounts[idx];
      if (acc?.alias) return acc.alias;
      return `Account ${idx + 1}`;
    }
    return "Account";
  }

  public updateAccount(email: string, tier: AccountTier, isEnabled = true, quota?: AccountQuota | null): void {
    this.currentEmail = email;
    this.currentTier = tier;
    this.isEnabled = isEnabled;
    if (quota !== undefined) {
      this.currentQuota = quota;
      if (quota) this.currentTier = quota.tier;
    } else if (this.currentQuota && this.currentQuota.email.toLowerCase() !== email.toLowerCase()) {
      this.currentQuota = null;
    }
    this.scheduleRender();
  }

  public markRateLimited(email: string, model?: string, cooldownUntil?: number): void {
    const resetTs = cooldownUntil || Date.now() + 60000;
    this.rateLimitedAccounts.set(email.toLowerCase(), { model, resetTs });
    this.scheduleRender();
  }

  public clearRateLimit(email: string): void {
    this.rateLimitedAccounts.delete(email.toLowerCase());
    this.scheduleRender();
  }

  public flashRotating(): void {
    this.isRotating = true;
    this.scheduleRender();
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    this.rotateTimer = setTimeout(() => {
      this.isRotating = false;
      this.rotateTimer = null;
      this.scheduleRender();
    }, 1200);
  }

  public updateQuota(quota: AccountQuota): void {
    if (this.currentEmail && quota.email.toLowerCase() !== this.currentEmail.toLowerCase()) return;
    this.currentQuota = quota;
    this.currentTier = quota.tier;
    const rl = this.rateLimitedAccounts.get(quota.email.toLowerCase());
    if (rl && quota.families.some((f) => f.percent > 10)) {
      this.rateLimitedAccounts.delete(quota.email.toLowerCase());
    }
    this.scheduleRender();
  }

  public updateContext(usage: ContextUsage): void {
    this.currentContext = usage;
    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.renderDebounce) return;
    this.renderDebounce = setTimeout(() => {
      this.renderDebounce = null;
      this.render();
    }, 150);
  }

  private render(): void {
    if (!this.isEnabled) {
      this.item.text = "$(circle-slash) OpenAG (Off)";
      this.item.tooltip = "OpenAG is disabled. Click to manage accounts.";
      this.item.backgroundColor = undefined;
      return;
    }
    if (!this.currentEmail) {
      this.item.text = "$(account) OpenAG: No Account";
      this.item.tooltip = "Click to add a Google account";
      this.item.backgroundColor = undefined;
      return;
    }

    const tierBadge = this.currentTier && this.currentTier !== "unknown" ? this.currentTier.toUpperCase() : "PRO";
    const families = this.currentQuota?.families || [];

    const quotaSummary = families.map((f) => `${f.limit5h?.percent ?? f.percent}%`).join(" | ");
    const min5hPct = families.length > 0
      ? Math.min(...families.map((f) => f.limit5h?.percent ?? f.percent))
      : 100;

    const ctxPct = this.currentContext?.percent ?? 0;

    const rl = this.rateLimitedAccounts.get(this.currentEmail.toLowerCase());
    const isRateLimited = !!rl && rl.resetTs > Date.now();
    if (rl && !isRateLimited) {
      this.rateLimitedAccounts.delete(this.currentEmail.toLowerCase());
    }
    const cooldownExpiresAt = (this.currentQuota as unknown as { cooldownExpiresAt?: number })?.cooldownExpiresAt;
    const isCooldownActive = !!cooldownExpiresAt && cooldownExpiresAt > Date.now();
    const inCooldown = isRateLimited || isCooldownActive;

    if (inCooldown) {
      const icon = this.isRotating ? "$(sync~spin)" : "$(clock)";
      this.item.text = `${icon} ${tierBadge}${quotaSummary ? ` ${quotaSummary}` : ""}`;
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    } else {
      const icon = this.isRotating ? "$(sync~spin)" : "$(sparkle)";
      this.item.text = `${icon} ${tierBadge}${quotaSummary ? ` ${quotaSummary}` : ""}`;

      const isError = min5hPct < 20 || ctxPct >= 90;
      const isWarning = min5hPct < 40 || ctxPct >= 80;

      this.item.backgroundColor = isError
        ? new vscode.ThemeColor("statusBarItem.errorBackground")
        : isWarning
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    }

    const displayAccount = this.getDisplayAccount();
    const md = new vscode.MarkdownString(`$(account) **Active Account**: \`${displayAccount}\` [${tierBadge}]\n\n`, true);
    md.isTrusted = true;
    md.supportThemeIcons = true;

    if (families.length > 0) {
      md.appendMarkdown("---\n\n");
      for (const fam of families) {
        const p5h = fam.limit5h?.percent ?? fam.percent;
        const reset5h = p5h < 100 ? fmtTime(fam.limit5h?.resetTime ?? fam.resetTime) : "";
        const timer5hStr = reset5h ? ` (resets ${reset5h})` : " (Not used)";
        md.appendMarkdown(`**${fam.label} (5h)**: \`${makeBar(p5h)}\` **${p5h}%**${timer5hStr}\n\n`);
        if (fam.limitWeekly) {
          const pWk = fam.limitWeekly.percent;
          const resetWk = pWk < 100 ? fmtTime(fam.limitWeekly.resetTime) : "";
          const timerWkStr = resetWk ? ` (resets ${resetWk})` : " (Not used)";
          md.appendMarkdown(`**${fam.label} (7d)**: \`${makeBar(pWk)}\` **${pWk}%**${timerWkStr}\n\n`);
        }
      }
    }
    if (this.currentContext?.limit) {
      const ctxWarn = ctxPct >= 90 ? " **[CRITICAL]**" : ctxPct >= 80 ? " **[HIGH CONTEXT]**" : "";
      md.appendMarkdown(`---\n\n$(server-process) **Context**: ${this.currentContext.current.toLocaleString()} / ${this.currentContext.limit.toLocaleString()} (${ctxPct}%)${ctxWarn}\n\n`);
    }
    md.appendMarkdown("---\n*Click to open OpenAG panel*");
    this.item.tooltip = md;
  }

  public dispose(): void {
    if (this.rotateTimer) clearTimeout(this.rotateTimer);
    if (this.renderDebounce) clearTimeout(this.renderDebounce);
    this.item.dispose();
  }
}
