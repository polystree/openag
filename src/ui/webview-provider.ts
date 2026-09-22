import * as vscode from "vscode";
import type { LogManager } from "../core/log-manager.js";
import type { QuotaMonitor } from "../core/quota-monitor.js";
import { BRAIN_DIR } from "../core/sqlite-utils.js";
import type { StatsManager } from "../core/stats-manager.js";
import type { TokenManager } from "../core/token-manager.js";
import type { UsageTracker } from "../core/usage-tracker.js";
import type { OpenAGConfig } from "../types.js";

type WebviewMessage =
  | { action: "ready"; payload?: undefined }
  | { action: "addAccount"; payload?: undefined }
  | { action: "refreshQuotas"; payload?: undefined }
  | { action: "toggleAccount"; payload: { email: string; enabled: boolean } }
  | { action: "updateAccountMeta"; payload: { email: string; alias?: string; affinity?: import("../types.js").ModelAffinity; role?: import("../types.js").PoolRole } }
  | { action: "reauthAccount"; payload: string }
  | { action: "refreshAccount"; payload: string }
  | { action: "removeAccount"; payload: string }
  | { action: "clearLogs"; payload?: undefined }
  | { action: "updateConfig"; payload: Partial<OpenAGConfig> }
  | { action: "recalculateStats"; payload?: undefined };

