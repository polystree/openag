import * as vscode from "vscode";
import { LogManager } from "./core/log-manager.js";
import { OAuthFlow } from "./core/oauth-flow.js";
import { AutoRunPatcher } from "./core/patcher.js";
import { QuotaMonitor } from "./core/quota-monitor.js";
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

const log = (msg: string): void => {
  outputChannel?.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${msg}`);
  const cat = msg.includes("AutoRotate") || msg.includes("ROTATION") ? "ROTATION"
    : msg.includes("Quota") || msg.includes("QUOTA") ? "QUOTA"
    : msg.includes("IDE Sync") || msg.includes("USS") ? "USS"
    : msg.includes("AUTH") || msg.includes("Authorized") || msg.includes("Login") || msg.includes("token") ? "AUTH"
    : "SYSTEM";
  const lvl = msg.toLowerCase().includes("error") || msg.toLowerCase().includes("fail") ? "error" : msg.includes("AutoRotate") ? "rotate" : "info";
  logManager?.addLog(lvl, cat, msg);
};

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  outputChannel = vscode.window.createOutputChannel("OpenAG");
  logManager = new LogManager();
  usageTracker = new UsageTracker();
  context.subscriptions.push(logManager, usageTracker);

  log("Activating OpenAG...");

  tokenManager = new TokenManager(context, log);
  await tokenManager.initialize();

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
  );
  quotaMonitor.initialize();

  statusBar = new StatusBarHUD(context);
  const activeAcc = tokenManager.getActiveAccount();
  const initQuota = activeAcc ? quotaMonitor.getQuota(activeAcc.email) : null;
  statusBar.updateAccount(tokenManager.getActiveEmail(), activeAcc?.tier || "unknown", tokenManager.isExtensionEnabled(), initQuota);

  usageTracker.onContextChange((ctx) => statusBar?.updateContext(ctx));
  logManager.onLog(() => webviewProvider?.refresh());

  webviewProvider = new WebviewProvider(context, tokenManager, quotaMonitor, log, logManager);
  context.subscriptions.push(
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

  void syncIdeAuth();
  const syncTimer = setInterval(() => void syncIdeAuth(), 10000);
  let docChangeDebounce: NodeJS.Timeout | null = null;
  const updateEditorContext = () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const textLen = doc.getText().length;
    if (textLen === 0) return;
    const approxTokens = Math.max(1, Math.round(textLen / 4));
    usageTracker?.updateContextUsage(undefined, approxTokens);
  };

  updateEditorContext();

  context.subscriptions.push(
    { dispose: () => { clearInterval(syncTimer); if (docChangeDebounce) clearTimeout(docChangeDebounce); } },
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) void syncIdeAuth(); }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      void syncIdeAuth();
      updateEditorContext();
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (vscode.window.activeTextEditor?.document === e.document) updateEditorContext();
      if (docChangeDebounce) return;
      docChangeDebounce = setTimeout(() => { docChangeDebounce = null; void syncIdeAuth(); }, 3000);
    }),
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
    vscode.commands.registerCommand("openag.switchAccount", async () => {
      const accounts = tokenManager?.getAccounts() ?? [];
      if (!accounts.length) {
        void vscode.window.showInformationMessage("No accounts in OpenAG. Click Add Account first.");
        return;
      }
      const quotas = quotaMonitor?.getAllQuotas() ?? {};
      const activeEmail = tokenManager?.getActiveEmail() ?? "";
      const items = accounts.map((a) => {
        const q = quotas[a.email.toLowerCase()];
        const geminiPct = q?.families?.find((f) => f.key === "gemini")?.percent ?? 100;
        const claudePct = q?.families?.find((f) => f.key === "claude")?.percent ?? 100;
        return {
          label: `${a.email.toLowerCase() === activeEmail.toLowerCase() ? "✓ " : ""}${a.email}`,
          description: `[${a.tier.toUpperCase()}] Gemini: ${geminiPct}% | Claude: ${claudePct}%`,
          accountEmail: a.email,
        };
      });
      const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select active Google account for Antigravity" });
      if (picked) {
        await tokenManager?.selectAccount(picked.accountEmail);
        void quotaMonitor?.pollActiveAccount();
      }
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
