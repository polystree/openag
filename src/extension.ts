import * as vscode from "vscode";
import { HookServer } from "./core/hook-server.js";
import { LanguageServerClient } from "./core/language-server-client.js";
import { LogManager } from "./core/log-manager.js";
import { OAuthFlow } from "./core/oauth-flow.js";
import { QuotaMonitor } from "./core/quota-monitor.js";
import { StatsManager } from "./core/stats-manager.js";
import { TokenManager } from "./core/token-manager.js";
import { UsageTracker } from "./core/usage-tracker.js";
import { setUSSBridgeLogger, USSBridge } from "./core/uss-bridge.js";
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

export function maskEmail(email: string): string {
  const atIdx = email.indexOf("@");
  if (atIdx <= 1) return email.replace(/^./, "*");
  const user = email.slice(0, atIdx);
  const domain = email.slice(atIdx);
  return `${user[0]}***${domain}`;
}

export function maskEmailsInText(text: string): string {
  return text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (m) => maskEmail(m));
}

function isEvaluationRetentionLog(msg: string): boolean {
  return (
    msg.includes("Retaining active account") ||
    msg.includes("delta <=") ||
    msg.includes("exhaustion headroom") ||
    msg.includes("imminent reset in") ||
    msg.includes("Language server quota check skipped")
  );
}

function getLogCategory(msg: string): "ROTATION" | "QUOTA" | "USS" | "AUTH" | "SYSTEM" {
  if (msg.includes("Switching to") || msg.includes("switched to") || msg.includes("Cycling to") || msg.includes("ROTATION")) return "ROTATION";
  if (msg.includes("Quota") || msg.includes("QUOTA")) return "QUOTA";
  if (msg.includes("IDE Sync") || msg.includes("USS")) return "USS";
  if (msg.includes("AUTH") || msg.includes("Authorized") || msg.includes("Login") || msg.includes("token")) return "AUTH";
  return "SYSTEM";
}

function getLogLevel(msg: string): "info" | "warn" | "error" | "rotate" {
  const lower = msg.toLowerCase();
  if (lower.includes("error") || lower.includes("fail") || lower.includes("429")) return "error";
  if (lower.includes("warn") || lower.includes("exhausted")) return "warn";
  if (
    msg.includes("[AutoRotate] Switching to") ||
    msg.includes("Active account switched to")
  ) {
    return "rotate";
  }
  return "info";
}

