import * as vscode from "vscode";
import { HookServer } from "./core/hook-server.js";
import { LogManager } from "./core/log-manager.js";
import { OAuthFlow } from "./core/oauth-flow.js";
import { QuotaMonitor } from "./core/quota-monitor.js";
import { StatsManager } from "./core/stats-manager.js";
import { TokenManager } from "./core/token-manager.js";
import { UsageTracker } from "./core/usage-tracker.js";
import { USSBridge } from "./core/uss-bridge.js";
import { StatusBarHUD } from "./ui/status-bar.js";
import { WebviewProvider } from "./ui/webview-provider.js";
import type { Account, AccountQuota } from "./types.js";

let outputChannel: vscode.OutputChannel;
let tokenManager: TokenManager | null = null;
let quotaMonitor: QuotaMonitor | null = null;
let statusBar: StatusBarHUD | null = null;
let webviewProvider: WebviewProvider | null = null;
let logManager: LogManager | null = null;
let usageTracker: UsageTracker | null = null;
let statsManager: StatsManager | null = null;
let hookServer: HookServer | null = null;

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

interface QuickStatusItem extends vscode.QuickPickItem {
  email?: string;
  isAction?: boolean;
  action?: () => void;
}

function buildQuickStatusItems(
  accounts: Account[],
  activeEmail: string,
  quotas: Record<string, AccountQuota | undefined>,
): QuickStatusItem[] {
  const resetTimeStr = (iso?: string) => {
    if (!iso) return "";
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return "ready";
    const mins = Math.floor(diff / 60000);
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    const rel = hrs > 0 ? `${hrs}h ${remMins}m` : `${remMins}m`;
    const clock = new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${rel} (${clock})`;
  };

  const items: QuickStatusItem[] = accounts.map((acc): QuickStatusItem => {
    const isAct = acc.email.toLowerCase() === activeEmail.toLowerCase();
    const q = quotas[acc.email.toLowerCase()];
    const fams = q?.families || [];
    const geminiFam = fams.find((f: { key: string }) => f.key === "gemini");
    const claudeFam = fams.find((f: { key: string }) => f.key === "claude");

    const gemini5h = geminiFam?.limit5h?.percent ?? geminiFam?.percent ?? 100;
    const claude5h = claudeFam?.limit5h?.percent ?? claudeFam?.percent ?? 100;

    const gReset = resetTimeStr(geminiFam?.limit5h?.resetTime || geminiFam?.resetTime);
    const cReset = resetTimeStr(claudeFam?.limit5h?.resetTime || claudeFam?.resetTime);

    const healthStr = acc.health && acc.health !== "healthy" ? ` | ⚠️ ${acc.health.toUpperCase()}` : "";
    const desc = `[${(acc.tier || "pro").toUpperCase()}] ${(acc.affinity || "all").toUpperCase()} · ${(acc.role || "primary").toUpperCase()}${isAct ? " · [ACTIVE]" : ""}${healthStr}`;
    const detail = `Gemini: ${gemini5h}%${gReset ? ` (resets ${gReset})` : ""} | Claude: ${claude5h}%${cReset ? ` (resets ${cReset})` : ""}`;

    return {
      label: `$(account) ${acc.alias ? `${acc.alias} (${acc.email})` : acc.email}`,
      description: desc,
      detail,
      email: acc.email,
    };
  });

  items.push(
    {
      label: "$(refresh) Refresh All Quotas",
      description: "Poll latest quotas from Google Cloud",
      isAction: true,
      action: () => void vscode.commands.executeCommand("openag.refreshQuotas"),
    },
    {
      label: "$(add) Add Google Account",
      description: "Sign in with another Google account",
      isAction: true,
      action: () => void vscode.commands.executeCommand("openag.addAccount"),
    },
  );

  return items;
}

export function activate(context: vscode.ExtensionContext): ExtensionExports {
  outputChannel = vscode.window.createOutputChannel("OpenAG");

  logManager = new LogManager(context);
  statsManager = new StatsManager(context, log);
  usageTracker = new UsageTracker(statsManager);
  tokenManager = new TokenManager(context, log, usageTracker);
  statusBar = new StatusBarHUD(context, statsManager, tokenManager);

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

  hookServer = new HookServer(tokenManager, quotaMonitor, log);
  void hookServer.start();

  context.subscriptions.push(
    logManager,
    usageTracker,
    statsManager,
    { dispose: () => hookServer?.dispose() },
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
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        quotaMonitor?.notifyActivity();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("openag")) {
        tokenManager?.loadVscodeSettings();
        quotaMonitor?.restartPolling();
        webviewProvider?.refresh();
      }
    }),
  );

  usageTracker.onContextChange((ctx) => {
    quotaMonitor?.notifyActivity();
    statusBar?.updateContext(ctx);
    if (tokenManager && quotaMonitor) {
      void tokenManager.autoSelectHighestQuota(quotaMonitor.getAllQuotas(), `model ${ctx.model}`, ctx.model);
    }
  });

  usageTracker.onRateLimit(async (evt) => {
    log(`[RateLimit Intercept] 429/RESOURCE_EXHAUSTED detected on ${evt.model}. Initiating immediate failover...`);
    if (tokenManager && quotaMonitor) {
      const active = tokenManager.getActiveAccount();
      if (active) {
        quotaMonitor.markAccountExhausted(active.email, evt.model);
        await tokenManager.autoSelectHighestQuota(quotaMonitor.getAllQuotas(), "rate_limit_failover", evt.model);
      }
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
        const existing = accounts.find((a) => a.email.toLowerCase() === ideEmail.toLowerCase());
        if (!existing) {
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
        } else if (ideTokens.accessToken !== existing.accessToken || (ideTokens.refreshToken && ideTokens.refreshToken !== existing.refreshToken)) {
          log(`[IDE Sync] Updating credentials from IDE for: ${ideEmail}`);
          await tokenManager.addOrUpdateAccount({
            ...existing,
            accessToken: ideTokens.accessToken,
            refreshToken: ideTokens.refreshToken || existing.refreshToken || "",
            tokenExpiresAt: ideTokens.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
            status: "active",
            health: "healthy",
            healthError: undefined,
          });
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
    vscode.commands.registerCommand("openag.exportPool", async () => {
      try {
        if (!tokenManager || tokenManager.getAccounts().length === 0) {
          void vscode.window.showWarningMessage("OpenAG: No accounts to export.");
          return;
        }
        const passphrase = await vscode.window.showInputBox({
          title: "OpenAG: Export Account Pool",
          prompt: "Enter a passphrase to encrypt your account pool",
          password: true,
        });
        if (!passphrase) return;

        const confirmPass = await vscode.window.showInputBox({
          title: "OpenAG: Confirm Passphrase",
          prompt: "Re-enter your encryption passphrase",
          password: true,
        });
        if (!confirmPass) return;
        if (passphrase !== confirmPass) {
          void vscode.window.showErrorMessage("OpenAG: Passphrases do not match.");
          return;
        }

        const encrypted = await tokenManager.exportAllAccounts(passphrase);
        await vscode.env.clipboard.writeText(encrypted);
        void vscode.window.showInformationMessage(`OpenAG: Encrypted pool with ${tokenManager.getAccounts().length} accounts copied to clipboard.`);
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(`OpenAG: Export failed - ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand("openag.importPool", async () => {
      try {
        if (!tokenManager) return;
        const rawJson = await vscode.window.showInputBox({
          title: "OpenAG: Import Account Pool",
          prompt: "Paste the encrypted pool JSON string",
          ignoreFocusOut: true,
        });
        if (!rawJson) return;

        const passphrase = await vscode.window.showInputBox({
          title: "OpenAG: Decryption Passphrase",
          prompt: "Enter the passphrase used to encrypt this pool",
          password: true,
          ignoreFocusOut: true,
        });
        if (!passphrase) return;

        const count = await tokenManager.importAccounts(rawJson, passphrase);
        await syncIdeAuth();
        void quotaMonitor?.pollAllAccounts();
        void vscode.window.showInformationMessage(`OpenAG: Successfully imported ${count} accounts.`);
        webviewProvider?.refresh();
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(`OpenAG: Import failed - ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand("openag.quickStatus", async () => {
      try {
        if (!tokenManager || !quotaMonitor) return;
        const accounts = tokenManager.getAccounts();
        if (accounts.length === 0) {
          const add = await vscode.window.showInformationMessage("OpenAG: No accounts in pool.", "Add Account");
          if (add === "Add Account") void vscode.commands.executeCommand("openag.addAccount");
          return;
        }

        const items = buildQuickStatusItems(accounts, tokenManager.getActiveEmail(), quotaMonitor.getAllQuotas());
        const selected = await vscode.window.showQuickPick(items, {
          title: "OpenAG: Accounts & Quotas",
          placeHolder: "Select an account to switch or choose an action",
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (selected?.isAction && selected.action) {
          selected.action();
        } else if (selected?.email) {
          await tokenManager.selectAccount(selected.email);
          void vscode.window.showInformationMessage(`OpenAG: Switched active account to ${selected.email}`);
        }
      } catch (e: unknown) {
        void vscode.window.showErrorMessage(`OpenAG: Quick Status error - ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand("openag.installAntigravityHook", () => {
      try {
        HookServer.registerGlobalHook(context.extensionPath);
        void vscode.window.showInformationMessage("OpenAG: PreInvocation hook registered in ~/.gemini/config/hooks.json");
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(`OpenAG: Failed to register hook: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
    vscode.commands.registerCommand("openag.removeAntigravityHook", () => {
      try {
        HookServer.removeGlobalHook();
        void vscode.window.showInformationMessage("OpenAG: PreInvocation hook removed from ~/.gemini/config/hooks.json");
      } catch (err: unknown) {
        void vscode.window.showErrorMessage(`OpenAG: Failed to remove hook: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  log("OpenAG activated successfully.");
  return { tokenManager, quotaMonitor };
}

export function deactivate(): void {
  hookServer?.dispose();
  tokenManager?.dispose();
  quotaMonitor?.dispose();
  statusBar?.dispose();
}
