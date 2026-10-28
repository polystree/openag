import * as vscode from "vscode";
import type { AccountQuota, AccountTier, ContextUsage } from "../types.js";

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(/\.0$/, "")}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1).replace(/\.0$/, "")}k` : `${n}`;

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

  constructor(
    context: vscode.ExtensionContext,
    private readonly statsManager?: StatsManager,
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
    const icon = this.isRotating ? "$(sync~spin)" : "$(sparkle)";
    const families = this.currentQuota?.families || [];
    const quotaSummary = families.map((f) => `${f.percent}%`).join(" | ");
    const activeModel = (this.currentContext?.model || "").toLowerCase();
    const activeFam =
      activeModel.includes("claude") ||
      activeModel.includes("sonnet") ||
      activeModel.includes("opus") ||
      activeModel.includes("haiku") ||
      activeModel.includes("gpt") ||
      activeModel.includes("oss")
        ? "claude"
        : activeModel.includes("gemini")
          ? "gemini"
          : null;
    const targetFamily = activeFam ? families.find((f) => f.key === activeFam) : null;
    const effectivePct = targetFamily
      ? targetFamily.percent
      : families.length > 0
        ? Math.min(...families.map((f) => f.percent))
        : 100;
    const ctxPct = this.currentContext?.percent ?? 0;
    const ctxStr = this.currentContext?.limit ? ` [${fmtTokens(this.currentContext.current)}/${fmtTokens(this.currentContext.limit)}]` : "";

    this.item.text = `${icon} ${tierBadge}${quotaSummary ? ` (${quotaSummary})` : ""}${ctxStr}`;

    const isError = effectivePct < 20 || ctxPct >= 90;
    const isWarning = effectivePct < 40 || ctxPct >= 80;

    this.item.backgroundColor = isError
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : isWarning
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;

    const displayAccount = this.getDisplayAccount();
    const md = new vscode.MarkdownString(`$(account) **Active Account**: \`${displayAccount}\` [${tierBadge}]\n\n`, true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    if (families.length > 0) {
      md.appendMarkdown("---\n\n");
      for (const fam of families) {
        const p5h = fam.limit5h?.percent ?? fam.percent;
        const reset5h = p5h < 100 ? fmtTime(fam.limit5h?.resetTime ?? fam.resetTime) : "";
        md.appendMarkdown(`**${fam.label} (5h)**: \`${makeBar(p5h)}\` **${p5h}%**${reset5h ? ` (resets ${reset5h})` : ""}\n\n`);
        if (fam.limitWeekly) {
          const pWk = fam.limitWeekly.percent;
          const resetWk = pWk < 100 ? fmtTime(fam.limitWeekly.resetTime) : "";
          md.appendMarkdown(`**${fam.label} (7d)**: \`${makeBar(pWk)}\` **${pWk}%**${resetWk ? ` (resets ${resetWk})` : ""}\n\n`);
        }
      }
    }
    if (this.currentContext?.limit) {
      const modelLabel = this.currentContext.model ? ` (${this.currentContext.model})` : "";
      const ctxWarn = ctxPct >= 90 ? " **[CRITICAL]**" : ctxPct >= 80 ? " **[HIGH CONTEXT]**" : "";
      md.appendMarkdown(`---\n\n$(server-process) **Context**${modelLabel}: ${this.currentContext.current.toLocaleString()} / ${this.currentContext.limit.toLocaleString()} (${ctxPct}%)${ctxWarn}\n\n`);
    }
    if (this.statsManager) {
      const burn = this.statsManager.getBurnRate(15);
      if (burn.tokensPerMin > 0) {
        md.appendMarkdown(`---\n\n$(dashboard) **Burn Rate**: \`~${fmtTokens(burn.tokensPerMin)} tok/min\` (${burn.recentTurns} turns in last 15m)\n\n`);
      }
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