const log = (msg: string): void => {
  const hideEmail = tokenManager?.getConfig()?.hideEmail ?? vscode.workspace?.getConfiguration?.("openag")?.get<boolean>("hideEmail") ?? false;
  const safeMsg = hideEmail ? maskEmailsInText(msg) : msg;
  outputChannel?.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${safeMsg}`);
  if (!isEvaluationRetentionLog(msg)) {
    logManager?.addLog(getLogLevel(msg), getLogCategory(msg), safeMsg);
  }
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

    const geminiPct = geminiFam?.percent ?? 100;
    const claudePct = claudeFam?.percent ?? 100;

    const gReset = geminiPct < 100 ? resetTimeStr(geminiFam?.resetTime) : "";
    const cReset = claudePct < 100 ? resetTimeStr(claudeFam?.resetTime) : "";

    const healthStr = acc.health && acc.health !== "healthy" ? ` | ⚠️ ${acc.health.toUpperCase()}` : "";
    const desc = `[${(acc.tier || "pro").toUpperCase()}] ${(acc.affinity || "all").toUpperCase()} · ${(acc.role || "primary").toUpperCase()}${isAct ? " · [ACTIVE]" : ""}${healthStr}`;
    const detail = `Gemini: ${geminiPct}%${gReset ? ` (resets ${gReset})` : ""} | Claude: ${claudePct}%${cReset ? ` (resets ${cReset})` : ""}`;

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
  setUSSBridgeLogger(log);
  usageTracker = new UsageTracker(statsManager, log);
  tokenManager = new TokenManager(context, log, usageTracker);
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const lsClient = new LanguageServerClient(workspacePath, log);
  tokenManager.setLanguageServerClient(lsClient);
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
    workspacePath,
  );

  webviewProvider = new WebviewProvider(context, tokenManager, quotaMonitor, log, logManager, statsManager, usageTracker);

  hookServer = new HookServer(tokenManager, quotaMonitor, log, workspacePath);
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
      statusBar?.clearRateLimit(active?.email ?? "");
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
        statusBar?.markRateLimited(active.email, evt.model);
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
      if (!ideTokens?.accessToken) return;

      const accounts = tokenManager.getAccounts();
      // Only bootstrap from IDE if pool is completely empty. Never clobber existing pool accounts from USS!
      if (accounts.length === 0) {
        const verifiedEmail = await USSBridge.getEmailFromToken(ideTokens.accessToken);
        if (verifiedEmail) {
          log(`[IDE Sync] Bootstrapping initial account from IDE: ${verifiedEmail}`);
          await tokenManager.addOrUpdateAccount({
            email: verifiedEmail,
            accessToken: ideTokens.accessToken,
            refreshToken: ideTokens.refreshToken || "",
            tokenExpiresAt: ideTokens.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
            tier: "pro",
            status: "active",
            sortOrder: 0,
          });
          void quotaMonitor?.pollAllAccounts();
        }
      } else if (!tokenManager.getActiveEmail() && accounts.length > 0) {
        const first = accounts[0];
        if (first) {
          await tokenManager.selectAccount(first.email);
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

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) {
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
        const addedDisplay = tokenManager?.getConfig()?.hideEmail ? maskEmail(res.email) : res.email;
        vscode.window.showInformationMessage(`OpenAG: Account added - ${addedDisplay}`);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`OpenAG: Login failed - ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand("openag.reauthAccount", async (emailArg?: string) => {
      try {
        let targetEmail = emailArg;
        if (!targetEmail) {
          const accounts = tokenManager?.getAccounts() ?? [];
          if (accounts.length === 0) {
            void vscode.window.showWarningMessage("OpenAG: No accounts to re-authenticate.");
            return;
          }
          const items = accounts.map((a) => ({
            label: a.alias ? `${a.alias} (${a.email})` : a.email,
            description: a.role,
            email: a.email,
          }));
          const pick = await vscode.window.showQuickPick(items, {
            placeHolder: "Select account to re-authenticate with Google",
          });
          if (!pick) {
            return;
          }
          targetEmail = pick.email;
        }

        const displayTarget = tokenManager?.getConfig()?.hideEmail ? maskEmail(targetEmail) : targetEmail;
        vscode.window.showInformationMessage(`OpenAG: Opening browser to re-authenticate ${displayTarget}...`);
        const acc = await tokenManager?.reauthAccount(targetEmail);
        if (acc) {
          void quotaMonitor?.refreshAccountQuota(acc.email);
          const displayAcc = tokenManager?.getConfig()?.hideEmail ? maskEmail(acc.email) : acc.email;
          vscode.window.showInformationMessage(`OpenAG: Successfully re-authenticated ${displayAcc}`);
        }
      } catch (e: unknown) {
        vscode.window.showErrorMessage(`OpenAG: Re-auth failed - ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand("openag.refreshQuotas", async () => {
      await quotaMonitor?.pollAllAccounts();
      vscode.window.showInformationMessage("OpenAG: Quotas refreshed");
    }),
    vscode.commands.registerCommand("openag.restartLanguageServer", async () => {
      const ok = await lsClient.restartServer();
      if (ok) {
        vscode.window.showInformationMessage("OpenAG: Language server restarted successfully.");
      } else {
        vscode.window.showWarningMessage("OpenAG: Language server restart command sent or process not detected.");
      }
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
          const switchDisplay = tokenManager.getConfig()?.hideEmail ? maskEmail(selected.email) : selected.email;
          void vscode.window.showInformationMessage(`OpenAG: Switched active account to ${switchDisplay}`);
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
  usageTracker?.dispose();
  statsManager?.dispose();
}
