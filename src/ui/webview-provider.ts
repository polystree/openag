import * as vscode from "vscode";
import type { LogManager } from "../core/log-manager.js";
import { AutoRunPatcher } from "../core/patcher.js";
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
  | { action: "refreshAccount"; payload: string }
  | { action: "removeAccount"; payload: string }
  | { action: "clearLogs"; payload?: undefined }
  | { action: "togglePatch"; payload: { id: string; enabled: boolean } }
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

  private postState(): void {
    if (!this.view) return;
    if (!this.view.visible) {
      this.isDirty = true;
      return;
    }
    this.isDirty = false;
    try {
      const accounts = this.tokenManager.getAccounts();
      const activeEmail = this.tokenManager.getActiveEmail();
      const quotas = this.quotaMonitor.getAllQuotas();
      const config = this.tokenManager.getConfig();
      const logs = this.logManager.getLogs();
      const patcher = AutoRunPatcher.getStatus();
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
      const conversationsList = this.statsManager?.getConversationsList(100) || [];
      const requestsList = this.statsManager?.getRequestsList(100) || [];
      const allTimeSummary = this.statsManager?.getAllTimeSummary() || {
        inputTokens: 0,
        outputTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalTokens: 0,
        totalTurns: 0,
        cacheHitRate: 0,
      };

      void this.view.webview.postMessage({
        type: "state",
        data: {
          accounts,
          activeEmail,
          quotas,
          config,
          logs,
          patcher,
          stats: {
            today: todayStats,
            hourly: hourlyStats,
            daily: dailyStats,
            weekly: weeklyStats,
            monthly: monthlyStats,
            conversations: conversationsList,
            requests: requestsList,
            allTime: allTimeSummary,
          },
        },
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
          case "togglePatch":
            if (message.payload) {
              const res = AutoRunPatcher.togglePatch(message.payload.id, message.payload.enabled);
              this.log(`[Patch ${message.payload.id}] ${res.message}`);
              if (res.success) {
                const reload = await vscode.window.showInformationMessage(`OpenAG: ${res.message}`, "Reload Window");
                if (reload === "Reload Window") void vscode.commands.executeCommand("workbench.action.reloadWindow");
              } else {
                void vscode.window.showErrorMessage(`OpenAG: ${res.message}`);
              }
              this.refresh();
            }
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

.card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.card.disabled { opacity: .55; }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; }
.card-title { font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; user-select: text; }
.card-desc { font-size: 9.5px; color: var(--dim); line-height: 1.35; }
.card-warn { font-size: 9px; color: var(--warn); line-height: 1.25; margin-top: 2px; }

.card-meta { font-size: 9px; font-family: var(--mono); color: var(--dim); display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: -1px; }
.card-breakdown { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; background: transparent; border: none; padding: 0; margin-top: 1px; }
.cb-item { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cb-lbl { font-size: 8px; color: var(--dim); text-transform: uppercase; font-weight: 600; letter-spacing: 0.3px; }
.cb-val { font-size: 10.5px; font-weight: 700; font-family: var(--mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.tier-tag { font-size: 8.5px; font-weight: 700; padding: 1px 4px; border-radius: 3px; text-transform: uppercase; background: var(--badge-bg); color: var(--badge-fg); flex-shrink: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
.active-tag { font-size: 8.5px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: rgba(16,185,129,.15); color: var(--success); border: 1px solid rgba(16,185,129,.4); flex-shrink: 0; }
.dis-tag { font-size: 8.5px; font-weight: 700; padding: 1px 4px; border-radius: 3px; background: rgba(255,255,255,.08); color: var(--dim); flex-shrink: 0; }

.quota-row { display: flex; align-items: center; justify-content: space-between; font-size: 10px; gap: 4px; min-width: 0; }
.progress-bg { flex: 1; height: 5px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; min-width: 20px; }
.progress-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width .3s; }
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

.stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.stat-box { background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.stat-val { font-size: 13px; font-weight: 700; font-family: var(--mono); color: var(--text); }
.stat-lbl { font-size: 9px; color: var(--dim); }

.scroll-box { display: flex; flex-direction: column; gap: 5px; max-height: 220px; overflow-y: auto; overflow-x: hidden; padding-right: 1px; contain: content; will-change: scroll-position; }
.log-scroll { display: flex; flex-direction: column; gap: 5px; max-height: 24vh; overflow-y: auto; overflow-x: hidden; padding-right: 1px; }
.log-card { background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 5px 7px; display: flex; flex-direction: column; gap: 3px; min-width: 0; user-select: text; }
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
.h-scroll-box { display: flex; flex-direction: row; gap: 6px; overflow-x: auto; overflow-y: hidden; padding: 2px 1px 6px 1px; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
.square-card { flex: 0 0 172px; width: 172px; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 7px 8px; display: flex; flex-direction: column; gap: 4px; user-select: text; contain: content; }
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
    <div style="display:flex;flex-direction:column;gap:1px;flex:1;min-width:0;">
      <span style="font-size:10px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="Auto-routes to highest quota account">Auto-routes to highest quota</span>
      <span id="quota-last-refreshed" style="font-size:8.5px;font-family:var(--mono);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
    </div>
    <div class="btn-row">
      <button class="btn btn-sec" data-action="refreshQuotas" title="Refresh quotas">Refresh</button>
      <button class="btn" data-action="addAccount" title="Add Google Account">+ Add</button>
    </div>
  </div>

  <div class="sec-head">
    <span>Accounts Pool</span>
    <div style="display:flex;align-items:center;gap:4px;">
      <span id="acc-count" style="font-size:9px;font-family:var(--mono);color:var(--dim);">0 accounts</span>
      <button class="btn btn-sec btn-icon" data-action="toggleHideEmail" id="btn-hide-email" title="Toggle Hide Email" style="font-size:9px;padding:1px 5px;">Hide Email</button>
    </div>
  </div>
  <div id="acc-list" style="display:flex;flex-direction:column;gap:5px;"></div>

  <div class="sec-head">Token Usage Statistics</div>
  <div id="stats-widget"></div>

  <div class="sec-head">IDE Enhancements & Patches</div>
  <div id="patch-list" style="display:flex;flex-direction:column;gap:5px;"></div>

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
    <span>Usage by Model</span>
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
var state = {
  accounts: [],
  activeEmail: "",
  quotas: {},
  config: {},
  logs: [],
  patcher: { patches: [] },
  stats: { today: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, models: {}, conversations: {} }, hourly: [], daily: [], weekly: [], monthly: [], conversations: [], requests: [], allTime: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, totalTurns: 0, cacheHitRate: 0 } }
};
var currentView = "home";
var statsRange = "today";
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
  } else if (action === "toggleHideEmail") {
    hideEmail = !hideEmail;
    var btn = document.getElementById("btn-hide-email");
    if (btn) btn.textContent = hideEmail ? "Show Email" : "Hide Email";
    send("updateConfig", { hideEmail: hideEmail });
    renderAccounts();
    renderLogs();
  } else if (action === "toggleExpandAccounts") {
    accountsExpanded = !accountsExpanded;
    renderAccounts();
  } else if (action === "toggleSortDir") {
    var sec = target.getAttribute("data-section");
    if (sec && sortConfig[sec]) {
      sortConfig[sec].dir = sortConfig[sec].dir === "desc" ? "asc" : "desc";
      renderStatsPage();
    }
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
      renderStatsPage();
    }
  } else if (action === "toggleAccount") {
    send("toggleAccount", { email: target.getAttribute("data-email"), enabled: target.checked });
  } else if (action === "togglePatch") {
    send("togglePatch", { id: target.getAttribute("data-patch-id"), enabled: target.checked });
  } else if (action === "toggleEnabled") {
    send("updateConfig", { enabled: target.checked });
  }
});

document.addEventListener("wheel", function(e) {
  var hScroll = e.target && e.target.closest ? e.target.closest(".h-scroll-box, .chart-scroll-box") : null;
  if (hScroll) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && e.deltaY !== 0) {
      hScroll.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }
}, { passive: false });

window.addEventListener("message", function(e) {
  if (e.data && e.data.type === "state" && e.data.data) {
    state = e.data.data;
    render();
  }
});

function navTo(view) {
  currentView = view;
  var homeEl = document.getElementById("view-home");
  var statsEl = document.getElementById("view-stats");
  if (homeEl) homeEl.style.display = view === "home" ? "flex" : "none";
  if (statsEl) statsEl.style.display = view === "stats" ? "flex" : "none";
  if (view === "stats") renderStatsPage();
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
  updateTabStyles();
  renderStatsPage();
}

function fmtTime(s) {
  if (!s) return "";
  var d = Date.parse(s) - Date.now();
  if (d <= 0 || isNaN(d)) return "ready";
  var days = Math.floor(d / 864e5), hrs = Math.floor((d % 864e5) / 36e5), mins = Math.floor((d % 36e5) / 6e4), secs = Math.floor((d % 6e4) / 1e3);
  return days > 0 ? days + "d " + hrs + "h" : hrs > 0 ? hrs + "h " + mins + "m " + secs + "s" : mins + "m " + secs + "s";
}

function render() {
  try {
    if (state && state.config) {
      if (document.getElementById("cfg-enabled")) {
        document.getElementById("cfg-enabled").checked = state.config.enabled !== false;
      }
      if (typeof state.config.hideEmail === "boolean") {
        hideEmail = state.config.hideEmail;
      }
    }
    var btn = document.getElementById("btn-hide-email");
    if (btn) btn.textContent = hideEmail ? "Show Email" : "Hide Email";
    renderAccounts();
    renderStatsWidget();
    renderPatches();
    renderLogs();
    if (currentView === "stats") renderStatsPage();
  } catch (err) {
    console.error("render error:", err);
  }
}

function makeBarHtml(label, pct, resetIso) {
  var p = typeof pct === "number" ? Math.min(100, Math.max(0, pct)) : 100;
  var cls = p < 20 ? "err" : p < 40 ? "warn" : "";
  var resetText = fmtTime(resetIso);
  var rTag = resetIso ? '<span class="reset-tag ' + (resetText !== "ready" ? "active" : "") + '" data-reset="' + resetIso + '">' + resetText + '</span>' : '';
  return '<div class="quota-row">' +
    '<div style="display:flex;align-items:center;gap:3px;flex:1;min-width:0;overflow:hidden;">' +
      '<span style="color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(label) + '</span>' +
      rTag +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:4px;width:48%;min-width:55px;max-width:110px;flex-shrink:0;">' +
      '<div class="progress-bg"><div class="progress-fill ' + cls + '" style="width:' + p + '%"></div></div>' +
      '<span style="font-family:var(--mono);font-size:9.5px;width:26px;text-align:right;flex-shrink:0;">' + p + '%</span>' +
    '</div>' +
  '</div>';
}

function renderAccounts() {
  var list = document.getElementById("acc-list");
  if (!list) return;
  var accs = (state && Array.isArray(state.accounts)) ? state.accounts.filter(Boolean) : [];
  var accCountEl = document.getElementById("acc-count");
  if (accCountEl) accCountEl.textContent = accs.length + (accs.length === 1 ? " acc" : " accs");
  if (!accs.length) {
    list.innerHTML = '<div class="empty">No accounts in pool.<br>Click <strong>+ Add</strong> or sign in via Antigravity.</div>';
    var emptyRefEl = document.getElementById("quota-last-refreshed");
    if (emptyRefEl) emptyRefEl.textContent = "";
    return;
  }
  var quotas = (state && state.quotas && typeof state.quotas === "object") ? state.quotas : {};
  var visibleAccs = (!accountsExpanded && accs.length > 3) ? accs.slice(0, 3) : accs;

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
    var displayEmail = hideEmail ? ("Account " + (idx + 1)) : email;
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
    var updatedStr = q.lastUpdated ? fmtDateTime(q.lastUpdated) : "";
    var metaHtml = updatedStr ? ('<div class="card-meta" style="margin-top:2px;font-size:8.5px;">Refreshed: ' + esc(updatedStr) + '</div>') : '';
    return '<div class="card ' + (isAct ? "active" : "") + ' ' + (isDis ? "disabled" : "") + '">' +
      '<div class="card-head">' +
        '<div style="display:flex;align-items:center;gap:3px;overflow:hidden;flex:1;min-width:0;">' +
          '<span class="tier-tag">' + esc(acc.tier || "pro") + '</span>' +
          '<span class="card-title" title="' + esc(titleAttr) + '">' + esc(displayEmail) + '</span>' +
          tag +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">' +
          '<label class="switch" title="' + (isDis ? "Enable in pool" : "Disable in pool") + '">' +
            '<input type="checkbox" ' + (isDis ? "" : "checked") + ' data-action="toggleAccount" data-email="' + esc(email) + '" />' +
            '<span class="slider"></span>' +
          '</label>' +
          '<button class="btn btn-sec btn-icon" data-action="refreshAccount" data-email="' + esc(email) + '" title="Refresh">&#x21bb;</button>' +
          '<button class="btn btn-sec btn-icon" data-action="removeAccount" data-email="' + esc(email) + '" title="Remove">&times;</button>' +
        '</div>' +
      '</div>' +
      qHtml +
      metaHtml +
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

function renderStatsWidget() {
  var container = document.getElementById("stats-widget");
  if (!container) return;
  var s = (state && state.stats) || {};
  var t = s.today || { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };
  var tot = t.totalTokens || 1;
  var pCac = Math.round(((t.cacheHitTokens || 0) / tot) * 100);
  var pInp = Math.round(((t.cacheMissTokens || Math.max(0, (t.inputTokens || 0) - (t.cacheHitTokens || 0))) / tot) * 100);
  var pOut = Math.max(0, 100 - pCac - pInp);

  container.innerHTML = '<div class="card">' +
    '<div class="card-head">' +
      '<div style="display:flex;align-items:center;gap:4px;overflow:hidden;flex:1;min-width:0;">' +
        '<span class="tier-tag">STATS</span>' +
        '<span style="font-size:10.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Today: ' + fmtNum(t.totalTokens || 0) + '</span>' +
      '</div>' +
      '<button class="btn btn-sec" data-action="nav" data-view="stats" style="font-size:9.5px;padding:2px 6px;flex-shrink:0;">Stats &rarr;</button>' +
    '</div>' +
    '<div class="segmented-bar">' +
      '<div class="seg-cac" style="width:' + pCac + '%;" title="Cache Hit: ' + fmtNum(t.cacheHitTokens || 0) + '"></div>' +
      '<div class="seg-inp" style="width:' + pInp + '%;" title="New Input: ' + fmtNum(t.cacheMissTokens || Math.max(0, (t.inputTokens || 0) - (t.cacheHitTokens || 0))) + '"></div>' +
      '<div class="seg-out" style="width:' + pOut + '%;" title="Output: ' + fmtNum(t.outputTokens || 0) + '"></div>' +
    '</div>' +
    '<div class="card-breakdown">' +
      '<div class="cb-item"><span class="cb-lbl">In</span><span class="cb-val" style="color:var(--input-col);">' + fmtNum(t.inputTokens || 0) + '</span></div>' +
      '<div class="cb-item"><span class="cb-lbl">Out</span><span class="cb-val" style="color:var(--output-col);">' + fmtNum(t.outputTokens || 0) + '</span></div>' +
      '<div class="cb-item"><span class="cb-lbl">Cache <b style="opacity:0.8;font-weight:600;">(' + pCac + '%)</b></span><span class="cb-val" style="color:var(--cached);">' + fmtNum(t.cacheHitTokens || 0) + '</span></div>' +
    '</div>' +
  '</div>';
}

function renderPatches() {
  var container = document.getElementById("patch-list");
  if (!container) return;
  var patches = (state && state.patcher && Array.isArray(state.patcher.patches)) ? state.patcher.patches.filter(Boolean) : [];
  if (!patches.length) {
    container.innerHTML = '<div class="empty">No patches available.</div>';
    return;
  }
  container.innerHTML = patches.map(function(p) {
    var disabledClass = (!p.canApply && !p.isPatched) ? "disabled" : "";
    var badgeHtml = p.isPatched ? '<span class="active-tag">ACTIVE</span>' : '<span class="dis-tag">OFF</span>';
    var warningHtml = p.warning ? '<div class="card-warn">' + esc(p.warning) + '</div>' : "";

    return '<div class="card ' + (p.isPatched ? "active" : "") + ' ' + disabledClass + '">' +
      '<div class="card-head">' +
        '<div style="display:flex;align-items:center;gap:4px;overflow:hidden;flex:1;min-width:0;">' +
          '<span class="tier-tag">PATCH</span>' +
          '<span class="card-title">' + esc(p.name || p.id) + '</span>' +
          badgeHtml +
        '</div>' +
        '<label class="switch ' + disabledClass + '" title="' + (p.isPatched ? "Revert patch" : p.canApply ? "Apply patch" : "Unavailable") + '">' +
          '<input type="checkbox" ' + (p.isPatched ? "checked" : "") + ' ' + ((!p.canApply && !p.isPatched) ? "disabled" : "") + ' data-action="togglePatch" data-patch-id="' + esc(p.id) + '" />' +
          '<span class="slider"></span>' +
        '</label>' +
      '</div>' +
      '<div class="card-desc">' + esc(p.description || "") + '</div>' +
      warningHtml +
    '</div>';
  }).join("");
}

function renderStatsPage() {
  updateTabStyles();
  var s = (state && state.stats) || {};
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
    var h = total > 0 ? Math.min(maxBarH, Math.max(4, Math.round((total / maxVal) * maxBarH))) : 0;
    var hCac = Math.round((((d && d.cacheHitTokens) || 0) / (total || 1)) * h);
    var hInp = Math.round((((d && d.cacheMissTokens) || Math.max(0, ((d && d.inputTokens) || 0) - ((d && d.cacheHitTokens) || 0))) / (total || 1)) * h);
    var hOut = Math.max(0, h - hCac - hInp);

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
    var yOut = yInp - hOut;
    var textY = yBase - h - 5;

    var cacRect = hCac > 0 ? '<rect x="' + x + '" y="' + yCac + '" width="' + barWidth + '" height="' + hCac + '" fill="#8b5cf6" rx="1"><title>' + label + ' Cache Hit: ' + fmtNum(d.cacheHitTokens) + '</title></rect>' : '';
    var inpRect = hInp > 0 ? '<rect x="' + x + '" y="' + yInp + '" width="' + barWidth + '" height="' + hInp + '" fill="#3b82f6"><title>' + label + ' New Input: ' + fmtNum(d.cacheMissTokens || (((d && d.inputTokens) || 0) - ((d && d.cacheHitTokens) || 0))) + '</title></rect>' : '';
    var outRect = hOut > 0 ? '<rect x="' + x + '" y="' + yOut + '" width="' + barWidth + '" height="' + hOut + '" fill="#10b981" rx="1"><title>' + label + ' Output: ' + fmtNum(d.outputTokens) + '</title></rect>' : '';
    var topText = total > 0 ? '<text x="' + (x + barWidth / 2) + '" y="' + textY + '" text-anchor="middle" font-size="8" font-weight="600" fill="#f8fafc" font-family="var(--mono)">' + fmtNum(total) + '</text>' : '';
    var dateText = '<text x="' + (x + barWidth / 2) + '" y="132" text-anchor="middle" font-size="8" fill="#94a3b8" font-family="var(--mono)">' + label + '</text>';

    return '<g>' + cacRect + inpRect + outRect + topText + dateText + '</g>';
  }).join("");

  var totalSvgWidth = Math.max(280, data.length * stepX + 32);
  chartBox.innerHTML = '<svg class="chart-svg" style="width:' + totalSvgWidth + 'px;min-width:100%;" viewBox="0 0 ' + totalSvgWidth + ' 142">' + svgBars + '</svg>';
  if (statsRange === "today" || statsRange === "daily") {
    setTimeout(function() {
      if (chartBox) chartBox.scrollLeft = chartBox.scrollWidth;
    }, 20);
  }

  // Compute filtered cumulative metrics
  var rangeTotalInp = 0;
  var rangeTotalOut = 0;
  var rangeTotalHit = 0;
  var rangeTotalTokens = 0;

  for (var k = 0; k < data.length; k++) {
    var db = data[k];
    if (!db) continue;
    rangeTotalInp += (db.inputTokens || 0);
    rangeTotalOut += (db.outputTokens || 0);
    rangeTotalHit += (db.cacheHitTokens || 0);
    rangeTotalTokens += (db.totalTokens || 0);
  }

  var rangeHitRate = rangeTotalInp > 0 ? Math.round((rangeTotalHit / rangeTotalInp) * 1000) / 10 : 0;

  var cumTitleEl = document.getElementById("cumulative-title");
  if (cumTitleEl) cumTitleEl.textContent = "Metrics";

  var allTimeGrid = document.getElementById("alltime-grid");
  if (allTimeGrid) {
    allTimeGrid.innerHTML =
      '<div class="stat-box"><span class="stat-lbl">Processed</span><span class="stat-val">' + fmtNum(rangeTotalTokens) + '</span></div>' +
      '<div class="stat-box"><span class="stat-lbl">Prompt Input</span><span class="stat-val" style="color:var(--input-col);">' + fmtNum(rangeTotalInp) + '</span></div>' +
      '<div class="stat-box"><span class="stat-lbl">Completion Output</span><span class="stat-val" style="color:var(--output-col);">' + fmtNum(rangeTotalOut) + '</span></div>' +
      '<div class="stat-box"><span class="stat-lbl">Cache Hit Rate</span><span class="stat-val" style="color:var(--cached);">' + fmtNum(rangeTotalHit) + ' <span style="font-size:10px;font-weight:600;color:var(--dim);">(' + rangeHitRate + '%)</span></span></div>';
  }

  // Render Filtered Requests
  var allReqs = (s && Array.isArray(s.requests)) ? s.requests.filter(Boolean) : [];
  var reqs = allReqs.filter(function(r) { return r && (r.timestamp || 0) >= cutoffMs; });

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
    reqBreakdownEl.innerHTML = reqs.length ? reqs.map(function(r) {
      if (!r) return "";
      var dateStr = r.timestamp ? new Date(r.timestamp).toLocaleDateString([], { month: "numeric", day: "numeric" }) : "";
      var timeStr = r.timestamp ? new Date(r.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      var tCount = r.turnCount || 1;
      var hitRate = (r.inputTokens && r.inputTokens > 0) ? Math.round(((r.cacheHitTokens || 0) / r.inputTokens) * 100) : 0;
      var modelTag = r.model || "Gemini";
      return '<div class="square-card">' +
        '<div class="card-head" style="align-items:flex-start;">' +
          '<span class="tier-tag" title="' + esc(modelTag) + '">' + esc(modelTag) + '</span>' +
        '</div>' +
        '<div class="card-title" title="' + esc(r.promptPreview || "") + '" style="font-size:9.5px;font-weight:500;color:var(--text);">' + esc(r.promptPreview || "User Prompt") + '</div>' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin:1px 0;">' +
          '<span style="font-size:8px;color:var(--dim);text-transform:uppercase;font-weight:600;">Tokens</span>' +
          '<span style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text);">' + fmtNum(r.totalTokens || 0) + ' <span style="font-size:10px;font-weight:700;color:var(--cached);">(' + hitRate + '%)</span></span>' +
        '</div>' +
        '<div class="card-meta">' + tCount + (tCount === 1 ? " turn" : " turns") + ' &bull; ' + dateStr + (timeStr ? ' ' + timeStr : '') + '</div>' +
        '<div class="card-breakdown">' +
          '<div class="cb-item"><span class="cb-lbl">In</span><span class="cb-val" style="color:var(--input-col);">' + fmtNum(r.inputTokens || 0) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Out</span><span class="cb-val" style="color:var(--output-col);">' + fmtNum(r.outputTokens || 0) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Cache</span><span class="cb-val" style="color:var(--cached);">' + fmtNum(r.cacheHitTokens || 0) + '</span></div>' +
        '</div>' +
      '</div>';
    }).join("") : '<div class="empty" style="width:100%;">No requests in this period.</div>';
  }

  // Render Filtered Models strictly from active time horizon buckets
  var models = {};
  for (var i = 0; i < data.length; i++) {
    var d = data[i];
    if (d && d.models && typeof d.models === "object") {
      for (var m in d.models) {
        if (!m) continue;
        var mb = d.models[m];
        if (!mb) continue;
        if (!models[m]) models[m] = { total: 0, inp: 0, out: 0, hit: 0 };
        models[m].total += (mb.totalTokens || 0);
        models[m].inp += (mb.inputTokens || 0);
        models[m].out += (mb.outputTokens || 0);
        models[m].hit += (mb.cacheHitTokens || 0);
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
    modelBreakdownEl.innerHTML = mKeys.length ? mKeys.map(function(m) {
      var b = models[m];
      if (!b) return "";
      var mHitRate = b.inp > 0 ? Math.round(((b.hit || 0) / b.inp) * 100) : 0;
      return '<div class="square-card">' +
        '<div class="card-head" style="align-items:flex-start;">' +
          '<span class="tier-tag">MODEL</span>' +
        '</div>' +
        '<div class="card-title" title="' + esc(m) + '" style="font-size:10px;font-weight:600;color:var(--text);">' + esc(m) + '</div>' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin:1px 0;">' +
          '<span style="font-size:8px;color:var(--dim);text-transform:uppercase;font-weight:600;">Volume</span>' +
          '<span style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text);">' + fmtNum(b.total) + ' <span style="font-size:10px;font-weight:700;color:var(--cached);">(' + mHitRate + '%)</span></span>' +
        '</div>' +
        '<div class="card-breakdown" style="margin-top:2px;">' +
          '<div class="cb-item"><span class="cb-lbl">In</span><span class="cb-val" style="color:var(--input-col);">' + fmtNum(b.inp) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Out</span><span class="cb-val" style="color:var(--output-col);">' + fmtNum(b.out) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Cache</span><span class="cb-val" style="color:var(--cached);">' + fmtNum(b.hit || 0) + '</span></div>' +
        '</div>' +
      '</div>';
    }).join("") : '<div class="empty" style="width:100%;">No model activity.</div>';
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
    convBreakdownEl.innerHTML = convs.length ? convs.map(function(c) {
      if (!c) return "";
      var cDateStr = c.lastActive ? new Date(c.lastActive).toLocaleDateString([], { month: "numeric", day: "numeric" }) : "";
      var cTimeStr = c.lastActive ? new Date(c.lastActive).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      var cTurns = c.turnCount || 1;
      var cHitRate = (c.inputTokens && c.inputTokens > 0) ? Math.round(((c.cacheHitTokens || 0) / c.inputTokens) * 100) : 0;
      var modelNames = (c.models && typeof c.models === "object") ? Object.keys(c.models).filter(Boolean) : [];
      if (!modelNames.length && c.model) modelNames = [c.model];
      if (!modelNames.length) modelNames = ["Gemini"];
      var fullModelTitle = modelNames.join(", ");
      var displayModelTag = modelNames.join(" \u2022 ");
      return '<div class="square-card">' +
        '<div class="card-head" style="align-items:flex-start;overflow:hidden;width:100%;">' +
          '<span class="tier-tag" title="' + esc(fullModelTitle) + '" style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(displayModelTag) + '</span>' +
        '</div>' +
        '<div class="card-title" title="' + esc(c.title || "") + '" style="font-size:9.5px;font-weight:500;color:var(--text);">' + esc(c.title || (c.id ? c.id.slice(0,8) : "Session")) + '</div>' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;margin:1px 0;">' +
          '<span style="font-size:8px;color:var(--dim);text-transform:uppercase;font-weight:600;">Tokens</span>' +
          '<span style="font-size:14px;font-weight:700;font-family:var(--mono);color:var(--text);">' + fmtNum(c.totalTokens || 0) + ' <span style="font-size:10px;font-weight:700;color:var(--cached);">(' + cHitRate + '%)</span></span>' +
        '</div>' +
        '<div class="card-meta">' + cTurns + (cTurns === 1 ? " turn" : " turns") + ' &bull; ' + cDateStr + (cTimeStr ? ' ' + cTimeStr : '') + '</div>' +
        '<div class="card-breakdown">' +
          '<div class="cb-item"><span class="cb-lbl">In</span><span class="cb-val" style="color:var(--input-col);">' + fmtNum(c.inputTokens || 0) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Out</span><span class="cb-val" style="color:var(--output-col);">' + fmtNum(c.outputTokens || 0) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Cache</span><span class="cb-val" style="color:var(--cached);">' + fmtNum(c.cacheHitTokens || 0) + '</span></div>' +
        '</div>' +
      '</div>';
    }).join("") : '<div class="empty" style="width:100%;">No sessions in this period.</div>';
  }
}

setInterval(function() {
  document.querySelectorAll(".reset-tag[data-reset]").forEach(function(el) {
    var iso = el.getAttribute("data-reset");
    if (iso) {
      var t = fmtTime(iso);
      el.textContent = t;
      if (t === "ready") el.classList.remove("active");
      else el.classList.add("active");
    }
  });
}, 1000);

function renderLogs() {
  var el = document.getElementById("log-scroll");
  if (!el) return;
  var logs = (state && Array.isArray(state.logs)) ? state.logs.filter(Boolean) : [];
  var logCountEl = document.getElementById("log-count");
  if (logCountEl) logCountEl.textContent = logs.length + " logs";
  if (!logs.length) {
    el.innerHTML = '<div class="empty">No events logged yet.</div>';
    return;
  }
  el.innerHTML = logs.map(function(l) {
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
  }).join("");
  el.scrollTop = el.scrollHeight;
}

send("ready");
render();
</script></body></html>`;
  }
}
