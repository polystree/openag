import * as vscode from "vscode";
import type { LogManager } from "../core/log-manager.js";
import type { QuotaMonitor } from "../core/quota-monitor.js";
import type { StatsManager } from "../core/stats-manager.js";
import type { TokenManager } from "../core/token-manager.js";
import type { UsageTracker } from "../core/usage-tracker.js";
import type { OpenAGConfig } from "../types.js";

type WebviewMessage =
	| { action: "ready"; payload?: undefined }
	| { action: "addAccount"; payload?: undefined }
	| { action: "refreshQuotas"; payload?: undefined }
	| { action: "toggleAccount"; payload: { email: string; enabled: boolean } }
	| {
			action: "updateAccountMeta";
			payload: {
				email: string;
				alias?: string;
				affinity?: import("../types.js").ModelAffinity;
				role?: import("../types.js").PoolRole;
			};
	  }
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
			if (webviewView.visible && this.isDirty) {
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
				burnRate: this.statsManager?.getBurnRate(15) || {
					tokensPerMin: 0,
					recentTurns: 0,
				},
			},
		};
	}

	private postState(forceRender = false): void {
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
				forceRender,
			});
		} catch (e: unknown) {
			this.log(
				`postState error: ${e instanceof Error ? e.message : String(e)}`,
			);
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
						try {
							this.logManager.addLog(
								"info",
								"QUOTA",
								"Refreshing account pool quotas...",
							);
							await this.quotaMonitor.pollAllAccounts(true);
							const poolCount = this.tokenManager
								.getAccounts()
								.filter((a) => a.status !== "disabled").length;
							this.logManager.addLog(
								"info",
								"QUOTA",
								`Quota refresh complete (${poolCount} active accounts updated).`,
							);
						} catch (e: unknown) {
							this.logManager.addLog(
								"error",
								"QUOTA",
								`Quota refresh failed: ${e instanceof Error ? e.message : String(e)}`,
							);
						} finally {
							this.postState(true);
						}
						break;
					case "toggleAccount":
						if (message.payload) {
							await this.tokenManager.toggleAccountEnabled(
								message.payload.email,
								message.payload.enabled,
							);
							void this.quotaMonitor.pollAllAccounts();
							this.refresh();
						}
						break;
					case "updateAccountMeta":
						if (message.payload) {
							await this.tokenManager.updateAccountMeta(
								message.payload.email,
								message.payload,
							);
							this.refresh();
						}
						break;
					case "reauthAccount":
						if (message.payload) {
							try {
								const acc = await this.tokenManager.reauthAccount(
									message.payload,
								);
								void this.quotaMonitor.refreshAccountQuota(acc.email);
								void vscode.window.showInformationMessage(
									`OpenAG: Re-authenticated ${acc.email}`,
								);
							} catch (e: unknown) {
								void vscode.window.showErrorMessage(
									`OpenAG: Re-auth failed - ${e instanceof Error ? e.message : String(e)}`,
								);
							}
							this.refresh();
						}
						break;
					case "refreshAccount":
						if (message.payload) {
							try {
								this.logManager.addLog(
									"info",
									"QUOTA",
									`Refreshing quota for ${message.payload}...`,
								);
								await this.quotaMonitor.refreshAccountQuota(message.payload);
								this.logManager.addLog(
									"info",
									"QUOTA",
									`Quota refreshed for ${message.payload}.`,
								);
							} catch (e: unknown) {
								this.logManager.addLog(
									"error",
									"QUOTA",
									`Account quota refresh failed: ${e instanceof Error ? e.message : String(e)}`,
								);
							} finally {
								this.postState(true);
							}
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
							await this.statsManager.resetAndRecalculate();
							this.usageTracker?.resetProcessedLines();
							this.refresh();
						}
						break;
				}
			} catch (err: unknown) {
				this.log(
					`Message handler error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		});
	}

	private getHtmlForWebview(): string {
		const initialStateJson = JSON.stringify(this.getCurrentStateData()).replace(
			/</g,
			"\\u003c",
		);
		return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';"><meta name="viewport" content="width=device-width,initial-scale=1.0"><style>
:root {
  /* Surfaces & Backgrounds Hooked Directly to Antigravity IDE */
  --bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e2e));
  --card: var(--vscode-editorWidget-background, var(--vscode-sideBar-background, #181825));
  --border: var(--vscode-widget-border, var(--vscode-sideBar-border, rgba(255,255,255,.08)));
  --text: var(--vscode-sideBar-foreground, var(--vscode-foreground, #cdd6f4));
  --dim: var(--vscode-descriptionForeground, #a6adc8);

  /* Actions & Interactive Elements Hooked to IDE Theme */
  --accent: var(--vscode-button-background, #0078d4);
  --accent-h: var(--vscode-button-hoverBackground, #006abc);
  --hover: var(--vscode-list-hoverBackground, rgba(255,255,255,.05));

  /* Badges from IDE */
  --badge-bg: var(--vscode-badge-background, rgba(0,120,212,.25));
  --badge-fg: var(--vscode-badge-foreground, #ffffff);

  /* Workbench Typography Hooked Directly to Antigravity IDE Settings */
  --font: var(--vscode-font-family, "Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, Roboto, sans-serif);
  --font-weight: var(--vscode-font-weight, normal);
  --font-size: var(--vscode-font-size, 13px);

  /* Editor Monospace Typography Hooked Directly to Antigravity IDE Editor */
  --mono: var(--vscode-editor-font-family, var(--monaco-monospace-font, monospace));
  --mono-weight: var(--vscode-editor-font-weight, normal);
  --mono-size: var(--vscode-editor-font-size, 12px);

  /* Semantic Theme Tokens Hooked to IDE */
  --warn: var(--vscode-editorWarning-foreground, #f59e0b);
  --danger: var(--vscode-errorForeground, var(--vscode-inputValidation-errorForeground, #ef4444));
  --success: var(--vscode-testing-iconPassed, #10b981);
  --cached: var(--vscode-charts-purple, #a855f7);
  --input-col: var(--vscode-charts-blue, #3b82f6);
  --output-col: var(--vscode-charts-green, #10b981);
  --thinking-col: var(--vscode-charts-orange, var(--vscode-charts-yellow, #f59e0b));
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
button, input, select, textarea { font-family: inherit; font-weight: inherit; font-size: inherit; color: inherit; }
::selection { background: var(--vscode-editor-selectionBackground, rgba(0,120,212,.3)); color: var(--vscode-editor-selectionForeground, inherit); }
* { scrollbar-width: thin; scrollbar-color: var(--vscode-scrollbarSlider-background, rgba(255,255,255,.15)) transparent; }
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(255,255,255,.15)); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground, rgba(255,255,255,.35)); }
::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground, rgba(255,255,255,.45)); }
::-webkit-scrollbar-corner { background: transparent; }

body {
  font-family: var(--font);
  font-weight: var(--font-weight);
  font-size: var(--font-size);
  line-height: 1.4;
  background: var(--bg);
  color: var(--text);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-x: hidden;
}

a:focus-visible,
button:focus-visible,
select:focus-visible,
input:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

code, pre, .log-line, .mono {
  font-family: var(--mono);
  font-weight: var(--mono-weight);
}
.pct-text, .stat-val, .cb-val {
  font-variant-numeric: tabular-nums;
}

.row { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.badge { background: var(--badge-bg); color: var(--badge-fg); font-weight: 600; font-size: 0.85em; padding: 2px 6px; border-radius: 3px; flex-shrink: 0; }
.info-badge { display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; border-radius: 50%; background: rgba(255,255,255,.1); color: var(--dim); font-size: 0.8em; font-weight: 600; cursor: help; user-select: none; border: 1px solid var(--border); transition: background .12s, color .12s; }
.info-badge:hover { background: var(--accent); color: #fff; border-color: var(--accent); }
.sec-head { font-size: 0.85em; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--vscode-sideBarSectionHeader-foreground, var(--dim)); margin-top: 2px; display: flex; align-items: center; justify-content: space-between; }

.btn-row { display: flex; gap: 4px; align-items: center; justify-content: flex-end; flex-shrink: 0; }
.btn-row .btn { height: 22px; box-sizing: border-box; padding: 0 8px; }
.btn-row .btn-icon { width: 22px; height: 22px; min-width: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; background: var(--vscode-button-background, var(--accent)); color: var(--vscode-button-foreground, #fff); border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 3px 8px; font-size: 0.9em; font-weight: 500; cursor: pointer; white-space: nowrap; flex-shrink: 0; }
.btn:hover { background: var(--vscode-button-hoverBackground, var(--accent-h)); }
.btn-sec { background: var(--vscode-button-secondaryBackground, rgba(255,255,255,.08)); color: var(--vscode-button-secondaryForeground, var(--text)); border: 1px solid var(--vscode-button-border, var(--border)); }
.btn-sec:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(255,255,255,.14)); }
.btn-icon { padding: 2px 4px; font-size: 0.85em; min-width: 18px; }
.btn.loading { opacity: 0.75; cursor: wait; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.spin { animation: spin 0.8s linear infinite; }

.sort-select { background: var(--vscode-dropdown-background, var(--vscode-input-background, var(--card))); color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground, var(--text))); border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, var(--border))); border-radius: 3px; padding: 1px 3px; font-size: 0.88em; outline: none; cursor: pointer; }
.sort-select:focus { border-color: var(--vscode-focusBorder); }

.segmented-tabs { display: flex; background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 2px; gap: 2px; width: 100%; }
.tab-btn { flex: 1; min-width: 0; padding: 3px 2px; font-size: 0.88em; font-weight: 500; background: transparent; color: var(--dim); border: none; border-radius: 3px; cursor: pointer; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background .12s, color .12s; }
.tab-btn:hover { color: var(--text); background: var(--hover); }
.tab-btn.active { background: var(--accent); color: var(--vscode-button-foreground, #fff); font-weight: 600; }

.card { background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; display: flex; flex-direction: column; gap: 5px; min-width: 0; position: relative; }
.card.active { border-color: var(--vscode-focusBorder, var(--accent)); box-shadow: 0 0 0 1px var(--vscode-focusBorder, var(--accent)); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-width: 0; }
.card-title { font-size: 0.95em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; user-select: text; }
.card-head .card-title { flex: 1; }

.card-meta { font-size: 0.82em; color: var(--dim); display: flex; align-items: center; gap: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: -1px; }
.card-breakdown { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px; background: transparent; border: none; padding: 0; margin-top: 1px; }
.cb-item { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.cb-lbl { font-size: 0.78em; color: var(--dim); text-transform: uppercase; font-weight: 500; letter-spacing: 0.3px; }
.cb-val { font-size: 0.92em; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.tier-tag { font-size: 0.8em; font-weight: 600; padding: 1px 4px; border-radius: 3px; text-transform: uppercase; background: var(--badge-bg); color: var(--badge-fg); flex-shrink: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
.dis-tag { font-size: 0.8em; font-weight: 600; padding: 1px 4px; border-radius: 3px; background: rgba(255,255,255,.08); color: var(--dim); flex-shrink: 0; }
.chip-tag { font-size: 0.8em; font-weight: 600; padding: 1px 4px; border-radius: 3px; background: var(--vscode-keybindingLabel-background, rgba(255,255,255,.08)); color: var(--vscode-keybindingLabel-foreground, var(--text)); border: 1px solid var(--vscode-keybindingLabel-border, var(--border)); cursor: pointer; user-select: none; flex-shrink: 0; }
.chip-tag:hover { background: var(--hover); border-color: var(--vscode-focusBorder, var(--accent)); }
.err-tag { font-size: 0.8em; font-weight: 600; padding: 1px 4px; border-radius: 3px; background: var(--vscode-inputValidation-errorBackground, rgba(239,68,68,.15)); color: var(--danger); border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(239,68,68,.4)); flex-shrink: 0; }

.quota-row { display: flex; align-items: center; justify-content: space-between; font-size: 0.88em; gap: 4px; min-width: 0; }
.progress-bg { position: relative; flex: 1; height: 5px; background: rgba(255,255,255,.1); border-radius: 3px; overflow: hidden; min-width: 20px; }
.progress-fill { height: 100%; width: 100%; transform-origin: 0% 50%; will-change: transform; transition: transform .25s cubic-bezier(0.4, 0, 0.2, 1); background: var(--vscode-progressBar-background, var(--accent)); border-radius: 3px; }
.progress-fill.warn { background: var(--warn); }
.progress-fill.err { background: var(--danger); }
.reset-tag { font-size: 0.8em; padding: 1px 3px; border-radius: 3px; background: rgba(255,255,255,.06); color: var(--dim); white-space: nowrap; flex-shrink: 0; }
.reset-tag.active { background: rgba(0,120,212,.2); color: #60a5fa; }
.reset-tag.not-used { background: transparent; color: var(--dim, #888); opacity: 0.75; }

.card-menu-wrap { position: relative; display: inline-flex; }
.card-dropdown { position: absolute; right: 0; top: calc(100% + 3px); background: var(--vscode-menu-background, var(--vscode-editorWidget-background, var(--card))); color: var(--vscode-menu-foreground, var(--text)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--border))); border-radius: 4px; box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0,0,0,.45)); z-index: 150; min-width: 130px; padding: 3px; display: none; flex-direction: column; gap: 1px; }
.card-dropdown.show { display: flex; }
.card-menu-item { display: flex; align-items: center; gap: 6px; padding: 4px 8px; font-size: 0.88em; border-radius: 3px; color: var(--vscode-menu-foreground, var(--text)); background: transparent; border: none; width: 100%; text-align: left; cursor: pointer; white-space: nowrap; }
.card-menu-item:hover { background: var(--vscode-menu-selectionBackground, var(--hover)); color: var(--vscode-menu-selectionForeground, var(--text)); }
.card-menu-item.danger:hover { background: var(--vscode-inputValidation-errorBackground, rgba(239,68,68,.18)); color: var(--vscode-errorForeground, var(--danger)); }
.card-menu-item svg { flex-shrink: 0; }

.switch { position: relative; display: inline-block; width: 26px; height: 14px; cursor: pointer; flex-shrink: 0; }
.switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.slider { position: absolute; inset: 0; background: var(--vscode-input-background, rgba(255,255,255,.15)); border: 1px solid var(--vscode-input-border, transparent); border-radius: 10px; transition: .18s; }
.slider::before { position: absolute; content: ""; height: 8px; width: 8px; left: 2px; bottom: 2px; background: #fff; border-radius: 50%; transition: .18s; }
.switch input:checked + .slider { background: var(--accent); border-color: var(--accent); }
.switch input:checked + .slider::before { transform: translateX(12px); }
.switch.disabled { opacity: .4; cursor: not-allowed; }

.range-slider { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; border-radius: 3px; background: var(--vscode-scrollbarSlider-background, rgba(255,255,255,.15)); outline: none; cursor: pointer; margin: 4px 0; }
.range-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--accent); border: 2px solid var(--card); box-shadow: 0 1px 3px rgba(0,0,0,.35); cursor: pointer; transition: transform .1s, background-color .1s; }
.range-slider::-webkit-slider-thumb:hover { transform: scale(1.15); background: var(--accent-h); }
.range-slider::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--accent); border: 2px solid var(--card); box-shadow: 0 1px 3px rgba(0,0,0,.35); cursor: pointer; transition: transform .1s, background-color .1s; }
.range-slider::-moz-range-thumb:hover { transform: scale(1.15); background: var(--accent-h); }

.segmented-bar { display: flex; width: 100%; height: 6px; border-radius: 3px; overflow: hidden; background: rgba(255,255,255,.08); }
.seg-inp { background: var(--input-col); height: 100%; transition: width .3s; }
.seg-out { background: var(--output-col); height: 100%; transition: width .3s; }
.seg-cac { background: var(--cached); height: 100%; transition: width .3s; }
.seg-thk { background: var(--thinking-col); height: 100%; transition: width .3s; }

g.bar-group { cursor: pointer; transition: opacity .15s; }
g.bar-group.dimmed { opacity: 0.32; }
g.bar-group:hover rect { filter: brightness(1.15); }

.stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
.stat-box { background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.stat-val { font-size: 1.1em; font-weight: 600; color: var(--text); }
.stat-lbl { font-size: 0.8em; font-weight: 500; color: var(--dim); }

.log-scroll { display: flex; flex-direction: column; gap: 5px; max-height: 24vh; overflow-y: auto; overflow-x: hidden; padding-right: 1px; contain: content; will-change: scroll-position; }
.log-card { background: var(--card); border: 1px solid var(--border); border-radius: 4px; padding: 5px 7px; display: flex; flex-direction: column; gap: 3px; min-width: 0; user-select: text; contain: content; content-visibility: auto; contain-intrinsic-size: 0 42px; }
.log-card * { user-select: text; }
.log-meta { display: flex; align-items: center; justify-content: space-between; gap: 4px; font-size: 0.8em; color: var(--dim); }
.log-msg { font-size: 0.88em; line-height: 1.4; word-break: normal; overflow-wrap: anywhere; }
.log-msg.error { color: #f87171; }
.log-msg.warn { color: #fbbf24; }
.log-msg.rotate { color: #6ee7b7; }

.chart-scroll-box { width: 100%; overflow-x: auto; overflow-y: hidden; margin-top: 6px; contain: content; will-change: scroll-position; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
.chart-scroll-box::-webkit-scrollbar { height: 4px; }
.chart-scroll-box::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, rgba(255,255,255,.18)); border-radius: 2px; }
.chart-svg { height: 145px; overflow: visible; display: block; font-family: var(--font); }
.chart-svg text { font-family: var(--font); }
.h-scroll-box { display: flex; flex-direction: row; gap: 6px; overflow-x: auto; overflow-y: hidden; padding: 2px 1px 6px 1px; scrollbar-width: thin; -webkit-overflow-scrolling: touch; will-change: scroll-position; }
.square-card { flex: 0 0 168px; width: 168px; background: var(--card); border: 1px solid var(--border); border-radius: 5px; padding: 7px 8px; display: flex; flex-direction: column; gap: 3px; user-select: text; contain: content; }
.square-card .card-title { flex: 0 0 auto; margin: 1px 0 2px 0; }
.empty { padding: 12px; text-align: center; color: var(--dim); font-size: 0.9em; }
</style></head><body>

<div id="view-home" style="display:flex;flex-direction:column;gap:8px;">
  <div class="row" style="padding-bottom:6px;border-bottom:1px solid var(--border);">
    <div style="display:flex;align-items:center;gap:5px;">
      <span class="badge">OPENAG</span>
      <span style="font-size:0.85em;color:var(--dim);">Account Pool</span>
    </div>
    <label class="switch" title="Toggle OpenAG"><input type="checkbox" id="cfg-enabled" data-action="toggleEnabled" checked /><span class="slider"></span></label>
  </div>

  <div class="row" style="margin-top:-2px;">
    <span id="quota-last-refreshed" style="font-size:0.8em;color:var(--dim);"></span>
    <div class="btn-row">
      <button class="btn btn-sec btn-icon" id="btn-refresh-quotas" data-action="refreshQuotas" title="Refresh quotas">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z"/></svg>
      </button>
      <button class="btn" data-action="addAccount" title="Add Google Account">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>
        <span>Add</span>
      </button>
    </div>
  </div>

  <div class="sec-head">
    <div style="display:flex;align-items:center;gap:5px;">
      <span>Accounts Pool</span>
    </div>
    <div style="display:flex;align-items:center;gap:4px;">
      <span id="acc-count" style="font-size:0.8em;color:var(--dim);">0 accounts</span>
      <button class="btn btn-sec btn-icon" data-action="toggleHideEmail" id="btn-hide-email" title="Toggle Hide Email" style="font-size:0.8em;padding:1px 5px;">Hide Email</button>
    </div>
  </div>
  <div id="acc-list" style="display:flex;flex-direction:column;gap:5px;"></div>

  <div class="sec-head">
    <div style="display:flex;align-items:center;gap:5px;">
      <span>Rotation Threshold</span>
      <span class="info-badge" title="Switch Threshold (Hysteresis Delta): Minimum quota advantage required before switching accounts. At 5%, OpenAG switches to another account if its quota is at least 5% higher than the current account. Set to 0% for instant switching on any quota lead. Default: 5%.">?</span>
    </div>
    <span id="cfg-hysteresis-val" style="font-size:0.9em;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;">5%</span>
  </div>
  <div class="card" style="padding:8px 10px;display:flex;flex-direction:column;gap:5px;">
    <input type="range" class="range-slider" id="cfg-hysteresis" data-action="changeHysteresis" min="0" max="25" step="1" value="5" title="Switch Threshold (Hysteresis Delta): Minimum quota advantage required before switching accounts." />
    <div style="display:flex;justify-content:space-between;font-size:0.75em;color:var(--dim);">
      <span>0% (Instant)</span>
      <span>5% (Balanced)</span>
      <span>25% (Conservative)</span>
    </div>
  </div>

  <div class="sec-head">Token Usage Statistics</div>
  <div id="stats-widget"></div>

  <div class="sec-head">
    <span>Event Stream</span>
    <div style="display:flex;gap:4px;align-items:center;">
      <span id="log-count" style="font-size:0.8em;color:var(--dim);">0 logs</span>
      <button class="btn btn-sec btn-icon" data-action="clearLogs" title="Clear logs">Clear</button>
    </div>
  </div>
  <div class="log-scroll" id="log-scroll"></div>
</div>

<div id="view-stats" style="display:none;flex-direction:column;gap:8px;">
  <div class="row" style="padding-bottom:6px;border-bottom:1px solid var(--border);">
    <div style="display:flex;align-items:center;gap:5px;">
      <span class="badge">OPENAG</span>
      <span style="font-size:0.85em;color:var(--dim);">Token Statistics</span>
    </div>
    <button class="btn btn-sec" data-action="nav" data-view="home">&larr; Back</button>
  </div>

  <div class="sec-head" style="margin-top:0;">
    <span>Time Horizon</span>
    <button class="btn btn-sec btn-icon" data-action="recalculateStats" title="Recalculate statistics from conversation transcripts">&#x21bb;</button>
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
      <div style="display:flex;gap:7px;font-size:0.75em;flex-shrink:0;margin-left:auto;">
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
      <span id="req-count" style="font-size:0.8em;color:var(--dim);">0 reqs</span>
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
      <span id="model-count" style="font-size:0.8em;color:var(--dim);">0 models</span>
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
      <span id="conv-count" style="font-size:0.8em;color:var(--dim);">0 sessions</span>
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
function esc(s) { return s ? String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;") : ""; }
function fmtNum(n) { return typeof n === "number" ? (n >= 1e6 ? (n/1e6).toFixed(2)+"M" : n >= 1e3 ? (n/1e3).toFixed(1)+"k" : n.toLocaleString()) : "0"; }
function fmtDateTime(ts) { return ts ? new Date(ts).toLocaleString() : ""; }

function getRoleTooltip(role) {
  var isPrimary = (role || "primary") !== "reserve";
  if (isPrimary) {
    return "Pool Role: PRIMARY (Active)\\n\\n• In the main rotation pool. OpenAG rotates through Primary accounts based on highest available quota.\\n• Click to switch to RESERVE.";
  } else {
    return "Pool Role: RESERVE (Standby Backup)\\n\\n• Held in reserve. OpenAG will NEVER rotate to this account unless ALL Primary accounts are exhausted (<= 10%) or rate-limited.\\n• Click to switch to PRIMARY.";
  }
}

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
  if (!target || target.getAttribute("data-action") !== "toggleMenu") {
    var allDrops = document.querySelectorAll(".card-dropdown.show");
    for (var di = 0; di < allDrops.length; di++) {
      allDrops[di].classList.remove("show");
      var pCard = allDrops[di].closest(".card");
      if (pCard) pCard.style.zIndex = "";
    }
  }
  if (!target) return;
  var action = target.getAttribute("data-action");
  if (action === "toggleMenu") {
    var wrap = target.closest(".card-menu-wrap");
    var drop = wrap ? wrap.querySelector(".card-dropdown") : null;
    var isOpen = drop && drop.classList.contains("show");
    var allDrops = document.querySelectorAll(".card-dropdown.show");
    for (var di = 0; di < allDrops.length; di++) {
      allDrops[di].classList.remove("show");
      var cCard = allDrops[di].closest(".card");
      if (cCard) cCard.style.zIndex = "";
    }
    if (drop && !isOpen) {
      drop.classList.add("show");
      var parentCard = target.closest(".card");
      if (parentCard) parentCard.style.zIndex = "50";
    }
  } else if (action === "nav") {
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
    var svgEl = target.querySelector("svg");
    if (svgEl) svgEl.classList.add("spin");
    target.disabled = true;
    setTimeout(function() { scheduleRender(); }, 10000);
    send("refreshAccount", target.getAttribute("data-email"));
  } else if (action === "removeAccount") {
    send("removeAccount", target.getAttribute("data-email"));
  } else if (action === "addAccount") {
    send("addAccount");
  } else if (action === "refreshQuotas") {
    var rBtn = document.getElementById("btn-refresh-quotas") || target;
    rBtn.classList.add("loading");
    rBtn.title = "Refreshing...";
    var rSvg = rBtn.querySelector("svg");
    if (rSvg) rSvg.classList.add("spin");
    setTimeout(function() { scheduleRender(); }, 12000);
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
  } else if (action === "changeHysteresis") {
    var val = parseInt(target.value, 10);
    if (!isNaN(val)) {
      var valEl = document.getElementById("cfg-hysteresis-val");
      if (valEl) valEl.textContent = val + "%";
      send("updateConfig", { hysteresisDelta: val });
    }
  }
});

document.addEventListener("input", function(e) {
  var target = e.target;
  if (!target) return;
  var action = target.getAttribute("data-action");
  if (action === "changeHysteresis") {
    var val = parseInt(target.value, 10);
    if (!isNaN(val)) {
      var valEl = document.getElementById("cfg-hysteresis-val");
      if (valEl) valEl.textContent = val + "%";
    }
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
    if (e.data.forceRender) {
      lastAccountsFp = "";
      lastStatsWidgetFp = "";
    }
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
      var cfgHysteresis = document.getElementById("cfg-hysteresis");
      var cfgHysteresisVal = document.getElementById("cfg-hysteresis-val");
      var currentDelta = typeof state.config.hysteresisDelta === "number" ? state.config.hysteresisDelta : 5;
      if (cfgHysteresis) {
        cfgHysteresis.value = String(currentDelta);
      }
      if (cfgHysteresisVal) {
        cfgHysteresisVal.textContent = currentDelta + "%";
      }
      if (typeof state.config.hideEmail === "boolean") {
        hideEmail = state.config.hideEmail;
      }
    }
    var btn = document.getElementById("btn-hide-email");
    if (btn) btn.textContent = hideEmail ? "Show Email" : "Hide Email";

    var rBtn = document.getElementById("btn-refresh-quotas");
    if (rBtn) {
      rBtn.classList.remove("loading");
      rBtn.title = "Refresh quotas";
      var rSvg = rBtn.querySelector("svg");
      if (rSvg) rSvg.classList.remove("spin");
    }

    var allSpinning = document.querySelectorAll(".spin");
    for (var spi = 0; spi < allSpinning.length; spi++) {
      allSpinning[spi].classList.remove("spin");
    }
    var allDisabled = document.querySelectorAll("button[disabled]");
    for (var dsi = 0; dsi < allDisabled.length; dsi++) {
      allDisabled[dsi].disabled = false;
    }

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

function makeBarHtml(rowKey, label, pct, resetIso) {
  var p = typeof pct === "number" ? Math.min(100, Math.max(0, pct)) : 100;
  var cls = p < 20 ? "err" : p < 40 ? "warn" : "";
  var resetText = fmtTime(resetIso);
  var hasActiveTimer = (p < 100 && resetIso);
  var rTag = hasActiveTimer
    ? '<span class="reset-tag ' + (resetText !== "ready" ? "active" : "") + '" data-reset="' + esc(resetIso) + '">' + esc(resetText) + '</span>'
    : '<span class="reset-tag not-used" data-reset="">Not used yet</span>';
  var scale = (p / 100).toFixed(3);
  return '<div class="quota-row" data-row-key="' + esc(rowKey) + '">' +
    '<div style="display:flex;align-items:center;gap:3px;flex:1;min-width:0;overflow:hidden;">' +
      '<span class="row-label" style="color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(label) + '</span>' +
      rTag +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:4px;width:48%;min-width:55px;max-width:110px;flex-shrink:0;">' +
      '<div class="progress-bg"><div class="progress-fill ' + cls + '" style="transform:scaleX(' + scale + ');"></div></div>' +
      '<span class="pct-text" style="font-size:0.85em;width:26px;text-align:right;flex-shrink:0;">' + p + '%</span>' +
    '</div>' +
  '</div>';
}

function updateQuotaRow(rowEl, label, pct, resetIso) {
  var p = typeof pct === "number" ? Math.min(100, Math.max(0, pct)) : 100;
  var cls = p < 20 ? "err" : p < 40 ? "warn" : "";
  var scale = (p / 100).toFixed(3);
  var resetText = fmtTime(resetIso);

  var fillEl = rowEl.querySelector(".progress-fill");
  if (fillEl) {
    var desiredClass = "progress-fill " + cls;
    if (fillEl.className !== desiredClass) fillEl.className = desiredClass;
    var desiredTransform = "scaleX(" + scale + ")";
    if (fillEl.style.transform !== desiredTransform) fillEl.style.transform = desiredTransform;
  }

  var pctEl = rowEl.querySelector(".pct-text");
  if (pctEl && pctEl.textContent !== (p + "%")) {
    pctEl.textContent = p + "%";
  }

  var rTag = rowEl.querySelector(".reset-tag");
  if (rTag) {
    if (p < 100 && resetIso) {
      rTag.style.display = "";
      rTag.className = "reset-tag " + (resetText !== "ready" ? "active" : "");
      rTag.textContent = resetText;
      rTag.setAttribute("data-reset", resetIso);
    } else {
      rTag.style.display = "";
      rTag.className = "reset-tag not-used";
      rTag.textContent = "Not used yet";
      rTag.removeAttribute("data-reset");
    }
  }

  var lblEl = rowEl.querySelector(".row-label");
  if (lblEl && lblEl.textContent !== label) {
    lblEl.textContent = label;
  }
}

function patchCard(card, acc, idx, quotas, state, hideEmail) {
  var email = acc.email || "";
  var displayEmail = hideEmail ? ("Account " + (idx + 1)) : (acc.alias ? (acc.alias + " (" + email.split("@")[0] + ")") : email);
  var titleAttr = hideEmail ? ("Account " + (idx + 1)) : email;
  var isDis = acc.status === "disabled";
  var isAct = !isDis && email && email.toLowerCase() === ((state && state.activeEmail) || "").toLowerCase();

  var cardClass = "card " + (isAct ? "active" : "") + " " + (isDis ? "disabled" : "");
  if (card.className !== cardClass) card.className = cardClass;

  var tierEl = card.querySelector(".tier-tag");
  if (tierEl && tierEl.textContent !== (acc.tier || "pro")) {
    tierEl.textContent = acc.tier || "pro";
  }

  var titleEl = card.querySelector(".card-title");
  if (titleEl) {
    if (titleEl.textContent !== displayEmail) titleEl.textContent = displayEmail;
    if (titleEl.title !== titleAttr) titleEl.title = titleAttr;
    titleEl.setAttribute("data-email", email);
    titleEl.setAttribute("data-alias", acc.alias || "");
  }

  var affEl = card.querySelector('[data-action="toggleAffinity"]');
  var affVal = (acc.affinity || "all").toUpperCase();
  if (affEl) {
    if (affEl.textContent !== affVal) affEl.textContent = affVal;
    affEl.setAttribute("data-email", email);
    affEl.setAttribute("data-affinity", acc.affinity || "all");
    affEl.title = "Model Affinity: " + (acc.affinity || "all") + " (click to change)";
  }

  var roleEl = card.querySelector('[data-action="toggleRole"]');
  var roleVal = (acc.role || "primary").toUpperCase();
  if (roleEl) {
    if (roleEl.textContent !== roleVal) roleEl.textContent = roleVal;
    roleEl.setAttribute("data-email", email);
    roleEl.setAttribute("data-role", acc.role || "primary");
    roleEl.title = getRoleTooltip(acc.role);
  }

  var headLeft = card.querySelector(".card-head > div:first-child");
  if (headLeft) {
    var healthTag = headLeft.querySelector(".err-tag");
    var hasHealthErr = acc.health && acc.health !== "healthy";
    if (hasHealthErr) {
      var healthText = acc.health === "expired" ? "EXPIRED" : acc.health === "tos_required" ? "TOS REQ" : "ERROR";
      if (!healthTag) {
        healthTag = document.createElement("span");
        healthTag.className = "err-tag";
        headLeft.appendChild(healthTag);
      }
      healthTag.textContent = healthText;
      healthTag.title = acc.healthError || "Token requires re-authentication";
    } else if (healthTag) {
      healthTag.remove();
    }

    var statusTag = headLeft.querySelector(".dis-tag");
    var desiredTagClass = isDis ? "dis-tag" : "";
    var desiredTagText = isDis ? "OFF" : "";
    if (desiredTagClass) {
      if (!statusTag) {
        statusTag = document.createElement("span");
        headLeft.appendChild(statusTag);
      }
      statusTag.className = desiredTagClass;
      statusTag.textContent = desiredTagText;
    } else if (statusTag) {
      statusTag.remove();
    }
  }

  var switchInput = card.querySelector('input[type="checkbox"][data-action="toggleAccount"]');
  if (switchInput) {
    switchInput.setAttribute("data-email", email);
    if (switchInput.checked !== !isDis) {
      switchInput.checked = !isDis;
    }
  }

  var headRight = card.querySelector(".card-head > div:last-child");
  if (headRight && !headRight.querySelector(".card-menu-wrap")) {
    headRight.innerHTML =
      '<label class="switch" title="' + (isDis ? "Enable in pool" : "Disable in pool") + '">' +
        '<input type="checkbox" ' + (isDis ? "" : "checked") + ' data-action="toggleAccount" data-email="' + esc(email) + '" />' +
        '<span class="slider"></span>' +
      '</label>' +
      '<div class="card-menu-wrap">' +
        '<button class="btn btn-sec btn-icon" data-action="toggleMenu" title="More options" style="padding:1px 3px;line-height:1;">' +
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>' +
        '</button>' +
        '<div class="card-dropdown">' +
          '<button class="card-menu-item" data-action="reauthAccount" data-email="' + esc(email) + '" title="Re-authenticate with Google">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M11 2a4 4 0 1 0-3.32 6.236L3 13v2h2v-1h1v-1h1v-1h1.764l.236-.236A4 4 0 0 0 11 2zm-2 4a2 2 0 1 1 4 0 2 2 0 0 1-4 0z"/></svg>' +
            '<span>Re-auth Key</span>' +
          '</button>' +
          '<button class="card-menu-item" data-action="refreshAccount" data-email="' + esc(email) + '" title="Refresh quota">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z"/></svg>' +
            '<span>Refresh Quota</span>' +
          '</button>' +
          '<button class="card-menu-item danger" data-action="removeAccount" data-email="' + esc(email) + '" title="Remove account">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3V2l1-1h2l1 1v1zM5 4v9h6V4H5zm2 2h1v5H7V6zm3 0H9v5h1V6z"/></svg>' +
            '<span>Remove Account</span>' +
          '</button>' +
        '</div>' +
      '</div>';
  }

  var menuItems = card.querySelectorAll(".card-menu-item[data-email]");
  for (var mi = 0; mi < menuItems.length; mi++) {
    menuItems[mi].setAttribute("data-email", email);
  }

  var q = (email && quotas[email.toLowerCase()]) || {};
  var fams = (Array.isArray(q.families) && q.families.length)
    ? q.families.slice()
    : [{ key: "gemini", label: "Gemini", percent: 100 }, { key: "claude", label: "Claude", percent: 100 }];
  var qContainer = card.querySelector(".quota-container");
  if (!qContainer) {
    qContainer = document.createElement("div");
    qContainer.className = "quota-container";
    qContainer.style.cssText = "display:flex;flex-direction:column;gap:3px;";
    card.appendChild(qContainer);
  }

  var desiredRowKeys = [];
  for (var fi = 0; fi < fams.length; fi++) {
    var f = fams[fi];
    if (!f) continue;
    var fKey = f.key || ("fam" + fi);
    var key5h = fKey + "-5h";
    desiredRowKeys.push(key5h);
    var row5h = qContainer.querySelector('[data-row-key="' + key5h + '"]');
    var p5h = f.limit5h ? f.limit5h.percent : (f.percent || 100);
    var r5h = f.limit5h ? f.limit5h.resetTime : f.resetTime;
    var lbl5h = (f.label || "Model") + " (5h)";
    if (row5h) {
      updateQuotaRow(row5h, lbl5h, p5h, r5h);
    } else {
      qContainer.insertAdjacentHTML("beforeend", makeBarHtml(key5h, lbl5h, p5h, r5h));
    }

    if (f.limitWeekly) {
      var key7d = fKey + "-7d";
      desiredRowKeys.push(key7d);
      var row7d = qContainer.querySelector('[data-row-key="' + key7d + '"]');
      var p7d = f.limitWeekly.percent;
      var r7d = f.limitWeekly.resetTime;
      var lbl7d = (f.label || "Model") + " (7d)";
      if (row7d) {
        updateQuotaRow(row7d, lbl7d, p7d, r7d);
      } else {
        qContainer.insertAdjacentHTML("beforeend", makeBarHtml(key7d, lbl7d, p7d, r7d));
      }
    }
  }

  var existingRows = qContainer.querySelectorAll(".quota-row");
  for (var ri = 0; ri < existingRows.length; ri++) {
    var rk = existingRows[ri].getAttribute("data-row-key");
    if (rk && desiredRowKeys.indexOf(rk) === -1) {
      existingRows[ri].remove();
    }
  }
}

function createCardElement(acc, idx, quotas, state, hideEmail) {
  var email = acc.email || "";
  var displayEmail = hideEmail ? ("Account " + (idx + 1)) : (acc.alias ? (acc.alias + " (" + email.split("@")[0] + ")") : email);
  var titleAttr = hideEmail ? ("Account " + (idx + 1)) : email;
  var isDis = acc.status === "disabled";
  var isAct = !isDis && email && email.toLowerCase() === ((state && state.activeEmail) || "").toLowerCase();
  var q = (email && quotas[email.toLowerCase()]) || {};
  var fams = (Array.isArray(q.families) && q.families.length)
    ? q.families.slice()
    : [{ key: "gemini", label: "Gemini", percent: 100 }, { key: "claude", label: "Claude", percent: 100 }];

  var qHtml = '<div class="quota-container" style="display:flex;flex-direction:column;gap:3px;">' + fams.map(function(f, fi) {
    if (!f) return "";
    var fKey = f.key || ("fam" + fi);
    var html = makeBarHtml(fKey + "-5h", (f.label || "Model") + " (5h)", f.limit5h ? f.limit5h.percent : (f.percent || 100), f.limit5h ? f.limit5h.resetTime : f.resetTime);
    if (f.limitWeekly) html += makeBarHtml(fKey + "-7d", (f.label || "Model") + " (7d)", f.limitWeekly.percent, f.limitWeekly.resetTime);
    return html;
  }).join("") + '</div>';

  var tag = isDis ? '<span class="dis-tag">OFF</span>' : '';
  var affTag = '<span class="chip-tag" data-action="toggleAffinity" data-email="' + esc(email) + '" data-affinity="' + esc(acc.affinity || "all") + '" title="Model Affinity: ' + esc(acc.affinity || "all") + ' (click to change)">' + esc((acc.affinity || "all").toUpperCase()) + '</span>';
  var roleTag = '<span class="chip-tag" data-action="toggleRole" data-email="' + esc(email) + '" data-role="' + esc(acc.role || "primary") + '" title="' + esc(getRoleTooltip(acc.role)) + '">' + esc((acc.role || "primary").toUpperCase()) + '</span>';
  var healthBadge = (acc.health && acc.health !== "healthy")
    ? ('<span class="err-tag" title="' + esc(acc.healthError || "Token requires re-authentication") + '">' + (acc.health === "expired" ? "EXPIRED" : acc.health === "tos_required" ? "TOS REQ" : "ERROR") + '</span>')
    : "";

  var div = document.createElement("div");
  div.className = "card " + (isAct ? "active" : "") + " " + (isDis ? "disabled" : "");
  div.setAttribute("data-account-email", email.toLowerCase());
  div.innerHTML = '<div class="card-head">' +
    '<div style="display:flex;align-items:center;gap:3px;overflow:hidden;flex:1;min-width:0;">' +
      '<span class="tier-tag">' + esc(acc.tier || "pro") + '</span>' +
      '<span class="card-title" title="' + esc(titleAttr) + '" data-action="editAlias" data-email="' + esc(email) + '" data-alias="' + esc(acc.alias || "") + '" style="cursor:pointer;">' + esc(displayEmail) + '</span>' +
      affTag +
      roleTag +
      healthBadge +
      tag +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:3px;flex-shrink:0;">' +
      '<label class="switch" title="' + (isDis ? "Enable in pool" : "Disable in pool") + '">' +
        '<input type="checkbox" ' + (isDis ? "" : "checked") + ' data-action="toggleAccount" data-email="' + esc(email) + '" />' +
        '<span class="slider"></span>' +
      '</label>' +
      '<div class="card-menu-wrap">' +
        '<button class="btn btn-sec btn-icon" data-action="toggleMenu" title="More options" style="padding:1px 3px;line-height:1;">' +
          '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg>' +
        '</button>' +
        '<div class="card-dropdown">' +
          '<button class="card-menu-item" data-action="reauthAccount" data-email="' + esc(email) + '" title="Re-authenticate with Google">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M11 2a4 4 0 1 0-3.32 6.236L3 13v2h2v-1h1v-1h1v-1h1.764l.236-.236A4 4 0 0 0 11 2zm-2 4a2 2 0 1 1 4 0 2 2 0 0 1-4 0z"/></svg>' +
            '<span>Re-auth Key</span>' +
          '</button>' +
          '<button class="card-menu-item" data-action="refreshAccount" data-email="' + esc(email) + '" title="Refresh quota">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M4.681 3H2V2h3.5l.5.5V6H5V4a5 5 0 1 0 4.53-.761l.302-.954A6 6 0 1 1 4.681 3z"/></svg>' +
            '<span>Refresh Quota</span>' +
          '</button>' +
          '<button class="card-menu-item danger" data-action="removeAccount" data-email="' + esc(email) + '" title="Remove account">' +
            '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3h3v1h-1v9l-1 1H5l-1-1V4H3V3h3V2l1-1h2l1 1v1zM5 4v9h6V4H5zm2 2h1v5H7V6zm3 0H9v5h1V6z"/></svg>' +
            '<span>Remove Account</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>' +
  qHtml;
  return div;
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

  var fp = (hideEmail ? "1" : "0") + "|" + (accountsExpanded ? "1" : "0") + "|" + (state.activeEmail || "") + "|" + accs.length;
  for (var fi = 0; fi < accs.length; fi++) {
    var fa = accs[fi];
    var fq = fa.email ? quotas[fa.email.toLowerCase()] : null;
    fp += "|" + fa.email + ":" + fa.status + ":" + fa.tier + ":" + fa.alias + ":" + fa.affinity + ":" + fa.role + ":" + fa.health;
    if (fq) {
      fp += ":" + (fq.lastUpdated || 0);
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

  var emptyPlaceholder = list.querySelector(".empty");
  if (emptyPlaceholder) emptyPlaceholder.remove();

  var existingCards = {};
  var cardNodes = list.querySelectorAll(".card[data-account-email]");
  for (var ci = 0; ci < cardNodes.length; ci++) {
    var emailAttr = cardNodes[ci].getAttribute("data-account-email");
    if (emailAttr) existingCards[emailAttr] = cardNodes[ci];
  }

  var visibleEmails = {};
  for (var vi = 0; vi < visibleAccs.length; vi++) {
    var vacc = visibleAccs[vi];
    var vEmail = (vacc.email || "").toLowerCase();
    visibleEmails[vEmail] = true;
    var existingCard = existingCards[vEmail];
    if (existingCard) {
      patchCard(existingCard, vacc, vi, quotas, state, hideEmail);
    } else {
      var newCard = createCardElement(vacc, vi, quotas, state, hideEmail);
      list.appendChild(newCard);
      existingCards[vEmail] = newCard;
    }
  }

  for (var oldEmail in existingCards) {
    if (!visibleEmails[oldEmail]) {
      existingCards[oldEmail].remove();
    }
  }

  for (var oi = 0; oi < visibleAccs.length; oi++) {
    var ordEmail = (visibleAccs[oi].email || "").toLowerCase();
    var cardToOrder = existingCards[ordEmail];
    if (cardToOrder) {
      list.appendChild(cardToOrder);
    }
  }

  var expandBtn = list.querySelector('button[data-action="toggleExpandAccounts"]');
  if (accs.length > 3) {
    var btnText = !accountsExpanded
      ? ("Show more (" + (accs.length - 3) + " more) \u25bc")
      : "Show less \u25b2";
    if (!expandBtn) {
      expandBtn = document.createElement("button");
      expandBtn.className = "btn btn-sec";
      expandBtn.setAttribute("data-action", "toggleExpandAccounts");
      expandBtn.style.cssText = "width:100%;margin-top:2px;font-size:0.85em;padding:3px 6px;";
      list.appendChild(expandBtn);
    } else {
      list.appendChild(expandBtn);
    }
    if (expandBtn.textContent !== btnText) {
      expandBtn.textContent = btnText;
    }
  } else if (expandBtn) {
    expandBtn.remove();
  }
}

var lastStatsWidgetFp = "";
function renderStatsWidget() {
  var container = document.getElementById("stats-widget");
  if (!container) return;
  var s = (state && state.stats) || {};
  var t = s.today || { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, thinkingTokens: 0, contentTokens: 0, cacheMissTokens: 0 };
  var fp = (t.totalTokens || 0) + ":" + (t.inputTokens || 0) + ":" + (t.outputTokens || 0) + ":" + (t.cacheHitTokens || 0) + ":" + (t.thinkingTokens || 0) + ":" + (t.cacheMissTokens || 0);
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
        '<span style="font-size:0.95em;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Today: ' + fmtNum(t.totalTokens || 0) + ' <span style="font-size:0.85em;font-weight:600;color:var(--cached);" title="' + esc(cacHover) + '">(' + pCac + '%)</span></span>' +
      '</div>' +
      '<button class="btn btn-sec" data-action="nav" data-view="stats" style="font-size:0.85em;padding:2px 6px;flex-shrink:0;">Stats &rarr;</button>' +
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
    var topText = total > 0 ? '<text x="' + (x + barWidth / 2) + '" y="' + textY + '" text-anchor="middle" font-size="9" font-weight="' + (isSelected ? '600' : '500') + '" fill="' + (isSelected ? '#60a5fa' : '#f8fafc') + '">' + fmtNum(total) + '</text>' : '';
    var dateText = '<text x="' + (x + barWidth / 2) + '" y="132" text-anchor="middle" font-size="9" fill="' + (isSelected ? '#fff' : '#94a3b8') + '" font-weight="' + (isSelected ? '600' : '400') + '">' + label + '</text>';

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
      : '<div class="stat-box"><span class="stat-lbl">Cache Hit Rate</span><span class="stat-val" style="color:var(--cached);">' + fmtNum(rangeTotalHit) + ' <span style="font-size:0.75em;font-weight:600;color:var(--dim);">(' + rangeHitRate + '%)</span></span></div>';

    allTimeGrid.innerHTML =
      '<div class="stat-box"><span class="stat-lbl">Processed</span><span class="stat-val">' + fmtNum(rangeTotalTokens) + '</span></div>' +
      '<div class="stat-box" title="' + esc(promptCacHover) + '"><span class="stat-lbl">Prompt Input</span><span class="stat-val" style="color:var(--input-col);">' + fmtNum(rangeTotalInp) + ' <span style="font-size:0.75em;font-weight:600;color:var(--cached);">(' + rangeHitRate + '%)</span></span></div>' +
      '<div class="stat-box"><span class="stat-lbl">Completion Output</span><span class="stat-val" style="color:var(--output-col);">' + fmtNum(rangeTotalOut) + '</span></div>' +
      thkMetricHtml;
  }

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
      ? '<div class="row" style="background:var(--card);border:1px solid var(--accent);border-radius:5px;padding:3px 7px;width:100%;margin-bottom:3px;"><span style="font-size:0.8em;color:var(--text);font-weight:600;">Filtered to ' + esc(selectedBarLabel || "Slice") + '</span><button class="btn btn-sec btn-icon" data-action="clearBarFilter" style="font-size:0.75em;padding:1px 4px;">Clear</button></div>'
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
          '<span style="font-size:0.75em;color:var(--dim);text-transform:uppercase;font-weight:500;">Tokens</span>' +
          '<span style="font-size:1.1em;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;">' + fmtNum(r.totalTokens || 0) + ' <span style="font-size:0.78em;font-weight:600;color:var(--cached);" title="' + esc(rCacHover) + '">(' + hitRate + '%)</span></span>' +
        '</div>' +
        '<div class="card-meta"><span>' + tCount + (tCount === 1 ? " turn" : " turns") + '</span><span>' + dateStr + (timeStr ? ' ' + timeStr : '') + '</span></div>' +
        '<div class="card-breakdown" style="' + cbColumns + '">' +
          '<div class="cb-item" title="' + esc(rCacHover) + '"><span class="cb-lbl">In</span><span class="cb-val" style="color:var(--input-col);">' + fmtNum(r.inputTokens || 0) + '</span></div>' +
          '<div class="cb-item"><span class="cb-lbl">Out</span><span class="cb-val" style="color:var(--output-col);">' + fmtNum(outVal > 0 ? outVal : r.outputTokens || 0) + '</span></div>' +
          thkItem +
        '</div>' +
      '</div>';
    }).join("")) : (filterBanner + '<div class="empty" style="width:100%;">No requests in this period.</div>');
    if (prevReqScroll > 0) reqBreakdownEl.scrollLeft = prevReqScroll;
  }

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
          '<span style="font-size:0.75em;color:var(--dim);text-transform:uppercase;font-weight:500;">Volume</span>' +
          '<span style="font-size:1.1em;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;">' + fmtNum(b.total) + ' <span style="font-size:0.78em;font-weight:600;color:var(--cached);" title="' + esc(mCacHover) + '">(' + mHitRate + '%)</span></span>' +
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
          '<span style="font-size:0.75em;color:var(--dim);text-transform:uppercase;font-weight:500;">Tokens</span>' +
          '<span style="font-size:1.1em;font-weight:600;color:var(--text);font-variant-numeric:tabular-nums;">' + fmtNum(c.totalTokens || 0) + ' <span style="font-size:0.78em;font-weight:600;color:var(--cached);" title="' + esc(cCacHover) + '">(' + cHitRate + '%)</span></span>' +
        '</div>' +
        '<div class="card-meta"><span>' + cTurns + (cTurns === 1 ? " turn" : " turns") + '</span><span>' + cDateStr + (cTimeStr ? ' ' + cTimeStr : '') + '</span></div>' +
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
        '<span>' + (l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : "") + '</span>' +
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
