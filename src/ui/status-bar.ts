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
  const d = Date.parse(s) - Date.now();
  if (d <= 0 || Number.isNaN(d)) return "ready";
  const days = Math.floor(d / 864e5);
  const hrs = Math.floor((d % 864e5) / 36e5);
  const mins = Math.floor((d % 36e5) / 6e4);
  if (days > 0) return `${days}d ${hrs}h`;
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
};

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

  constructor(context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "openag.openPanel";
    context.subscriptions.push(this.item);
    this.scheduleRender();
    this.item.show();
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
    const quotaSummary = families.map((f) => `${f.limit5h?.percent ?? f.percent}%`).join(" | ");
    const minPct = families.length > 0 ? Math.min(...families.map((f) => f.limit5h?.percent ?? f.percent)) : 100;
    const ctxStr = this.currentContext?.limit ? ` [${fmtTokens(this.currentContext.current)}/${fmtTokens(this.currentContext.limit)}]` : "";

    this.item.text = `${icon} ${tierBadge}${quotaSummary ? ` (${quotaSummary})` : ""}${ctxStr}`;
    this.item.backgroundColor = minPct < 20 ? new vscode.ThemeColor("statusBarItem.errorBackground") : minPct < 40 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;

    const md = new vscode.MarkdownString(`$(account) **Active Account**: \`${this.currentEmail}\` [${tierBadge}]\n\n`, true);
    md.isTrusted = true;
    md.supportThemeIcons = true;
    if (families.length > 0) {
      md.appendMarkdown("---\n\n");
      for (const fam of families) {
        const p5h = fam.limit5h?.percent ?? fam.percent;
        const reset5h = fmtTime(fam.limit5h?.resetTime ?? fam.resetTime);
        md.appendMarkdown(`**${fam.label} (5h)**: \`${makeBar(p5h)}\` **${p5h}%**${reset5h ? ` (resets ${reset5h})` : ""}\n\n`);
        if (fam.limitWeekly) {
          const pWk = fam.limitWeekly.percent;
          const resetWk = fmtTime(fam.limitWeekly.resetTime);
          md.appendMarkdown(`**${fam.label} (7d)**: \`${makeBar(pWk)}\` **${pWk}%**${resetWk ? ` (resets ${resetWk})` : ""}\n\n`);
        }
      }
    }
    if (this.currentContext?.limit) {
      const modelLabel = this.currentContext.model ? ` (${this.currentContext.model})` : "";
      md.appendMarkdown(`---\n\n$(server-process) **Context**${modelLabel}: ${this.currentContext.current.toLocaleString()} / ${this.currentContext.limit.toLocaleString()} (${this.currentContext.percent}%)\n\n`);
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