export class WebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "openag.accounts";
  private view?: vscode.WebviewView;
  private isDirty = false;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly tokenManager: TokenManager,
    private readonly quotaMonitor: QuotaMonitor,
    private readonly log: (msg: string) => void,
    private readonly logManager: LogManager,
    private readonly statsManager?: StatsManager,
    private readonly usageTracker?: UsageTracker,
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview();
    this.setWebviewMessageListener(webviewView.webview);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && (this.isDirty || !this.view)) {
        this.postState();
      }
    });

    this.postState();
  }

  public refresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.postState();
    }, 150);
  }

  private getCurrentStateData(): Record<string, unknown> {
    const accounts = this.tokenManager.getAccounts();
    const activeEmail = this.tokenManager.getActiveEmail();
    const quotas = this.quotaMonitor.getAllQuotas();
    const config = this.tokenManager.getConfig();
    const logs = this.logManager.getLogs();
    const todayStats = this.statsManager?.getTodayStats() || {
      date: new Date().toISOString().slice(0, 10),
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      totalTokens: 0,
      models: {},
      conversations: {},
    };
    const hourlyStats = this.statsManager?.getTodayHourlyStats() || [];
    const dailyStats = this.statsManager?.getDailyStats(7) || [];
    const weeklyStats = this.statsManager?.getWeeklyStats(4) || [];
    const monthlyStats = this.statsManager?.getMonthlyStats(12) || [];
    const conversationsList = this.statsManager?.getConversationsList(40) || [];
    const requestsList = this.statsManager?.getRequestsList(40) || [];
    const allTimeSummary = this.statsManager?.getAllTimeSummary() || {
      inputTokens: 0,
      outputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      totalTokens: 0,
      totalTurns: 0,
      cacheHitRate: 0,
    };

    return {
      accounts,
      activeEmail,
      quotas,
      config,
      logs,
      stats: {
        today: todayStats,
        hourly: hourlyStats,
        daily: dailyStats,
        weekly: weeklyStats,
        monthly: monthlyStats,
        conversations: conversationsList,
        requests: requestsList,
        allTime: allTimeSummary,
        burnRate: this.statsManager?.getBurnRate(15) || { tokensPerMin: 0, recentTurns: 0 },
      },
    };
  }

  private postState(): void {
    if (!this.view) return;
    if (!this.view.visible) {
      this.isDirty = true;
      return;
    }
    this.isDirty = false;
    try {
      void this.view.webview.postMessage({
        type: "state",
        data: this.getCurrentStateData(),
      });
    } catch (e: unknown) {
      this.log(`postState error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private setWebviewMessageListener(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(async (message: WebviewMessage) => {
      try {
        switch (message.action) {
          case "ready":
            this.postState();
            break;
          case "addAccount":
            await vscode.commands.executeCommand("openag.addAccount");
            break;
          case "refreshQuotas":
            await this.quotaMonitor.pollAllAccounts();
            this.refresh();
            break;
          case "toggleAccount":
            if (message.payload) {
              await this.tokenManager.toggleAccountEnabled(message.payload.email, message.payload.enabled);
              void this.quotaMonitor.pollAllAccounts();
              this.refresh();
            }
            break;
          case "updateAccountMeta":
            if (message.payload) {
              await this.tokenManager.updateAccountMeta(message.payload.email, message.payload);
              this.refresh();
            }
            break;
          case "reauthAccount":
            if (message.payload) {
              try {
                const acc = await this.tokenManager.reauthAccount(message.payload);
                void this.quotaMonitor.refreshAccountQuota(acc.email);
                void vscode.window.showInformationMessage(`OpenAG: Re-authenticated ${acc.email}`);
              } catch (e: unknown) {
                void vscode.window.showErrorMessage(`OpenAG: Re-auth failed - ${e instanceof Error ? e.message : String(e)}`);
              }
              this.refresh();
            }
            break;
          case "refreshAccount":
            if (message.payload) {
              await this.quotaMonitor.refreshAccountQuota(message.payload);
              this.refresh();
            }
            break;
          case "removeAccount":
            if (message.payload) {
              await this.tokenManager.removeAccount(message.payload);
              this.refresh();
            }
            break;
          case "clearLogs":
            this.logManager.clear();
            this.refresh();
            break;
          case "updateConfig":
            if (message.payload) {
              await this.tokenManager.updateConfig(message.payload);
              this.refresh();
            }
            break;
          case "recalculateStats":
            if (this.statsManager) {
              await this.statsManager.resetAndRecalculate(BRAIN_DIR);
              this.usageTracker?.resetProcessedLines();
              this.refresh();
            }
            break;
        }
      } catch (err: unknown) {
        this.log(`Message handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  private getHtmlForWebview(): string {
    const initialStateJson = JSON.stringify(this.getCurrentStateData()).replace(/</g, "\\u003c");
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>
:root {
  --bg: var(--vscode-sideBar-background, #1e1e2e);
  --card: var(--vscode-editor-background, #181825);
  --border: var(--vscode-widget-border, rgba(255,255,255,.08));
  --text: var(--vscode-foreground, #cdd6f4);
  --dim: var(--vscode-descriptionForeground, #a6adc8);
  --accent: var(--vscode-button-background, #0078d4);
  --accent-h: var(--vscode-button-hoverBackground, #006abc);
  --hover: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));
  --badge-bg: var(--vscode-badge-background, rgba(0,120,212,.25));
  --badge-fg: var(--vscode-badge-foreground, #fff);
  --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  --mono: var(--vscode-editor-font-family, monospace);
  --warn: #f59e0b;
  --danger: #ef4444;
  --success: #10b981;
  --cached: #a855f7;
  --input-col: #3b82f6;
  --output-col: #10b981;
  --thinking-col: #f59e0b;
}
* { box-sizing: border-box; margin: 0; padding: 0; user-select: none; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.15) transparent; }
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,.15); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.35); }
::-webkit-scrollbar-corner { background: transparent; }

body { font-family: var(--font); background: var(--bg); color: var(--text); padding: 8px; display: flex; flex-direction: column; gap: 8px; overflow-x: hidden; font-size: 11px; }

.row { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.badge { background: var(--accent); color: #fff; font-weight: 700; font-size: 10px; padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
.info-badge { display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; border-radius: 50%; background: rgba(255,255,255,.1); color: var(--dim); font-size: 9px; font-weight: 700; font-family: var(--mono); cursor: help; user-select: none; border: 1px solid var(--border); transition: background .12s, color .12s; }
.info-badge:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
.sec-head { font-size: 10.5px; font-weight: 600; color: var(--dim); margin-top: 2px; display: flex; align-items: center; justify-content: space-between; }

.btn-row { display: flex; gap: 4px; align-items: center; justify-content: flex-end; flex-shrink: 0; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 3px; background: var(--accent); color: #fff; border: 1px solid transparent; border-radius: 4px; padding: 3px 7px; font-family: var(--font); font-size: 10.5px; font-weight: 500; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.btn:hover { background: var(--accent-h); }
.btn-sec { background: var(--card); color: var(--text); border-color: var(--border); }
.btn-sec:hover { background: var(--hover); }
.btn-icon { padding: 1px 4px; font-size: 9.5px; }

.sort-select { background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 4px; padding: 1px 3px; font-size: 9px; font-family: var(--font); outline: none; cursor: pointer; }
.sort-select:focus { border-color: var(--accent); }

.segmented-tabs { display: flex; background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 2px; gap: 2px; width: 100%; }
.tab-btn { flex: 1; min-width: 0; padding: 3px 2px; font-size: 10px; font-weight: 600; font-family: var(--font); background: transparent; color: var(--dim); border: none; border-radius: 3px; cursor: pointer; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background .12s, color .12s; }
.tab-btn:hover { color: var(--text); background: var(--hover); }
.tab-btn.active { background: var(--accent); color: #fff; }

.card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 5px; min-width: 0; contain: content; }
.card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; }
.card-title { font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; user-select: text; }
.card-head .card-title { flex: 1; }

.card-meta { font-size: 9px; font-family: var(--mono); color: var(--dim); display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: -1px; }
.card-breakdown { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; background: transparent; border: none; padding: 0; margin-top: 1px; }
.cb-item { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cb-lbl { font-size: 8px; color: var(--dim); text-transform: uppercase; font-weight: 600; letter-spacing: 0.3px; }
.cb-val { font-size: 10.5px; font-weight: 700; font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.tier-tag { font-size: 8.5px; font-weight: 700; padding: 1px 4px; border-radius: 3px; text-transform: uppercase; background: var(--badge-bg); color: var(--badge-fg); flex-shrink: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
.active-tag { font-size: 8.5px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: rgba(16,185,129,.15); color: var(--success); border: 1px solid rgba(16,185,129,.4); flex-shrink: 0; }
.dis-tag { font-size: 8.5px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: rgba(255,255,255,.08); color: var(--dim); flex-shrink: 0; }
.chip-tag { font-size: 8px; font-weight: 700; font-family: var(--mono); padding: 1px 4px; border-radius: 3px; background: rgba(255,255,255,.08); color: var(--text); border: 1px solid var(--border); cursor: pointer; user-select: none; flex-shrink: 0; }
.chip-tag:hover { background: var(--hover); border-color: var(--accent); }
.err-tag { font-size: 8px; font-weight: 700; font-family: var(--mono); padding: 1px 4px; border-radius: 3px; background: rgba(239,68,68,.15); color: var(--danger); border: 1px solid rgba(239,68,68,.4); flex-shrink: 0; }
.warn-tag { font-size: 8px; font-weight: 700; font-family: var(--mono); padding: 1px 4px; border-radius: 3px; background: rgba(245,158,11,.15); color: var(--warn); border: 1px solid rgba(245,158,11,.4); flex-shrink: 0; }

.quota-row { display: flex; align-items: center; justify-content: space-between; font-size: 10px; gap: 4px; min-width: 0; }
.progress-bg { position: relative; flex: 1; height: 5px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; min-width: 20px; }
.progress-fill { height: 100%; width: 100%; transform-origin: 0% 50%; will-change: transform; transition: transform .25s cubic-bezier(0.4, 0, 0.2, 1); background: var(--accent); border-radius: 3px; }
.progress-fill.warn { background: var(--warn); }
.progress-fill.err { background: var(--danger); }
.reset-tag { font-size: 8.5px; font-family: var(--mono); padding: 1px 3px; border-radius: 3px; background: rgba(255,255,255,.06); color: var(--dim); white-space: nowrap; flex-shrink: 0; }
.reset-tag.active { background: rgba(0,120,212,.2); color: #60a5fa; }

.switch { position: relative; display: inline-block; width: 26px; height: 14px; cursor: pointer; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.slider { position: absolute; inset: 0; background: rgba(255,255,255,.15); border-radius: 10px; transition: .18s; }
.slider::before { position: absolute; content: ""; height: 8px; width: 8px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: .18s; }
.switch input:checked + .slider { background: var(--accent); }
.switch input:checked + .slider::before { transform: translateX(12px); }
.switch.disabled { opacity: .4; cursor: not-allowed; }

.segmented-bar { display: flex; width: 100%; height: 6px; border-radius: 3px; overflow: hidden; background: rgba(255,255,255,.08); }
.seg-inp { background: var(--input-col); height: 100%; transition: width .3s; }
.seg-out { background: var(--output-col); height: 100%; transition: width .3s; }
.seg-cac { background: var(--cached); height: 100%; transition: width .3s; }
.seg-thk { background: var(--thinking-col); height: 100%; transition: width .3s; }

g.bar-group { cursor: pointer; transition: opacity .15s; }
g.bar-group.dimmed { opacity: 0.32; }
g.bar-group:hover rect { filter: brightness(1.15); }

.stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.stat-box { background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.stat-val { font-size: 13px; font-weight: 700; font-family: var(--mono); color: var(--text); }
.stat-lbl { font-size: 9px; color: var(--dim); }

.scroll-box { display: flex; flex-direction: column; gap: 5px; max-height: 220px; overflow-y: auto; overflow-x: hidden; padding-right: 1px; contain: content; will-change: scroll-position; }
.log-scroll { display: flex; flex-direction: column; gap: 5px; max-height: 24vh; overflow-y: auto; overflow-x: hidden; padding-right: 1px; contain: content; will-change: scroll-position; }
.log-card { background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 5px 7px; display: flex; flex-direction: column; gap: 3px; min-width: 0; user-select: text; contain: content; content-visibility: auto; contain-intrinsic-size: 0 42px; }
.log-card * { user-select: text; }
.log-meta { display: flex; align-items: center; justify-content: space-between; gap: 4px; font-size: 9px; color: var(--dim); }
.log-msg { font-size: 10px; line-height: 1.4; word-break: normal; overflow-wrap: anywhere; }
.log-msg.error { color: #f87171; }
.log-msg.warn { color: #fbbf24; }
.log-msg.rotate { color: #6ee7b7; }

.chart-scroll-box { width: 100%; overflow-x: auto; overflow-y: hidden; margin-top: 6px; contain: content; will-change: scroll-position; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
.chart-scroll-box::-webkit-scrollbar { height: 4px; }
.chart-scroll-box::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 2px; }
.chart-svg { height: 145px; overflow: visible; display: block; }
.h-scroll-box { display: flex; flex-direction: row; gap: 6px; overflow-x: auto; overflow-y: hidden; padding: 2px 1px 6px 1px; scrollbar-width: thin; -webkit-overflow-scrolling: touch; will-change: scroll-position; }
.square-card { flex: 0 0 168px; width: 168px; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 7px 8px; display: flex; flex-direction: column; gap: 3px; user-select: text; contain: content; }
.square-card .card-title { flex: 0 0 auto; margin: 1px 0 2px 0; }
.empty { padding: 12px; text-align: center; color: var(--dim); font-size: 10.5px; }
</style></head><body>

<div id="view-home" style="display:flex;flex-direction:column;gap:8px;">
  <div class="row" style="padding-bottom:6px;border-bottom:1px solid var(--border);">
    <div style="display:flex;align-items:center;gap:5px;">
      <span class="badge">OPENAG</span>
      <span style="font-size:10px;color:var(--dim);">Account Pool</span>
    </div>
    <label class="switch" title="Toggle OpenAG"><input type="checkbox" id="cfg-enabled" data-action="toggleEnabled" checked /><span class="slider"></span></label>
  </div>

  <div class="row">
    <div style="display:flex;align-items:center;gap:4px;">
      <span style="font-size:9.5px;color:var(--dim);font-weight:600;">Strategy:</span>
      <select class="sort-select" id="cfg-strategy" data-action="changeStrategy" style="font-size:9.5px;padding:2px 4px;">
        <option value="auto_highest" title="Auto-Highest: Maximizes quota throughput. Drains imminent reset windows and switches to the highest available quota.">Auto-Highest</option>
        <option value="cache_optimized" title="Cache Optimized: Maximizes inference cache hits by sticking to the active account until quota drops below 15%, minimizing latency and token consumption.">Cache Optimized</option>
        <option value="round_robin" title="Round Robin: Cycles through accounts evenly to distribute usage across the entire pool.">Round Robin</option>
      </select>
      <span class="info-badge" title="OpenAG Rotation:&#10;&#10;Active Across All Strategies:&#10;• Tier Priority: Always burns Ultra/Pro/Plus accounts before touching Free tier accounts.&#10;• Timing Priority (Drain Window): Holds active account if its 5h window resets in &lt;=30 mins (&gt;5% quota) to consume capacity before refill.&#10;• Reserve Gating: Uses Primary pool until all drop to &lt;=10%, then unlocks Reserve pool.&#10;• Model Affinity: Routes prompts according to active model family (Gemini vs Claude/GPT-OSS).&#10;• 429 Interception: Sub-second auto-rotation on API rate limits.&#10;&#10;Selectable Strategies:&#10;• Auto-Highest: Selects highest quota with +1000 score bonus for &lt;=45m refills.&#10;• Cache Optimized: Holds active account while quota &gt;15% to maintain warm GPU prefix cache.&#10;• Round Robin: Cycles evenly across healthy accounts while respecting tier & timing.">!</span>
    </div>
    <div class="btn-row">
      <button class="btn btn-sec" data-action="refreshQuotas" title="Refresh quotas">Refresh</button>
      <button class="btn" data-action="addAccount" title="Add Google Account">+ Add</button>
    </div>
  </div>

  <div class="sec-head">
    <div style="display:flex;align-items:center;gap:5px;">
      <span>Accounts Pool</span>
    </div>
    <div style="display:flex;align-items:center;gap:4px;">
      <span id="acc-count" style="font-size:9px;font-family:var(--mono);color:var(--dim);">0 accounts</span>
      <button class="btn btn-sec btn-icon" data-action="toggleHideEmail" id="btn-hide-email" title="Toggle Hide Email" style="font-size:9px;padding:1px 5px;">Hide Email</button>
    </div>
  </div>
  <div id="acc-list" style="display:flex;flex-direction:column;gap:5px;"></div>

  <div class="sec-head">Token Usage Statistics</div>
  <div id="stats-widget"></div>

  <div class="sec-head">
    <span>Event Stream</span>
    <div style="display:flex;gap:4px;align-items:center;">
      <span id="log-count" style="font-size:9px;font-family:var(--mono);color:var(--dim);">0 logs</span>
      <button class="btn btn-sec btn-icon" data-action="clearLogs" title="Clear logs">Clear</button>
    </div>
  </div>
  <div class="log-scroll" id="log-scroll"></div>
</div>

<div id="view-stats" style="display:none;flex-direction:column;gap:8px;">
  <div class="row" style="padding-bottom:6px;border-bottom:1px solid var(--border);">
    <div style="display:flex;align-items:center;gap:5px;">
      <span class="badge">OPENAG</span>
      <span style="font-size:10px;color:var(--dim);">Token Statistics</span>
    </div>
    <button class="btn btn-sec" data-action="nav" data-view="home">&larr; Back</button>
  </div>

  <div class="sec-head" style="margin-top:0;">
    <span>Time Horizon</span>
    <button class="btn btn-sec btn-icon" data-action="recalculateStats" title="Recalculate statistics from conversation transcripts">&#x21bb; Sync</button>
  </div>

  <div class="segmented-tabs">
    <button class="tab-btn active" id="tab-today" data-action="range" data-range="today">Today</button>
    <button class="tab-btn" id="tab-daily" data-action="range" data-range="daily">7D</button>
    <button class="tab-btn" id="tab-weekly" data-action="range" data-range="weekly">4W</button>
    <button class="tab-btn" id="tab-monthly" data-action="range" data-range="monthly">12M</button>
  </div>

  <div class="card" style="padding:10px 8px;">
    <div class="card-head" style="flex-wrap:wrap;gap:4px;">
      <span class="card-title" id="chart-title" style="min-width:110px;">Token Consumption</span>
      <div style="display:flex;gap:7px;font-size:8.5px;flex-shrink:0;margin-left:auto;">
        <span style="display:flex;align-items:center;gap:3px;"><span style="width:7px;height:7px;border-radius:2px;background:var(--cached);"></span>Cache Hit</span>
        <span style="display:flex;align-items:center;gap:3px;"><span style="width:7px;height:7px;border-radius:2px;background:var(--input-col);"></span>New Input</span>
        <span style="display:flex;align-items:center;gap:3px;"><span style="width:7px;height:7px;border-radius:2px;background:var(--thinking-col);"></span>Thinking</span>
        <span style="display:flex;align-items:center;gap:3px;"><span style="width:7px;height:7px;border-radius:2px;background:var(--output-col);"></span>Output</span>
      </div>
    </div>
    <div class="chart-scroll-box" id="chart-container"></div>
  </div>

  <div class="sec-head">
    <span id="cumulative-title">Metrics</span>
  </div>
  <div class="stats-grid" id="alltime-grid"></div>

  <div class="sec-head">
    <span>Usage per Request</span>
    <div style="display:flex;align-items:center;gap:3px;">
      <span id="req-count" style="font-size:9px;font-family:var(--mono);color:var(--dim);">0 reqs</span>
      <select class="sort-select" id="sort-sel-requests" data-action="changeSortField" data-section="requests">
        <option value="recent" selected>Recent</option>
        <option value="total">Volume</option>
        <option value="cachePct">Cache Rate</option>
        <option value="input">Input</option>
        <option value="output">Output</option>
        <option value="cache">Cache</option>
        <option value="turns">Turns</option>
      </select>
      <button class="btn btn-sec btn-icon" id="sort-dir-requests" data-action="toggleSortDir" data-section="requests" title="Toggle Ascending / Descending">▼</button>
    </div>
  </div>
  <div class="h-scroll-box" id="request-breakdown"></div>

  <div class="sec-head">
    <div style="display:flex;align-items:center;gap:4px;">
      <span>Usage by Model</span>
      <span class="info-badge" title="This is showing model ID, not the model name">!</span>
    </div>
    <div style="display:flex;align-items:center;gap:3px;">
      <span id="model-count" style="font-size:9px;font-family:var(--mono);color:var(--dim);">0 models</span>
      <select class="sort-select" id="sort-sel-models" data-action="changeSortField" data-section="models">
        <option value="total" selected>Volume</option>
        <option value="cachePct">Cache Rate</option>
        <option value="input">Input</option>
        <option value="output">Output</option>
        <option value="cache">Cache</option>
        <option value="name">Name</option>
      </select>
      <button class="btn btn-sec btn-icon" id="sort-dir-models" data-action="toggleSortDir" data-section="models" title="Toggle Ascending / Descending">▼</button>
    </div>
  </div>
  <div class="h-scroll-box" id="model-breakdown"></div>

  <div class="sec-head">
    <span>Usage by Session</span>
    <div style="display:flex;align-items:center;gap:3px;">
      <span id="conv-count" style="font-size:9px;font-family:var(--mono);color:var(--dim);">0 sessions</span>
      <select class="sort-select" id="sort-sel-conversations" data-action="changeSortField" data-section="conversations">
        <option value="recent" selected>Recent</option>
        <option value="total">Volume</option>
        <option value="cachePct">Cache Rate</option>
        <option value="input">Input</option>
        <option value="output">Output</option>
        <option value="cache">Cache</option>
        <option value="turns">Turns</option>
      </select>
      <button class="btn btn-sec btn-icon" id="sort-dir-conversations" data-action="toggleSortDir" data-section="conversations" title="Toggle Ascending / Descending">▼</button>
    </div>
  </div>
  <div class="h-scroll-box" id="conv-breakdown"></div>
</div>

<script>
var vscode = acquireVsCodeApi();
var state = ${initialStateJson};
var currentView = "home";
var statsRange = "today";
var selectedBarIndex = null;
var selectedBarLabel = null;
var hideEmail = false;
var accountsExpanded = false;
var sortConfig = {
  requests: { field: "recent", dir: "desc" },
  models: { field: "total", dir: "desc" },
  conversations: { field: "recent", dir: "desc" }
};

function send(action, payload) { vscode.postMessage({ action: action, payload: payload }); }
function esc(s) { return s ? String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;") : ""; }
function fmtNum(n) { return typeof n === "number" ? (n >= 1e6 ? (n/1e6).toFixed(2)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"k" : n.toLocaleString()) : "0"; }
function fmtDateTime(ts) { return ts ? new Date(ts).toLocaleString() : ""; }

function maskEmail(email, index) {
  if (!email) return "";
  if (!hideEmail) return email;
  if (typeof index === "number") return "Account " + (index + 1);
  var accs = (state && Array.isArray(state.accounts)) ? state.accounts.filter(Boolean) : [];
  for (var i = 0; i < accs.length; i++) {
    if (accs[i].email && accs[i].email.toLowerCase() === email.toLowerCase()) {
      return "Account " + (i + 1);
    }
  }
  return "Account";
}

function sanitizeTextForDisplay(text) {
  if (!text || !hideEmail) return text || "";
  var accs = (state && Array.isArray(state.accounts)) ? state.accounts.filter(Boolean) : [];
  var res = String(text);
  for (var i = 0; i < accs.length; i++) {
    if (accs[i].email) {
      res = res.split(accs[i].email).join("Account " + (i + 1));
    }
  }
  res = res.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+[.][a-zA-Z]{2,}/g, "Account");
  return res;
}

document.addEventListener("click", function(e) {
  var target = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
  if (!target) return;
  var action = target.getAttribute("data-action");
  if (action === "nav") {
    navTo(target.getAttribute("data-view"));
  } else if (action === "range") {
    setStatsRange(target.getAttribute("data-range"));
  } else if (action === "selectBar") {
    var bIdx = parseInt(target.getAttribute("data-index"), 10);
    if (!isNaN(bIdx)) {
      if (selectedBarIndex === bIdx) {
        selectedBarIndex = null;
        selectedBarLabel = null;
      } else {
        selectedBarIndex = bIdx;
        selectedBarLabel = target.getAttribute("data-label") || null;
      }
      renderStatsPage(true);
    }
  } else if (action === "clearBarFilter") {
    selectedBarIndex = null;
    selectedBarLabel = null;
    renderStatsPage(true);
  } else if (action === "toggleHideEmail") {
    hideEmail = !hideEmail;
    var btn = document.getElementById("btn-hide-email");
    if (btn) btn.textContent = hideEmail ? "Show Email" : "Hide Email";
    send("updateConfig", { hideEmail: hideEmail });
    lastAccountsFp = "";
    lastLogHideEmail = null;
    renderAccounts();
    renderLogs();
  } else if (action === "toggleExpandAccounts") {
    accountsExpanded = !accountsExpanded;
    lastAccountsFp = "";
    renderAccounts();
  } else if (action === "toggleSortDir") {
    var sec = target.getAttribute("data-section");
    if (sec && sortConfig[sec]) {
      sortConfig[sec].dir = sortConfig[sec].dir === "desc" ? "asc" : "desc";
      renderStatsPage(true);
    }
  } else if (action === "toggleAffinity") {
    var affEmail = target.getAttribute("data-email");
    var curAff = target.getAttribute("data-affinity") || "all";
    var nextAff = curAff === "all" ? "claude" : curAff === "claude" ? "gemini" : "all";
    send("updateAccountMeta", { email: affEmail, affinity: nextAff });
  } else if (action === "toggleRole") {
    var roleEmail = target.getAttribute("data-email");
    var curRole = target.getAttribute("data-role") || "primary";
    var nextRole = curRole === "primary" ? "reserve" : "primary";
    send("updateAccountMeta", { email: roleEmail, role: nextRole });
  } else if (action === "editAlias") {
    var aliasEmail = target.getAttribute("data-email");
    var curAlias = target.getAttribute("data-alias") || "";
    var newAlias = prompt("Enter alias for " + aliasEmail + " (leave empty to clear):", curAlias);
    if (newAlias !== null) {
      send("updateAccountMeta", { email: aliasEmail, alias: newAlias.trim() });
    }
  } else if (action === "reauthAccount") {
    send("reauthAccount", target.getAttribute("data-email"));
  } else if (action === "refreshAccount") {
    send("refreshAccount", target.getAttribute("data-email"));
  } else if (action === "removeAccount") {
    send("removeAccount", target.getAttribute("data-email"));
  } else if (action === "addAccount") {
    send("addAccount");
  } else if (action === "refreshQuotas") {
    send("refreshQuotas");
  } else if (action === "clearLogs") {
    send("clearLogs");
  } else if (action === "recalculateStats") {
    send("recalculateStats");
  }
});

document.addEventListener("change", function(e) {
  var target = e.target;
  if (!target) return;
  var action = target.getAttribute("data-action");
  if (action === "changeSortField") {
    var sec = target.getAttribute("data-section");
    if (sec && sortConfig[sec]) {
      sortConfig[sec].field = target.value;
      renderStatsPage(true);
    }
  } else if (action === "toggleAccount") {
    send("toggleAccount", { email: target.getAttribute("data-email"), enabled: target.checked });
  } else if (action === "toggleEnabled") {
    send("updateConfig", { enabled: target.checked });
  } else if (action === "changeStrategy") {
    send("updateConfig", { rotationStrategy: target.value });
  }
});

var viewStatsEl = document.getElementById("view-stats");
if (viewStatsEl) {
  viewStatsEl.addEventListener("wheel", function(e) {
    var hScroll = e.target && e.target.closest ? e.target.closest(".h-scroll-box, .chart-scroll-box") : null;
    if (hScroll && Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
      var canScrollRight = e.deltaY > 0 && (hScroll.scrollLeft + hScroll.clientWidth < hScroll.scrollWidth - 4);
      var canScrollLeft = e.deltaY < 0 && hScroll.scrollLeft > 4;
      if (canScrollRight || canScrollLeft) {
        hScroll.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    }
  }, { passive: false });
}

var pendingRender = false;
function scheduleRender() {
  if (pendingRender) return;
  pendingRender = true;
  requestAnimationFrame(function() {
    pendingRender = false;
    render();
  });
}

window.addEventListener("message", function(e) {
  if (e.data && e.data.type === "state" && e.data.data) {
    state = e.data.data;
    scheduleRender();
  }
});

var shouldScrollChart = true;
function navTo(view) {
  currentView = view;
  var homeEl = document.getElementById("view-home");
  var statsEl = document.getElementById("view-stats");
  if (homeEl) homeEl.style.display = view === "home" ? "flex" : "none";
  if (statsEl) statsEl.style.display = view === "stats" ? "flex" : "none";
  if (view === "home") {
    lastAccountsFp = "";
    lastStatsWidgetFp = "";
    renderAccounts();
    renderStatsWidget();
    renderLogs();
  } else if (view === "stats") {
    shouldScrollChart = true;
    renderStatsPage(true);
  }
}

function updateTabStyles() {
  var tabs = { today: document.getElementById("tab-today"), daily: document.getElementById("tab-daily"), weekly: document.getElementById("tab-weekly"), monthly: document.getElementById("tab-monthly") };
  for (var k in tabs) {
    var el = tabs[k];
    if (el) {
      if (k === statsRange) el.classList.add("active");
      else el.classList.remove("active");
    }
  }
}

function setStatsRange(range) {
  statsRange = range;
  selectedBarIndex = null;
  selectedBarLabel = null;
  shouldScrollChart = true;
  updateTabStyles();
  renderStatsPage(true);
}

function fmtTime(s) {
  if (!s) return "";
  var target = new Date(s);
  var d = target.getTime() - Date.now();
  if (d <= 0 || isNaN(d)) return "ready";
  var days = Math.floor(d / 864e5), hrs = Math.floor((d % 864e5) / 36e5), mins = Math.floor((d % 36e5) / 6e4);
  var rel = days > 0 ? days + "d " + hrs + "h" : hrs > 0 ? hrs + "h " + mins + "m" : mins + "m";
  var hrsStr = String(target.getHours()).padStart(2, "0");
  var minsStr = String(target.getMinutes()).padStart(2, "0");
  var localClock = hrsStr + ":" + minsStr;
  return rel + " (" + localClock + ")";
}

function render() {
  try {
    if (state && state.config) {
      var cfgEnabled = document.getElementById("cfg-enabled");
      if (cfgEnabled) {
        cfgEnabled.checked = state.config.enabled !== false;
      }
      var cfgStrat = document.getElementById("cfg-strategy");
      if (cfgStrat) {
        cfgStrat.value = state.config.rotationStrategy || "auto_highest";
      }
      if (typeof state.config.hideEmail === "boolean") {
        hideEmail = state.config.hideEmail;
      }
    }
    var btn = document.getElementById("btn-hide-email");
    if (btn) btn.textContent = hideEmail ? "Show Email" : "Hide Email";

    if (currentView === "home") {
      renderAccounts();
      renderStatsWidget();
      renderLogs();
    } else if (currentView === "stats") {
      renderStatsPage(false);
    }
  } catch (err) {
    console.error("render error:", err);
  }
}

function makeBarHtml(label, pct, resetIso) {
  var p = typeof pct === "number" ? Math.min(100, Math.max(0, pct)) : 100;
  var cls = p < 20 ? "err" : p < 40 ? "warn" : "";
  var resetText = fmtTime(resetIso);
  var rTag = resetIso ? '<span class="reset-tag ' + (resetText !== "ready" ? "active" : "") + '" data-reset="' + resetIso + '">' + resetText + '</span>' : '';
  var scale = (p / 100).toFixed(3);
  return '<div class="quota-row">' +
    '<div style="display:flex;align-items:center;gap:3px;flex:1;min-width:0;overflow:hidden;">' +
      '<span style="color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(label) + '</span>' +
      rTag +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:4px;width:48%;min-width:55px;max-width:110px;flex-shrink:0;">' +
      '<div class="progress-bg"><div class="progress-fill ' + cls + '" style="transform:scaleX(' + scale + ');"></div></div>' +
      '<span style="font-family:var(--mono);font-size:9.5px;width:26px;text-align:right;flex-shrink:0;">' + p + '%</span>' +
    '</div>' +
  '</div>';
}

var lastAccountsFp = "";
function renderAccounts() {
  var list = document.getElementById("acc-list");
  if (!list) return;
  var accs = (state && Array.isArray(state.accounts)) ? state.accounts.filter(Boolean) : [];
  var accCountEl = document.getElementById("acc-count");
  if (accCountEl) accCountEl.textContent = accs.length + (accs.length === 1 ? " acc" : " accs");
  if (!accs.length) {
    lastAccountsFp = "";
    list.innerHTML = '<div class="empty">No accounts in pool.<br>Click <strong>+ Add</strong> or sign in via Antigravity.</div>';
    var emptyRefEl = document.getElementById("quota-last-refreshed");
    if (emptyRefEl) emptyRefEl.textContent = "";
    return;
  }
  var quotas = (state && state.quotas && typeof state.quotas === "object") ? state.quotas : {};
  var visibleAccs = (!accountsExpanded && accs.length > 3) ? accs.slice(0, 3) : accs;

  var fp = (hideEmail ? "1" : "0") + "|" + (accountsExpanded ? "1" : "0") + "|" + (state.activeEmail || "") + "|" + visibleAccs.length;
  for (var fi = 0; fi < visibleAccs.length; fi++) {
    var fa = visibleAccs[fi];
    var fq = fa.email ? quotas[fa.email.toLowerCase()] : null;
    fp += "|" + fa.email + ":" + fa.status + ":" + fa.tier + ":" + fa.alias + ":" + fa.affinity + ":" + fa.role + ":" + fa.health;
    if (fq) {
      fp += ":" + (fq.lastUpdated || 0) + ":" + (fq.percent || 0);
      if (Array.isArray(fq.families)) {
        for (var ff = 0; ff < fq.families.length; ff++) {
          var fam = fq.families[ff];
          if (fam) fp += ":" + fam.key + ":" + (fam.limit5h ? fam.limit5h.percent : fam.percent) + ":" + (fam.limitWeekly ? fam.limitWeekly.percent : "");
        }
      }
    }
  }
  if (fp === lastAccountsFp) return;
  lastAccountsFp = fp;

  var latestRefresh = 0;
  for (var k in quotas) {
    if (quotas[k] && typeof quotas[k].lastUpdated === "number" && quotas[k].lastUpdated > latestRefresh) {
      latestRefresh = quotas[k].lastUpdated;
    }
  }
  var qRefEl = document.getElementById("quota-last-refreshed");
  if (qRefEl) {
    qRefEl.textContent = latestRefresh > 0 ? ("Refreshed: " + fmtDateTime(latestRefresh)) : "";
  }

  var cardsHtml = visibleAccs.map(function(acc, idx) {
    var email = acc.email || "";
    var displayEmail = hideEmail ? ("Account " + (idx + 1)) : (acc.alias ? (acc.alias + " (" + email.split("@")[0] + ")") : email);
    var titleAttr = hideEmail ? ("Account " + (idx + 1)) : email;
    var isDis = acc.status === "disabled";
    var isAct = !isDis && email && email.toLowerCase() === ((state && state.activeEmail) || "").toLowerCase();
    var q = (email && quotas[email.toLowerCase()]) || {};
    var fams = (Array.isArray(q.families) && q.families.length) ? q.families : [{ key: "gemini", label: "Gemini", percent: 100 }, { key: "claude", label: "Claude", percent: 100 }];
    var qHtml = '<div style="display:flex;flex-direction:column;gap:3px;">' + fams.map(function(f) {
      if (!f) return "";
      var html = makeBarHtml((f.label || "Model") + " (5h)", f.limit5h ? f.limit5h.percent : (f.percent || 100), f.limit5h ? f.limit5h.resetTime : f.resetTime);
      if (f.limitWeekly) html += makeBarHtml((f.label || "Model") + " (7d)", f.limitWeekly.percent, f.limitWeekly.resetTime);
      return html;
    }).join("") + '</div>';
    var tag = isAct ? '<span class="active-tag">ACTIVE</span>' : isDis ? '<span class="dis-tag">OFF</span>' : '';
    var affTag = '<span class="chip-tag" data-action="toggleAffinity" data-email="' + esc(email) + '" data-affinity="' + esc(acc.affinity || "all") + '" title="Model Affinity: ' + esc(acc.affinity || "all") + ' (click to change)">' + esc((acc.affinity || "all").toUpperCase()) + '</span>';
    var roleTag = '<span class="chip-tag" data-action="toggleRole" data-email="' + esc(email) + '" data-role="' + esc(acc.role || "primary") + '" title="Pool Role: ' + esc(acc.role || "primary") + ' (click to change)">' + esc((acc.role || "primary").toUpperCase()) + '</span>';
    var healthBadge = (acc.health && acc.health !== "healthy")
      ? ('<span class="err-tag" title="' + esc(acc.healthError || "Token requires re-authentication") + '">' + (acc.health === "expired" ? "EXPIRED" : acc.health === "tos_required" ? "TOS REQ" : "ERROR") + '</span>')
      : "";
    var reauthBtn = (acc.health && acc.health !== "healthy")
      ? ('<button class="btn btn-sec btn-icon" data-action="reauthAccount" data-email="' + esc(email) + '" title="1-Click Re-Auth" style="color:var(--warn);border-color:var(--warn);font-size:8.5px;padding:1px 4px;">Re-Auth</button>')
      : "";
    return '<div class="card ' + (isAct ? "active" : "") + ' ' + (isDis ? "disabled" : "") + '">' +
      '<div class="card-head">' +
        '<div style="display:flex;align-items:center;gap:3px;overflow:hidden;flex:1;min-width:0;">' +
          '<span class="tier-tag">' + esc(acc.tier || "pro") + '</span>' +
          '<span class="card-title" title="' + esc(titleAttr) + '" data-action="editAlias" data-email="' + esc(email) + '" data-alias="' + esc(acc.alias || "") + '" style="cursor:pointer;">' + esc(displayEmail) + '</span>' +
          affTag +
          roleTag +
          healthBadge +
          tag +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">' +
          reauthBtn +
          '<label class="switch" title="' + (isDis ? "Enable in pool" : "Disable in pool") + '">' +
            '<input type="checkbox" ' + (isDis ? "" : "checked") + ' data-action="toggleAccount" data-email="' + esc(email) + '" />' +
            '<span class="slider"></span>' +
          '</label>' +
          '<button class="btn btn-sec btn-icon" data-action="refreshAccount" data-email="' + esc(email) + '" title="Refresh">&#x21bb;</button>' +
          '<button class="btn btn-sec btn-icon" data-action="removeAccount" data-email="' + esc(email) + '" title="Remove">&times;</button>' +
        '</div>' +
      '</div>' +
      qHtml +
    '</div>';
  }).join("");

  var expandBtn = "";
  if (accs.length > 3) {
    expandBtn = !accountsExpanded
      ? '<button class="btn btn-sec" data-action="toggleExpandAccounts" style="width:100%;margin-top:2px;font-size:9.5px;padding:3px 6px;">Show more (' + (accs.length - 3) + ' more) &#x25bc;</button>'
      : '<button class="btn btn-sec" data-action="toggleExpandAccounts" style="width:100%;margin-top:2px;font-size:9.5px;padding:3px 6px;">Show less &#x25b2;</button>';
  }

  list.innerHTML = cardsHtml + expandBtn;
}

var lastStatsWidgetFp = "";
function renderStatsWidget() {
  var container = document.getElementById("stats-widget");
  if (!container) return;
  var s = (state && state.stats) || {};
  var t = s.today || { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, thinkingTokens: 0, contentTokens: 0, cacheMissTokens: 0 };
  var br = s.burnRate || { tokensPerMin: 0, recentTurns: 0 };
  var fp = (t.totalTokens || 0) + ":" + (t.inputTokens || 0) + ":" + (t.outputTokens || 0) + ":" + (t.cacheHitTokens || 0) + ":" + (t.thinkingTokens || 0) + ":" + (t.cacheMissTokens || 0) + ":" + br.tokensPerMin + ":" + br.recentTurns;
  if (fp === lastStatsWidgetFp) return;
  lastStatsWidgetFp = fp;

  var hasTokens = (t.totalTokens || 0) > 0;
  var tot = t.totalTokens || 1;
  var pCac = hasTokens ? Math.round(((t.cacheHitTokens || 0) / tot) * 100) : 0;
  var pInp = hasTokens ? Math.round(((t.cacheMissTokens || Math.max(0, (t.inputTokens || 0) - (t.cacheHitTokens || 0))) / tot) * 100) : 0;
  var pThk = hasTokens ? Math.round(((t.thinkingTokens || 0) / tot) * 100) : 0;
  var pOut = hasTokens ? Math.max(0, 100 - pCac - pInp - pThk) : 0;
  var cacHover = 'Cache Hit: ' + fmtNum(t.cacheHitTokens || 0) + ' (' + (t.cacheHitTokens || 0).toLocaleString() + ' tokens)';

  var breakdownHtml = '<div class="cb-item"><span class="cb-lbl">In</span><span class="cb-val" style="color:var(--input-col);">' + fmtNum(t.inputTokens || 0) + '</span></div>' +
    '<div class="cb-item"><span class="cb-lbl">Out</span><span class="cb-val" style="color:var(--output-col);">' + fmtNum(t.contentTokens || ((t.outputTokens || 0) - (t.thinkingTokens || 0))) + '</span></div>' +
    '<div class="cb-item" title="' + esc(cacHover) + '"><span class="cb-lbl">Cache</span><span class="cb-val" style="color:var(--cached);">' + fmtNum(t.cacheHitTokens || 0) + '</span></div>';
  if ((t.thinkingTokens || 0) > 0) {
    breakdownHtml += '<div class="cb-item"><span class="cb-lbl">Thinking</span><span class="cb-val" style="color:var(--thinking-col);">' + fmtNum(t.thinkingTokens || 0) + '</span></div>';
  }

  container.innerHTML = '<div class="card">' +
    '<div class="card-head">' +
      '<div style="display:flex;align-items:center;gap:4px;overflow:hidden;flex:1;min-width:0;">' +
        '<span class="tier-tag">STATS</span>' +
        '<span style="font-size:10.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Today: ' + fmtNum(t.totalTokens || 0) + ' <span style="font-size:9.5px;font-weight:700;color:var(--cached);" title="' + esc(cacHover) + '">(' + pCac + '%)</span></span>' +
      '</div>' +
      '<button class="btn btn-sec" data-action="nav" data-view="stats" style="font-size:9.5px;padding:2px 6px;flex-shrink:0;">Stats &rarr;</button>' +
    '</div>' +
    '<div class="segmented-bar">' +
      '<div class="seg-cac" style="width:' + pCac + '%;" title="Cache Hit: ' + fmtNum(t.cacheHitTokens || 0) + '"></div>' +
      '<div class="seg-inp" style="width:' + pInp + '%;" title="New Input: ' + fmtNum(t.cacheMissTokens || Math.max(0, (t.inputTokens || 0) - (t.cacheHitTokens || 0))) + '"></div>' +
      '<div class="seg-thk" style="width:' + pThk + '%;" title="Thinking: ' + fmtNum(t.thinkingTokens || 0) + '"></div>' +
      '<div class="seg-out" style="width:' + pOut + '%;" title="Output: ' + fmtNum(t.contentTokens || ((t.outputTokens || 0) - (t.thinkingTokens || 0))) + '"></div>' +
    '</div>' +
    '<div class="card-breakdown" style="' + ((t.thinkingTokens || 0) > 0 ? 'grid-template-columns:repeat(4,1fr);' : 'grid-template-columns:repeat(3,1fr);') + '">' +
      breakdownHtml +
    '</div>' +
    (s.burnRate && s.burnRate.tokensPerMin > 0
      ? ('<div class="card-meta" style="margin-top:3px;font-size:8.5px;color:var(--dim);border-top:1px solid var(--border);padding-top:3px;">Burn Rate: <strong style="color:var(--text);font-family:var(--mono);">~' + fmtNum(s.burnRate.tokensPerMin) + '/min</strong> (' + s.burnRate.recentTurns + ' turns in 15m)</div>')
      : '') +
  '</div>';
}


var lastStatsPageFp = "";
function renderStatsPage(force) {
  updateTabStyles();
  var s = (state && state.stats) || {};
  var t = s.today || {};
  var req0 = (s.requests && s.requests[0]) || {};
  var conv0 = (s.conversations && s.conversations[0]) || {};

  var fp = statsRange + "|" + (selectedBarIndex !== null ? selectedBarIndex : "") + "|" +
    sortConfig.requests.field + ":" + sortConfig.requests.dir + "|" +
    sortConfig.models.field + ":" + sortConfig.models.dir + "|" +
    sortConfig.conversations.field + ":" + sortConfig.conversations.dir + "|" +
    (t.totalTokens || 0) + ":" + (t.inputTokens || 0) + ":" +
    (s.requests ? s.requests.length : 0) + ":" + (req0.timestamp || 0) + ":" + (req0.totalTokens || 0) + "|" +
    (s.conversations ? s.conversations.length : 0) + ":" + (conv0.lastActive || 0);

  if (!force && fp === lastStatsPageFp) return;
  lastStatsPageFp = fp;

  var startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  var cutoffMs = startOfToday.getTime();

  var rawData = [];
  if (statsRange === "monthly") {
    rawData = Array.isArray(s.monthly) ? s.monthly : [];
    cutoffMs = Date.now() - 365 * 864e5;
  } else if (statsRange === "weekly") {
    rawData = Array.isArray(s.weekly) ? s.weekly : [];
    cutoffMs = Date.now() - 28 * 864e5;
  } else if (statsRange === "daily") {
    rawData = Array.isArray(s.daily) ? s.daily : [];
    cutoffMs = Date.now() - 7 * 864e5;
  } else {
    rawData = Array.isArray(s.hourly) ? s.hourly : [];
    cutoffMs = startOfToday.getTime();
  }

  var data = rawData.filter(Boolean);
  var chartBox = document.getElementById("chart-container");
  if (!chartBox) return;

  var maxVal = Math.max.apply(Math, data.map(function(d) { return (d && d.totalTokens) || 0; }).concat([100]));
  var barWidth = statsRange === "monthly" ? 22 : statsRange === "today" ? 22 : statsRange === "weekly" ? 36 : 26;
  var stepX = statsRange === "monthly" ? 38 : statsRange === "today" ? 36 : statsRange === "weekly" ? 64 : 44;
  var yBase = 116;
  var maxBarH = 75;

  var svgBars = data.map(function(d, i) {
    var total = (d && d.totalTokens) || 0;
    var isSelected = selectedBarIndex === i;
    var isDimmed = selectedBarIndex !== null && !isSelected;
    var h = total > 0 ? Math.min(maxBarH, Math.max(4, Math.round((total / maxVal) * maxBarH))) : 0;
    var hCac = Math.round((((d && d.cacheHitTokens) || 0) / (total || 1)) * h);
    var hInp = Math.round((((d && d.cacheMissTokens) || Math.max(0, ((d && d.inputTokens) || 0) - ((d && d.cacheHitTokens) || 0))) / (total || 1)) * h);
    var hThk = Math.round((((d && d.thinkingTokens) || 0) / (total || 1)) * h);
    var hOut = Math.max(0, h - hCac - hInp - hThk);

    var x = i * stepX + 16;
    var label = statsRange === "today"
      ? ((d && d.hourLabel) || "")
      : statsRange === "monthly"
        ? ((d && d.monthLabel) || "")
        : statsRange === "weekly"
          ? (d && d.weekLabel ? d.weekLabel.slice(0, 5) : "W" + (i + 1))
          : (d && d.date ? d.date.slice(5) : "");

    var yCac = yBase - hCac;
    var yInp = yCac - hInp;
    var yThk = yInp - hThk;
    var yOut = yThk - hOut;
    var textY = yBase - h - 5;

    var cacRect = hCac > 0 ? '<rect x="' + x + '" y="' + yCac + '" width="' + barWidth + '" height="' + hCac + '" fill="#a855f7" rx="1"><title>' + label + ' Cache Hit: ' + fmtNum(d.cacheHitTokens) + '</title></rect>' : '';
    var inpRect = hInp > 0 ? '<rect x="' + x + '" y="' + yInp + '" width="' + barWidth + '" height="' + hInp + '" fill="#3b82f6"><title>' + label + ' New Input: ' + fmtNum(d.cacheMissTokens || (((d && d.inputTokens) || 0) - ((d && d.cacheHitTokens) || 0))) + '</title></rect>' : '';
    var thkRect = hThk > 0 ? '<rect x="' + x + '" y="' + yThk + '" width="' + barWidth + '" height="' + hThk + '" fill="#f59e0b"><title>' + label + ' Thinking: ' + fmtNum(d.thinkingTokens) + '</title></rect>' : '';
    var outRect = hOut > 0 ? '<rect x="' + x + '" y="' + yOut + '" width="' + barWidth + '" height="' + hOut + '" fill="#10b981" rx="1"><title>' + label + ' Content: ' + fmtNum((d.contentTokens || d.outputTokens) - (d.thinkingTokens || 0)) + '</title></rect>' : '';
    var selBorder = isSelected ? '<rect x="' + (x - 2) + '" y="' + (yBase - h - 2) + '" width="' + (barWidth + 4) + '" height="' + (h + 4) + '" fill="none" stroke="var(--accent)" stroke-width="1.5" rx="3" />' : '';
    var topText = total > 0 ? '<text x="' + (x + barWidth / 2) + '" y="' + textY + '" text-anchor="middle" font-size="8" font-weight="' + (isSelected ? '700' : '600') + '" fill="' + (isSelected ? '#60a5fa' : '#f8fafc') + '" font-family="var(--mono)">' + fmtNum(total) + '</text>' : '';
    var dateText = '<text x="' + (x + barWidth / 2) + '" y="132" text-anchor="middle" font-size="8" fill="' + (isSelected ? '#fff' : '#94a3b8') + '" font-weight="' + (isSelected ? '700' : '400') + '" font-family="var(--mono)">' + label + '</text>';

    return '<g class="bar-group ' + (isDimmed ? 'dimmed' : '') + '" data-action="selectBar" data-index="' + i + '" data-label="' + esc(label) + '">' + selBorder + cacRect + inpRect + thkRect + outRect + topText + dateText + '</g>';
  }).join("");

  var totalSvgWidth = Math.max(280, data.length * stepX + 32);
  chartBox.innerHTML = '<svg class="chart-svg" style="width:' + totalSvgWidth + 'px;min-width:100%;" viewBox="0 0 ' + totalSvgWidth + ' 142">' + svgBars + '</svg>';
  if (shouldScrollChart && (statsRange === "today" || statsRange === "daily") && selectedBarIndex === null) {
    shouldScrollChart = false;
    requestAnimationFrame(function() {
      if (chartBox) chartBox.scrollLeft = chartBox.scrollWidth;
    });
  }

  // Selected bar slice or full active horizon
  var activeSlice = (selectedBarIndex !== null && data[selectedBarIndex]) ? data[selectedBarIndex] : null;

  var rangeTotalInp = 0;
  var rangeTotalOut = 0;
  var rangeTotalHit = 0;
  var rangeTotalThk = 0;
  var rangeTotalTokens = 0;

  if (activeSlice) {
    rangeTotalInp = activeSlice.inputTokens || 0;
    rangeTotalOut = activeSlice.outputTokens || 0;
    rangeTotalHit = activeSlice.cacheHitTokens || 0;
    rangeTotalThk = activeSlice.thinkingTokens || 0;
    rangeTotalTokens = activeSlice.totalTokens || 0;
  } else {
    for (var k = 0; k < data.length; k++) {
      var db = data[k];
      if (!db) continue;
      rangeTotalInp += (db.inputTokens || 0);
      rangeTotalOut += (db.outputTokens || 0);
      rangeTotalHit += (db.cacheHitTokens || 0);
      rangeTotalThk += (db.thinkingTokens || 0);
      rangeTotalTokens += (db.totalTokens || 0);
    }
  }

  var rangeHitRate = rangeTotalInp > 0 ? Math.round((rangeTotalHit / rangeTotalInp) * 1000) / 10 : 0;

  var cumTitleEl = document.getElementById("cumulative-title");
  if (cumTitleEl) {
    cumTitleEl.textContent = activeSlice ? ("Metrics for " + (selectedBarLabel || "Selected Slice")) : "Metrics";
  }

  var allTimeGrid = document.getElementById("alltime-grid");
  if (allTimeGrid) {
    var promptCacHover = 'Cache Hit: ' + fmtNum(rangeTotalHit) + ' (' + rangeTotalHit.toLocaleString() + ' tokens)';
    var thkMetricHtml = rangeTotalThk > 0
      ? '<div class="stat-box"><span class="stat-lbl">Thinking Depth</span><span class="stat-val" style="color:var(--thinking-col);">' + fmtNum(rangeTotalThk) + '</span></div>'
      : '<div class="stat-box"><span class="stat-lbl">Cache Hit Rate</span><span class="stat-val" style="color:var(--cached);">' + fmtNum(rangeTotalHit) + ' <span style="font-size:10px;font-weight:600;color:var(--dim);">(' + rangeHitRate + '%)</span></span></div>';

    allTimeGrid.innerHTML =
      '<div class="stat-box"><span class="stat-lbl">Processed</span><span class="stat-val">' + fmtNum(rangeTotalTokens) + '</span></div>' +
      '<div class="stat-box" title="' + esc(promptCacHover) + '"><span class="stat-lbl">Prompt Input</span><span class="stat-val" style="color:var(--input-col);">' + fmtNum(rangeTotalInp) + ' <span style="font-size:10px;font-weight:600;color:var(--cached);">(' + rangeHitRate + '%)</span></span></div>' +
      '<div class="stat-box"><span class="stat-lbl">Completion Output</span><span class="stat-val" style="color:var(--output-col);">' + fmtNum(rangeTotalOut) + '</span></div>' +
      thkMetricHtml;
  }

  // Filter Requests
  var allReqs = (s && Array.isArray(s.requests)) ? s.requests.filter(Boolean) : [];
  var reqs = [];

  if (activeSlice) {
    reqs = allReqs.filter(function(r) {
      if (!r || !r.timestamp) return false;
      if (statsRange === "today") {
        return typeof activeSlice.hour === "number" && new Date(r.timestamp).getHours() === activeSlice.hour;
      }
      if (statsRange === "daily") {
        return activeSlice.date && new Date(r.timestamp).toISOString().slice(0, 10) === activeSlice.date;
      }
      if (statsRange === "weekly") {
        var rTs = r.timestamp;
        var startTs = Date.parse(activeSlice.startDate);
        var endTs = Date.parse(activeSlice.endDate) + 864e5;
        return rTs >= startTs && rTs <= endTs;
      }
      if (statsRange === "monthly") {
        return activeSlice.startDate && new Date(r.timestamp).toISOString().slice(0, 7) === activeSlice.startDate.slice(0, 7);
      }
      return true;
    });
  } else {
    reqs = allReqs.filter(function(r) { return r && (r.timestamp || 0) >= cutoffMs; });
  }

  var rField = (sortConfig.requests && sortConfig.requests.field) || "recent";
  var rDir = (sortConfig.requests && sortConfig.requests.dir === "asc") ? 1 : -1;
  reqs.sort(function(a, b) {
    if (rField === "cachePct") {
      var rA = (a.inputTokens || 0) > 0 ? (a.cacheHitTokens || 0) / a.inputTokens : 0;
      var rB = (b.inputTokens || 0) > 0 ? (b.cacheHitTokens || 0) / b.inputTokens : 0;
      return (rA - rB) * rDir;
    }
    if (rField === "input") return ((a.inputTokens || 0) - (b.inputTokens || 0)) * rDir;
    if (rField === "output") return ((a.outputTokens || 0) - (b.outputTokens || 0)) * rDir;
    if (rField === "cache") return ((a.cacheHitTokens || 0) - (b.cacheHitTokens || 0)) * rDir;
    if (rField === "turns") return ((a.turnCount || 0) - (b.turnCount || 0)) * rDir;
    if (rField === "total") return ((a.totalTokens || 0) - (b.totalTokens || 0)) * rDir;
    return ((a.timestamp || 0) - (b.timestamp || 0)) * rDir;
  });

  var rSel = document.getElementById("sort-sel-requests");
  if (rSel) rSel.value = rField;
  var rDirBtn = document.getElementById("sort-dir-requests");
  if (rDirBtn) rDirBtn.textContent = rDir === 1 ? "▲" : "▼";

  var reqCountEl = document.getElementById("req-count");
  var reqBreakdownEl = document.getElementById("request-breakdown");
  if (reqCountEl) reqCountEl.textContent = reqs.length + " reqs";
  if (reqBreakdownEl) {
    var prevReqScroll = reqBreakdownEl.scrollLeft;
    var filterBanner = activeSlice
      ? '<div class="row" style="background:var(--card);border:1px solid var(--accent);border-radius:5px;padding:3px 7px;width:100%;margin-bottom:3px;"><span style="font-size:9px;color:var(--text);font-weight:600;">Filtered to ' + esc(selectedBarLabel || "Slice") + '</span><button class="btn btn-sec btn-icon" data-action="clearBarFilter" style="font-size:8.5px;padding:1px 4px;">Clear</button></div>'
      : '';

    reqBreakdownEl.innerHTML = reqs.length ? (filterBanner + reqs.map(function(r) {
      if (!r) return "";
      var dateStr = r.timestamp ? new Date(r.timestamp).toLocaleDateString([], { month: "numeric", day: "numeric" }) : "";
      var timeStr = r.timestamp ? new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      var tCount = r.turnCount || 1;
      var hitRate = (r.inputTokens && r.inputTokens > 0) ? Math.round(((r.cacheHitTokens || 0) / r.inputTokens) * 100) : 0;
      var modelTag = r.model || "Gemini";
      var thkVal = r.thinkingTokens || 0;
      var outVal = (r.contentTokens || r.outputTokens || 0) - thkVal;
      var cbColumns = thkVal > 0 ? 'grid-template-columns:repeat(3,1fr);' : 'grid-template-columns:repeat(2,1fr);';
      var thkItem = thkVal > 0 ? '<div class="cb-item"><span class="cb-lbl">Thk</span><span class="cb-val" style="color:var(--thinking-col);">' + fmtNum(thkVal) + '</span></div>' : '';
      var rCacHover = 'Cache Hit: ' + fmtNum(r.cacheHitTokens || 0) + ' (' + (r.cacheHitTokens || 0).toLocaleString() + ' tokens)';

      return '<div class="square-card">' +
        '<div class="card-head" style="align-items:flex-start;">' +
          '<span class="tier-tag" title="' + esc(modelTag) + '">' + esc(modelTag) + '</span>' +
        '</div>' +
        '<div class="card-title" title="' + esc(r.promptPreview || "") + '">' + esc(r.promptPreview || "User Prompt") + '</div>' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin:1px 0;">' +
          '<span style="font-size:8px;color:var(--dim);text-transform:uppercase;font-weight:600;">Tokens</span>' +
          '<span style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text);">' + fmtNum(r.totalTokens || 0) + ' <span style="font-size:10px;font-weight:700;color:var(--cached);" title="' + esc(rCacHover) + '">(' + hitRate + '%)</span></span>' +
        '</div>' +
        '<div class="card-meta">' + tCount + (tCount === 1 ? " turn" : " turns") + ' &bull; ' + dateStr + (timeStr ? ' ' + timeStr : '') + '</div>' +
        '<div class="card-breakdown" style="' + cbColumns + '">' +
          '<div class="cb-item" title="' + esc(rCacHover) + '"><span class="cb-lbl">In</span><span class="cb-val" style="color:var(--input-col);">' + fmtNum(r.inputTokens || 0) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Out</span><span class="cb-val" style="color:var(--output-col);">' + fmtNum(outVal > 0 ? outVal : r.outputTokens || 0) + '</span></div>' +
          thkItem +
        '</div>' +
      '</div>';
    }).join("")) : (filterBanner + '<div class="empty" style="width:100%;">No requests in this period.</div>');
    if (prevReqScroll > 0) reqBreakdownEl.scrollLeft = prevReqScroll;
  }

  // Render Filtered Models
  var models = {};
  var sourceData = activeSlice ? [activeSlice] : data;
  for (var i = 0; i < sourceData.length; i++) {
    var d = sourceData[i];
    if (d && d.models && typeof d.models === "object") {
      for (var m in d.models) {
        if (!m) continue;
        var mb = d.models[m];
        if (!mb) continue;
        if (!models[m]) models[m] = { total: 0, inp: 0, out: 0, hit: 0, thk: 0 };
        models[m].total += (mb.totalTokens || 0);
        models[m].inp += (mb.inputTokens || 0);
        models[m].out += (mb.outputTokens || 0);
        models[m].hit += (mb.cacheHitTokens || 0);
        models[m].thk += (mb.thinkingTokens || 0);
      }
    }
  }

  var mKeys = Object.keys(models);
  var mField = (sortConfig.models && sortConfig.models.field) || "total";
  var mDir = (sortConfig.models && sortConfig.models.dir === "asc") ? 1 : -1;
  mKeys.sort(function(a, b) {
    if (mField === "cachePct") {
      var rA = models[a].inp > 0 ? (models[a].hit || 0) / models[a].inp : 0;
      var rB = models[b].inp > 0 ? (models[b].hit || 0) / models[b].inp : 0;
      return (rA - rB) * mDir;
    }
    if (mField === "input") return (models[a].inp - models[b].inp) * mDir;
    if (mField === "output") return (models[a].out - models[b].out) * mDir;
    if (mField === "cache") return (models[a].hit - models[b].hit) * mDir;
    if (mField === "name") return a.localeCompare(b) * mDir;
    return (models[a].total - models[b].total) * mDir;
  });

  var mSel = document.getElementById("sort-sel-models");
  if (mSel) mSel.value = mField;
  var mDirBtn = document.getElementById("sort-dir-models");
  if (mDirBtn) mDirBtn.textContent = mDir === 1 ? "▲" : "▼";

  var modelCountEl = document.getElementById("model-count");
  var modelBreakdownEl = document.getElementById("model-breakdown");
  if (modelCountEl) modelCountEl.textContent = mKeys.length + " models";
  if (modelBreakdownEl) {
    var prevModelScroll = modelBreakdownEl.scrollLeft;
    modelBreakdownEl.innerHTML = mKeys.length ? mKeys.map(function(m) {
      var b = models[m];
      if (!b) return "";
      var mHitRate = b.inp > 0 ? Math.round(((b.hit || 0) / b.inp) * 100) : 0;
      var mThkVal = b.thk || 0;
      var mOutVal = b.out - mThkVal;
      var mCbCols = mThkVal > 0 ? 'grid-template-columns:repeat(3,1fr);' : 'grid-template-columns:repeat(2,1fr);';
      var mThkItem = mThkVal > 0 ? '<div class="cb-item"><span class="cb-lbl">Thk</span><span class="cb-val" style="color:var(--thinking-col);">' + fmtNum(mThkVal) + '</span></div>' : '';
      var mCacHover = 'Cache Hit: ' + fmtNum(b.hit || 0) + ' (' + (b.hit || 0).toLocaleString() + ' tokens)';

      return '<div class="square-card">' +
        '<div class="card-head" style="align-items:flex-start;">' +
          '<span class="tier-tag" title="This is showing model ID, not the model name">MODEL</span>' +
        '</div>' +
        '<div class="card-title" title="' + esc(m) + '">' + esc(m) + '</div>' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin:1px 0;">' +
          '<span style="font-size:8px;color:var(--dim);text-transform:uppercase;font-weight:600;">Volume</span>' +
          '<span style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text);">' + fmtNum(b.total) + ' <span style="font-size:10px;font-weight:700;color:var(--cached);" title="' + esc(mCacHover) + '">(' + mHitRate + '%)</span></span>' +
        '</div>' +
        '<div class="card-breakdown" style="margin-top:2px;' + mCbCols + '">' +
          '<div class="cb-item" title="' + esc(mCacHover) + '"><span class="cb-lbl">In</span><span class="cb-val" style="color:var(--input-col);">' + fmtNum(b.inp) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Out</span><span class="cb-val" style="color:var(--output-col);">' + fmtNum(mOutVal > 0 ? mOutVal : b.out) + '</span></div>' +
          mThkItem +
        '</div>' +
      '</div>';
    }).join("") : '<div class="empty" style="width:100%;">No model activity.</div>';
    if (prevModelScroll > 0) modelBreakdownEl.scrollLeft = prevModelScroll;
  }

  // Render Filtered Sessions (Conversations)
  var allConvs = (s && Array.isArray(s.conversations)) ? s.conversations.filter(Boolean) : [];
  var convs = allConvs.filter(function(c) { return c && (c.lastActive || 0) >= cutoffMs; });

  var cField = (sortConfig.conversations && sortConfig.conversations.field) || "recent";
  var cDir = (sortConfig.conversations && sortConfig.conversations.dir === "asc") ? 1 : -1;
  convs.sort(function(a, b) {
    if (cField === "cachePct") {
      var rA = (a.inputTokens || 0) > 0 ? (a.cacheHitTokens || 0) / a.inputTokens : 0;
      var rB = (b.inputTokens || 0) > 0 ? (b.cacheHitTokens || 0) / b.inputTokens : 0;
      return (rA - rB) * cDir;
    }
    if (cField === "input") return ((a.inputTokens || 0) - (b.inputTokens || 0)) * cDir;
    if (cField === "output") return ((a.outputTokens || 0) - (b.outputTokens || 0)) * cDir;
    if (cField === "cache") return ((a.cacheHitTokens || 0) - (b.cacheHitTokens || 0)) * cDir;
    if (cField === "turns") return ((a.turnCount || 0) - (b.turnCount || 0)) * cDir;
    if (cField === "total") return ((a.totalTokens || 0) - (b.totalTokens || 0)) * cDir;
    return ((a.lastActive || 0) - (b.lastActive || 0)) * cDir;
  });

  var cSel = document.getElementById("sort-sel-conversations");
  if (cSel) cSel.value = cField;
  var cDirBtn = document.getElementById("sort-dir-conversations");
  if (cDirBtn) cDirBtn.textContent = cDir === 1 ? "▲" : "▼";

  var convCountEl = document.getElementById("conv-count");
  var convBreakdownEl = document.getElementById("conv-breakdown");
  if (convCountEl) convCountEl.textContent = convs.length + " sessions";
  if (convBreakdownEl) {
    var prevConvScroll = convBreakdownEl.scrollLeft;
    convBreakdownEl.innerHTML = convs.length ? convs.map(function(c) {
      if (!c) return "";
      var cDateStr = c.lastActive ? new Date(c.lastActive).toLocaleDateString([], { month: "numeric", day: "numeric" }) : "";
      var cTimeStr = c.lastActive ? new Date(c.lastActive).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      var cTurns = c.turnCount || 1;
      var cHitRate = (c.inputTokens && c.inputTokens > 0) ? Math.round(((c.cacheHitTokens || 0) / c.inputTokens) * 100) : 0;
      var cThkVal = c.thinkingTokens || 0;
      var cOutVal = (c.contentTokens || c.outputTokens || 0) - cThkVal;
      var cCbCols = cThkVal > 0 ? 'grid-template-columns:repeat(3,1fr);' : 'grid-template-columns:repeat(2,1fr);';
      var cThkItem = cThkVal > 0 ? '<div class="cb-item"><span class="cb-lbl">Thk</span><span class="cb-val" style="color:var(--thinking-col);">' + fmtNum(cThkVal) + '</span></div>' : '';
      var cCacHover = 'Cache Hit: ' + fmtNum(c.cacheHitTokens || 0) + ' (' + (c.cacheHitTokens || 0).toLocaleString() + ' tokens)';
      var modelNames = (c.models && typeof c.models === "object") ? Object.keys(c.models).filter(Boolean) : [];
      if (!modelNames.length && c.model) modelNames = [c.model];
      if (!modelNames.length) modelNames = ["Gemini"];
      var fullModelTitle = modelNames.join(", ");
      var displayModelTag = modelNames.join(" \u2022 ");
      return '<div class="square-card">' +
        '<div class="card-head" style="align-items:flex-start;overflow:hidden;width:100%;">' +
          '<span class="tier-tag" title="' + esc(fullModelTitle) + '" style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(displayModelTag) + '</span>' +
        '</div>' +
        '<div class="card-title" title="' + esc(c.title || "") + '">' + esc(c.title || (c.id ? c.id.slice(0,8) : "Session")) + '</div>' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin:1px 0;">' +
          '<span style="font-size:8px;color:var(--dim);text-transform:uppercase;font-weight:600;">Tokens</span>' +
          '<span style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text);">' + fmtNum(c.totalTokens || 0) + ' <span style="font-size:10px;font-weight:700;color:var(--cached);" title="' + esc(cCacHover) + '">(' + cHitRate + '%)</span></span>' +
        '</div>' +
        '<div class="card-meta">' + cTurns + (cTurns === 1 ? " turn" : " turns") + ' &bull; ' + cDateStr + (cTimeStr ? ' ' + cTimeStr : '') + '</div>' +
        '<div class="card-breakdown" style="' + cCbCols + '">' +
          '<div class="cb-item" title="' + esc(cCacHover) + '"><span class="cb-lbl">In</span><span class="cb-val" style="color:var(--input-col);">' + fmtNum(c.inputTokens || 0) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Out</span><span class="cb-val" style="color:var(--output-col);">' + fmtNum(cOutVal > 0 ? cOutVal : c.outputTokens || 0) + '</span></div>' +
          cThkItem +
        '</div>' +
      '</div>';
    }).join("") : '<div class="empty" style="width:100%;">No sessions in this period.</div>';
    if (prevConvScroll > 0) convBreakdownEl.scrollLeft = prevConvScroll;
  }
}

setInterval(function() {
  var tags = document.querySelectorAll(".reset-tag[data-reset]");
  for (var i = 0; i < tags.length; i++) {
    var el = tags[i];
    var iso = el.getAttribute("data-reset");
    if (iso) {
      var t = fmtTime(iso);
      if (el.textContent !== t) {
        el.textContent = t;
        if (t === "ready") el.classList.remove("active");
        else el.classList.add("active");
      }
    }
  }
}, 1000);

var lastLogCount = 0;
var lastLogFirstTs = 0;
var lastLogHideEmail = null;

function formatLogCardHtml(l) {
  if (!l) return "";
  var lvl = (l.level || "info").toLowerCase();
  var colCls = lvl === "error" ? "error" : lvl === "warn" ? "warn" : lvl === "rotate" ? "rotate" : "";
  var cat = esc(l.category || "LOG");
  var badgeColor = lvl === "error" ? "color:#f87171" : lvl === "warn" ? "color:#fbbf24" : "color:#6ee7b7";
  var disTag = lvl !== "info" ? '<span class="dis-tag" style="' + badgeColor + '">' + lvl.toUpperCase() + '</span>' : '';
  var cleanMsg = sanitizeTextForDisplay(l.message || "");
  return '<div class="log-card">' +
    '<div class="log-meta">' +
      '<div style="display:flex;align-items:center;gap:4px;">' +
        '<span class="tier-tag">' + cat + '</span>' +
        '<span style="font-family:var(--mono);">' + (l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : "") + '</span>' +
      '</div>' +
      disTag +
    '</div>' +
    '<div class="log-msg ' + colCls + '">' + esc(cleanMsg) + '</div>' +
  '</div>';
}

function renderLogs() {
  var el = document.getElementById("log-scroll");
  if (!el) return;
  var rawLogs = (state && Array.isArray(state.logs)) ? state.logs.filter(Boolean) : [];
  var logs = rawLogs.length > 200 ? rawLogs.slice(rawLogs.length - 200) : rawLogs;
  var logCountEl = document.getElementById("log-count");
  if (logCountEl) logCountEl.textContent = logs.length + " logs";

  if (!logs.length) {
    lastLogCount = 0;
    lastLogFirstTs = 0;
    lastLogHideEmail = hideEmail;
    el.innerHTML = '<div class="empty">No events logged yet.</div>';
    return;
  }

  var firstTs = logs[0] ? (logs[0].timestamp || 0) : 0;
  if (logs.length === lastLogCount && firstTs === lastLogFirstTs && hideEmail === lastLogHideEmail) {
    return;
  }

  var isAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 40;

  if (logs.length > lastLogCount && firstTs === lastLogFirstTs && hideEmail === lastLogHideEmail && lastLogCount > 0) {
    var newLogs = logs.slice(lastLogCount);
    var frag = document.createDocumentFragment();
    for (var ni = 0; ni < newLogs.length; ni++) {
      var itemHtml = formatLogCardHtml(newLogs[ni]);
      if (itemHtml) {
        var temp = document.createElement("div");
        temp.innerHTML = itemHtml;
        var node = temp.firstElementChild;
        if (node) frag.appendChild(node);
      }
    }
    var emptyEl = el.querySelector(".empty");
    if (emptyEl) emptyEl.remove();
    el.appendChild(frag);
    lastLogCount = logs.length;
    if (isAtBottom) el.scrollTop = el.scrollHeight;
    return;
  }

  lastLogCount = logs.length;
  lastLogFirstTs = firstTs;
  lastLogHideEmail = hideEmail;
  el.innerHTML = logs.map(formatLogCardHtml).join("");
  if (isAtBottom || el.scrollTop === 0) {
    el.scrollTop = el.scrollHeight;
  }
}

send("ready");
render();
</script></body></html>`;
  }
}
