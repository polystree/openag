import { describe, it, expect, afterEach } from "bun:test";
import { StatusBarHUD } from "../../src/ui/status-bar.js";
import {
  createTestAccount,
  createAccountQuota,
  createFamilyQuota,
  setupTestTokenManager,
} from "../helpers/test-utils.js";
import { ThemeColor, setMockConfig } from "../mocks/vscode.js";

describe("F8: StatusBar HUD Craft", () => {
  let statusBar: StatusBarHUD | null = null;
  const accA = createTestAccount({ email: "user-alpha@gmail.com", tier: "pro", alias: "AlphaUser" });

  afterEach(() => {
    if (statusBar) {
      statusBar.dispose();
      statusBar = null;
    }
  });

  describe("Tier 1: Quota Formatting & Visual Indicators", () => {
    it("T1.1: renders tier badge and quota percentages in status bar text", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 85, 85, undefined, 95, undefined),
      ]);

      statusBar.updateAccount(accA.email, "pro", true, quota);
      (statusBar as any).render();

      const item = (statusBar as any).item;
      expect(item.text).toContain("PRO");
      expect(item.text).toContain("85%");
    });

    it("T1.2: sets warning background when effective quota drops below 40%", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 35, 35, undefined, 35, undefined),
      ]);

      statusBar.updateAccount(accA.email, "pro", true, quota);
      (statusBar as any).render();

      const item = (statusBar as any).item;
      expect(item.backgroundColor).toBeInstanceOf(ThemeColor);
      expect((item.backgroundColor as ThemeColor).id).toBe("statusBarItem.warningBackground");
    });

    it("T1.3: sets error background when effective quota drops below 20%", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 12, 12, undefined, 12, undefined),
      ]);

      statusBar.updateAccount(accA.email, "pro", true, quota);
      (statusBar as any).render();

      const item = (statusBar as any).item;
      expect(item.backgroundColor).toBeInstanceOf(ThemeColor);
      expect((item.backgroundColor as ThemeColor).id).toBe("statusBarItem.errorBackground");
    });

    it("T1.4: displays OpenAG (Off) when extension is disabled", async () => {
      const { tokenManager, context } = await setupTestTokenManager();

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      statusBar.updateAccount(accA.email, "pro", false, null);
      (statusBar as any).render();

      const item = (statusBar as any).item;
      expect(item.text).toContain("OpenAG (Off)");
      expect(item.backgroundColor).toBeUndefined();
    });

    it("T1.5: displays OpenAG: No Account when pool has no active email", async () => {
      const { tokenManager, context } = await setupTestTokenManager();

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      statusBar.updateAccount("", "unknown", true, null);
      (statusBar as any).render();

      const item = (statusBar as any).item;
      expect(item.text).toContain("OpenAG: No Account");
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: respects hideEmail setting by rendering alias or generic account label", async () => {
      setMockConfig("openag.hideEmail", true);
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
        config: { hideEmail: true },
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      statusBar.updateAccount(accA.email, "pro", true);
      (statusBar as any).render();

      const item = (statusBar as any).item;
      const tooltip = (item.tooltip as any).value || "";
      expect(tooltip).not.toContain("user-alpha@gmail.com");
      expect(tooltip).toContain("AlphaUser");
    });

    it("T2.2: flashRotating temporarily displays sync~spin icon", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      statusBar.updateAccount(accA.email, "pro", true);
      statusBar.flashRotating();
      (statusBar as any).render();

      const item = (statusBar as any).item;
      expect(item.text).toContain("sync~spin");
    });

    it("T2.3: context usage adds formatted token count to status bar text", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      statusBar.updateAccount(accA.email, "pro", true);
      statusBar.updateContext({
        current: 500000,
        limit: 1000000,
        model: "gemini-1.5-pro",
        percent: 50,
      });
      (statusBar as any).render();

      const item = (statusBar as any).item;
      expect(item.text).toContain("500k/1M");
    });

    it("T2.4: tooltip markdown includes dual-window breakdown (5h and 7d)", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 60, 60, "2026-10-29T10:00:00Z", 90, "2026-11-05T10:00:00Z"),
      ]);

      statusBar.updateAccount(accA.email, "pro", true, quota);
      (statusBar as any).render();

      const item = (statusBar as any).item;
      const tooltip = (item.tooltip as any).value || "";
      expect(tooltip).toContain("(5h)");
      expect(tooltip).toContain("(7d)");
    });

    it("T2.5: dispose cleans up timers and disposes underlying VS Code status bar item", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      statusBar.flashRotating();

      expect(() => {
        statusBar?.dispose();
      }).not.toThrow();
    });
  });
});
