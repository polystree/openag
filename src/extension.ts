import * as vscode from "vscode";
import { LogManager } from "./core/log-manager.js";
import { OAuthFlow } from "./core/oauth-flow.js";
import { AutoRunPatcher } from "./core/patcher.js";
import { QuotaMonitor } from "./core/quota-monitor.js";
import { StatsManager } from "./core/stats-manager.js";
import { TokenManager } from "./core/token-manager.js";
import { UsageTracker } from "./core/usage-tracker.js";
import { USSBridge } from "./core/uss-bridge.js";
import { StatusBarHUD } from "./ui/status-bar.js";
import { WebviewProvider } from "./ui/webview-provider.js";

let outputChannel: vscode.OutputChannel;
let tokenManager: TokenManager | null = null;
let quotaMonitor: QuotaMonitor | null = null;
let statusBar: StatusBarHUD | null = null;
let webviewProvider: WebviewProvider | null = null;
let logManager: LogManager | null = null;
let usageTracker: UsageTracker | null = null;
let statsManager: StatsManager | null = null;

function getLogCategory(msg: string): "ROTATION" | "QUOTA" | "USS" | "AUTH" | "SYSTEM" {
  if (msg.includes("AutoRotate") || msg.includes("ROTATION")) return "ROTATION";
  if (msg.includes("Quota") || msg.includes("QUOTA")) return "QUOTA";
  if (msg.includes("IDE Sync") || msg.includes("USS")) return "USS";
  if (msg.includes("AUTH") || msg.includes("Authorized") || msg.includes("Login") || msg.includes("token")) return "AUTH";
  return "SYSTEM";
}

function getLogLevel(msg: string): "info" | "warn" | "error" | "rotate" {
  const lower = msg.toLowerCase();
  if (lower.includes("error") || lower.includes("fail")) return "error";
  if (msg.includes("AutoRotate")) return "rotate";
  return "info";
}

const log = (msg: string): void => {
  outputChannel?.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
  logManager?.addLog(getLogLevel(msg), getLogCategory(msg), msg);
};

export interface ExtensionExports {
  tokenManager: TokenManager;
  quotaMonitor: QuotaMonitor;
}

