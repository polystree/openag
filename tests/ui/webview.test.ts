import { describe, it, expect } from "bun:test";
import { WebviewProvider } from "../../src/ui/webview-provider.js";
import { LogManager } from "../../src/core/log-manager.js";
import {
  createTestAccount,
  setupTestTokenManager,
  setupTestQuotaMonitor,
} from "../helpers/test-utils.js";
import { MockWebviewView, mockVscode } from "../mocks/vscode.js";

describe("F8: Webview Provider & Reactive Accounts Table", () => {
  const accA = createTestAccount({ email: "user-a@gmail.com", tier: "pro", alias: "AccountA" });
  const accB = createTestAccount({ email: "user-b@gmail.com", tier: "ultra", alias: "AccountB" });

  describe("Tier 1: Webview Resolution & Reactive State Dispatch", () => {
    it("T1.1: resolveWebviewView sets HTML and dispatches initial state payload", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      expect(mockView.webview.html.length).toBeGreaterThan(0);
      expect(mockView.webview.html).toContain("<!DOCTYPE html>");
      expect(mockView.webview.postedMessages.length).toBeGreaterThan(0);

      const initialMessage = mockView.webview.postedMessages[0];
      expect(initialMessage.type).toBe("state");
      expect(initialMessage.data.activeEmail).toBe(accA.email);
      expect(initialMessage.data.accounts.length).toBe(2);
    });

    it("T1.2: handles 'ready' message from webview by dispatching fresh state", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      const initialCount = mockView.webview.postedMessages.length;
      mockView.webview.simulateMessage({ action: "ready" });

      expect(mockView.webview.postedMessages.length).toBeGreaterThan(initialCount);
    });

    it("T1.3: handles 'addAccount' action by executing openag.addAccount command", async () => {
      const { tokenManager, context } = await setupTestTokenManager();
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      let commandExecuted = false;
      mockVscode.commands.registerCommand("openag.addAccount", () => {
        commandExecuted = true;
      });

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      mockView.webview.simulateMessage({ action: "addAccount" });

      // Allow microtask to complete
      await new Promise((r) => setTimeout(r, 20));
      expect(commandExecuted).toBe(true);
    });

    it("T1.4: handles 'toggleAccount' action to enable/disable account status", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      mockView.webview.simulateMessage({
        action: "toggleAccount",
        payload: { email: accA.email, enabled: false },
      });

      await new Promise((r) => setTimeout(r, 20));
      const acc = tokenManager.getAccounts().find((a) => a.email === accA.email);
      expect(acc?.status).toBe("disabled");
    });

    it("T1.5: handles 'updateAccountMeta' to update alias, affinity, and pool role", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      mockView.webview.simulateMessage({
        action: "updateAccountMeta",
        payload: {
          email: accA.email,
          alias: "NewRenamedAlias",
          affinity: "gemini",
          role: "reserve",
        },
      });

      await new Promise((r) => setTimeout(r, 20));
      const updated = tokenManager.getAccounts().find((a) => a.email === accA.email);
      expect(updated?.alias).toBe("NewRenamedAlias");
      expect(updated?.affinity).toBe("gemini");
      expect(updated?.role).toBe("reserve");
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: defers postState update when webview is hidden, dispatches on visibility restore", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      // Hide webview
      mockView.visible = false;
      const countBefore = mockView.webview.postedMessages.length;

      // Trigger postState while hidden
      (provider as any).postState();
      expect(mockView.webview.postedMessages.length).toBe(countBefore);
      expect((provider as any).isDirty).toBe(true);

      // Restore visibility
      mockView.visible = true;
      mockView.visibilityEmitter.fire();

      expect(mockView.webview.postedMessages.length).toBeGreaterThan(countBefore);
      expect((provider as any).isDirty).toBe(false);
    });

    it("T2.2: HTML includes strict Content-Security-Policy (CSP) metadata", async () => {
      const { tokenManager, context } = await setupTestTokenManager();
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const html = (provider as any).getHtmlForWebview();
      expect(html).toContain("Content-Security-Policy");
      expect(html).toContain("default-src 'none'");
    });

    it("T2.3: message listener handles unknown actions gracefully without throwing", async () => {
      const { tokenManager, context } = await setupTestTokenManager();
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      expect(() => {
        mockView.webview.simulateMessage({ action: "NON_EXISTENT_ACTION" as any });
      }).not.toThrow();
    });

    it("T2.4: clearLogs message clears LogManager entries", async () => {
      const { tokenManager, context } = await setupTestTokenManager();
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      logManager.addLog("info", "SYSTEM", "Test log entry");
      expect(logManager.getLogs().length).toBe(1);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      mockView.webview.simulateMessage({ action: "clearLogs" });
      await new Promise((r) => setTimeout(r, 20));

      expect(logManager.getLogs().length).toBe(0);
    });

    it("T2.5: rapid consecutive refresh calls debounce postState to single dispatch", async () => {
      const { tokenManager, context } = await setupTestTokenManager();
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      const beforeCount = mockView.webview.postedMessages.length;

      // Trigger 5 rapid refresh calls
      provider.refresh();
      provider.refresh();
      provider.refresh();
      provider.refresh();
      provider.refresh();

      // Immediately should still have 0 additional messages because of 150ms debounce
      expect(mockView.webview.postedMessages.length).toBe(beforeCount);

      // Wait 180ms for debounce timer to fire
      await new Promise((r) => setTimeout(r, 180));
      expect(mockView.webview.postedMessages.length).toBe(beforeCount + 1);
    });

    it("T2.6: HTML includes 'Not used' styling and supports Gemini 4 Argon quota family", async () => {
      const { tokenManager, context } = await setupTestTokenManager();
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const logManager = new LogManager(context as any);

      const provider = new WebviewProvider(
        context as any,
        tokenManager,
        quotaMonitor,
        () => {},
        logManager,
      );

      const mockView = new MockWebviewView();
      provider.resolveWebviewView(mockView as any);

      const html = mockView.webview.html;
      expect(html).toContain(".reset-tag.not-used");
      expect(html).toContain("Not used yet");
      expect(html).toContain("card-menu-wrap");
      expect(html).toContain("card-dropdown");
      expect(html).toContain('data-action="toggleMenu"');
      expect(html).toContain('id="btn-refresh-quotas"');
      expect(html).toContain("Auto-Highest");
      expect(html).toContain("Pool Role: PRIMARY");
      expect(html).toContain("Pool Role: RESERVE");
      expect(html).toContain("argon");
      expect(html).toContain("Gemini 4 Argon");
    });
  });
});
