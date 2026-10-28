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

    it("T2.6: status bar text and tooltip contain zero emoji characters (e.g. no lightning bolt)", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 60, 60, "2026-10-29T10:00:00Z", 90, "2026-11-05T10:00:00Z"),
        createFamilyQuota("argon", 100, 100, undefined, 100, undefined),
      ]);

      statusBar.updateAccount(accA.email, "pro", true, quota);
      (statusBar as any).render();

      const item = (statusBar as any).item;
      const text = item.text || "";
      const tooltip = (item.tooltip as any).value || "";

      // Ensure no lightning bolt, duration, or binding text
      expect(text).not.toContain("⚡");
      expect(tooltip).not.toContain("⚡");
      expect(text).not.toContain("(5h)");
      expect(text).not.toContain("(7d)");
      expect(text).not.toContain("[Binding]");
      expect(tooltip).not.toContain("[Binding]");
      expect(text).toContain("Gemini: 60%");
    });

    it("T2.7: status bar supports minimal active model quota display", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("argon", 75, 75, "2026-10-29T10:00:00Z", 95, "2026-11-05T10:00:00Z"),
      ]);

      statusBar.updateAccount(accA.email, "pro", true, quota);
      statusBar.updateContext({ current: 0, limit: 1000, model: "gemini-4-argon", percent: 0 });
      (statusBar as any).render();

      const item = (statusBar as any).item;
      expect(item.text).toContain("Argon: 75%");
      expect(item.text).not.toContain("(5h)");
      expect(item.text).not.toContain("[Binding]");
    });

    it("T2.8: tooltip renders (Not used) label when quota limit has no active timer running", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 100, 100, undefined, 100, undefined),
      ]);

      statusBar.updateAccount(accA.email, "pro", true, quota);
      (statusBar as any).render();

      const item = (statusBar as any).item;
      const tooltip = (item.tooltip as any).value || "";
      expect(tooltip).toContain("(Not used)");
    });

    it("T2.9: fresh session with empty model context does not render hardcoded Gemini 3.7 Flash", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
      statusBar.updateAccount(accA.email, "pro", true);
      statusBar.updateContext({
        current: 0,
        limit: 1048576,
        model: "",
        percent: 0,
      });
      (statusBar as any).render();

      const item = (statusBar as any).item;
      const tooltip = (item.tooltip as any).value || "";
      expect(tooltip).not.toContain("Gemini 3.7");
      expect(tooltip).not.toContain("Gemini 3.8");
    });
  });
});