export function activate(context: vscode.ExtensionContext): ExtensionExports {
  outputChannel = vscode.window.createOutputChannel("OpenAG");
  logManager = new LogManager(context);
  statsManager = new StatsManager(context, log);
  usageTracker = new UsageTracker(statsManager);
  tokenManager = new TokenManager(context, log, usageTracker);
  statusBar = new StatusBarHUD(context);

  quotaMonitor = new QuotaMonitor(
    tokenManager,
    log,
    (quota) => {
      if (quota.email.toLowerCase() === (tokenManager?.getActiveEmail() || "").toLowerCase()) {
        statusBar?.updateQuota(quota);
      }
      webviewProvider?.refresh();
    },
    usageTracker,
    context,
  );

  webviewProvider = new WebviewProvider(context, tokenManager, quotaMonitor, log, logManager, statsManager, usageTracker);

  context.subscriptions.push(
    logManager,
    usageTracker,
    statsManager,
    vscode.window.registerWebviewViewProvider(WebviewProvider.viewType, webviewProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    tokenManager.onAccountChange(async () => {
      const active = tokenManager?.getActiveAccount();
      const quota = active ? quotaMonitor?.getQuota(active.email) : null;
      statusBar?.updateAccount(active?.email ?? "", active?.tier ?? "unknown", tokenManager?.isExtensionEnabled() ?? true, quota);
      statusBar?.flashRotating();
      webviewProvider?.refresh();
    }),
  );

  usageTracker.onContextChange((ctx) => {
    statusBar?.updateContext(ctx);
    if (tokenManager && quotaMonitor) {
      void tokenManager.autoSelectHighestQuota(quotaMonitor.getAllQuotas(), `model ${ctx.model}`, ctx.model);
    }
  });
  logManager.onLog(() => webviewProvider?.refresh());
  statsManager.onStatsChange(() => webviewProvider?.refresh());

  const syncIdeAuth = async () => {
    if (!tokenManager?.isExtensionEnabled()) return;
    try {
      const ideTokens = await USSBridge.getOAuthToken();
      const ideEmail = await USSBridge.getIdeEmail();
      if (ideEmail && ideTokens?.accessToken && tokenManager) {
        const accounts = tokenManager.getAccounts();
        const exists = accounts.some((a) => a.email.toLowerCase() === ideEmail.toLowerCase());
        if (!exists) {
          log(`[IDE Sync] Auto-importing new account from IDE: ${ideEmail}`);
          await tokenManager.addOrUpdateAccount({
            email: ideEmail,
            accessToken: ideTokens.accessToken,
            refreshToken: ideTokens.refreshToken || "",
            tokenExpiresAt: ideTokens.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
            tier: "pro",
            status: "active",
            sortOrder: accounts.length,
          });
          void quotaMonitor?.pollAllAccounts();
        }
      }
    } catch (e: unknown) {
      log(`IDE auth sync error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const updateWorkspacePaths = () => {
    const folders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath || f.uri.toString()) || [];
    usageTracker?.setWorkspacePaths(folders);
  };

  updateWorkspacePaths();

  void (async () => {
    try {
      log("Activating OpenAG...");
      if (tokenManager) await tokenManager.initialize();
      quotaMonitor?.initialize();
      const activeAcc = tokenManager?.getActiveAccount();
      const initQuota = activeAcc && quotaMonitor ? quotaMonitor.getQuota(activeAcc.email) : null;
      statusBar?.updateAccount(tokenManager?.getActiveEmail() || "", activeAcc?.tier || "unknown", tokenManager?.isExtensionEnabled() ?? true, initQuota);
      webviewProvider?.refresh();
      await syncIdeAuth();
    } catch (err: unknown) {
      log(`OpenAG background init error: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();

  const syncTimer = setInterval(() => void syncIdeAuth(), 10000);

  context.subscriptions.push(
    { dispose: () => clearInterval(syncTimer) },
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
        void syncIdeAuth();
        usageTracker?.refresh();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateWorkspacePaths()),
  );

  const registerAuthAccount = async (res: { email: string; tokens: { accessToken: string; refreshToken: string; expiryDateSeconds: number } }) => {
    if (!tokenManager) return;
    await tokenManager.addOrUpdateAccount({
      email: res.email,
      accessToken: res.tokens.accessToken,
      refreshToken: res.tokens.refreshToken,
      tokenExpiresAt: res.tokens.expiryDateSeconds,
      tier: "pro",
      status: "active",
      sortOrder: tokenManager.getAccounts().length,
    });
    void quotaMonitor?.pollAllAccounts();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("openag.openPanel", () => void vscode.commands.executeCommand("openag.accounts.focus")),
    vscode.commands.registerCommand("openag.enable", async () => {
      await tokenManager?.updateConfig({ enabled: true });
      vscode.window.showInformationMessage("OpenAG: Extension enabled");
    }),
    vscode.commands.registerCommand("openag.disable", async () => {
      await tokenManager?.updateConfig({ enabled: false });
      vscode.window.showInformationMessage("OpenAG: Extension disabled");
    }),
    vscode.commands.registerCommand("openag.addAccount", async () => {
      try {
        vscode.window.showInformationMessage("OpenAG: Opening browser for Google login...");
        const res = await OAuthFlow.startLogin();
        await registerAuthAccount(res);
        vscode.window.showInformationMessage(`OpenAG: Account added - ${res.email}`);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`OpenAG: Login failed - ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand("openag.refreshQuotas", async () => {
      await syncIdeAuth();
      await quotaMonitor?.pollAllAccounts();
      vscode.window.showInformationMessage("OpenAG: Quotas refreshed");
    }),
    vscode.commands.registerCommand("openag.applyAutoRunFix", async () => {
      const res = AutoRunPatcher.apply();
      log(`[AutoRun Fix] ${res.message}`);
      if (res.success) {
        const reload = await vscode.window.showInformationMessage(`OpenAG: ${res.message}`, "Reload Window");
        if (reload === "Reload Window") void vscode.commands.executeCommand("workbench.action.reloadWindow");
      } else {
        void vscode.window.showErrorMessage(`OpenAG: ${res.message}`);
      }
      webviewProvider?.refresh();
    }),
    vscode.commands.registerCommand("openag.revertAutoRunFix", async () => {
      const res = AutoRunPatcher.revert();
      log(`[AutoRun Fix] ${res.message}`);
      if (res.success) {
        const reload = await vscode.window.showInformationMessage(`OpenAG: ${res.message}`, "Reload Window");
        if (reload === "Reload Window") void vscode.commands.executeCommand("workbench.action.reloadWindow");
      } else {
        void vscode.window.showErrorMessage(`OpenAG: ${res.message}`);
      }
      webviewProvider?.refresh();
    }),
  );

  log("OpenAG activated successfully.");
  return { tokenManager, quotaMonitor };
}

export function deactivate(): void {
  tokenManager?.dispose();
  quotaMonitor?.dispose();
  statusBar?.dispose();
}
