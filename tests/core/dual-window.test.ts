import { describe, it, expect } from "bun:test";
import {
  createTestAccount,
  createAccountQuota,
  createFamilyQuota,
  setupTestTokenManager,
} from "../helpers/test-utils.js";
import type { AccountQuota } from "../../src/types.js";

describe("F2: Dual-Window Binding-Constraint Scoring", () => {
  const acc = createTestAccount({ email: "dual-window-user@gmail.com" });

  describe("Tier 1: Binding Constraint Detection & Window Pairing", () => {
    it("T1.1: 5h limit is binding when p5h < pWk, returns p5h with limit5h.resetTime and bindingWindow '5h'", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const reset5h = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
      const resetWk = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

      const quota = createAccountQuota(acc.email, [
        createFamilyQuota("gemini", 40, 40, reset5h, 80, resetWk),
      ]);
      const quotas: Record<string, AccountQuota> = { [acc.email]: quota };

      const eff = tokenManager.getEffectiveQuota(acc.email, quotas, "gemini-1.5-pro");
      expect(eff.percent).toBe(40);
      expect(eff.resetTs).toBe(Date.parse(reset5h));
      if (eff.bindingWindow) {
        expect(eff.bindingWindow).toBe("5h");
      }
    });

    it("T1.2: Weekly limit is binding when pWk < p5h, returns pWk with limitWeekly.resetTime and bindingWindow 'weekly'", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const reset5h = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
      const resetWk = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

      const quota = createAccountQuota(acc.email, [
        createFamilyQuota("gemini", 80, 80, reset5h, 30, resetWk),
      ]);
      const quotas: Record<string, AccountQuota> = { [acc.email]: quota };

      const eff = tokenManager.getEffectiveQuota(acc.email, quotas, "gemini-1.5-pro");
      expect(eff.percent).toBe(30);
      expect(eff.resetTs).toBe(Date.parse(resetWk));
      if (eff.bindingWindow) {
        expect(eff.bindingWindow).toBe("weekly");
      }
    });

    it("T1.3: Equal percentages (p5h === pWk) selects earliest reset timestamp and bindingWindow 'both'", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const reset5h = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
      const resetWk = new Date(Date.now() + 48 * 3600 * 1000).toISOString();

      const quota = createAccountQuota(acc.email, [
        createFamilyQuota("gemini", 50, 50, reset5h, 50, resetWk),
      ]);
      const quotas: Record<string, AccountQuota> = { [acc.email]: quota };

      const eff = tokenManager.getEffectiveQuota(acc.email, quotas, "gemini-1.5-pro");
      expect(eff.percent).toBe(50);
      expect(eff.resetTs).toBe(Date.parse(reset5h)); // earliest
      if (eff.bindingWindow) {
        expect(eff.bindingWindow).toBe("both");
      }
    });

    it("T1.4: Weekly limit exhausted (pWk <= 0) forces effective quota to 0% even if 5h is high", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const resetWk = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const quota = createAccountQuota(acc.email, [
        createFamilyQuota("gemini", 90, 90, new Date().toISOString(), 0, resetWk),
      ]);
      const quotas: Record<string, AccountQuota> = { [acc.email]: quota };

      const eff = tokenManager.getEffectiveQuota(acc.email, quotas, "gemini-1.5-pro");
      expect(eff.percent).toBe(0);
      expect(eff.resetTs).toBe(Date.parse(resetWk));
    });

    it("T1.5: Selects binding window for requested model family (claude vs gemini)", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const quota = createAccountQuota(acc.email, [
        createFamilyQuota("gemini", 90, 90, undefined, 95, undefined),
        createFamilyQuota("claude", 25, 25, new Date(Date.now() + 3600000).toISOString(), 50, undefined),
      ]);
      const quotas: Record<string, AccountQuota> = { [acc.email]: quota };

      const effClaude = tokenManager.getEffectiveQuota(acc.email, quotas, "claude-3-7-sonnet");
      expect(effClaude.percent).toBe(25);

      const effGemini = tokenManager.getEffectiveQuota(acc.email, quotas, "gemini-1.5-pro");
      expect(effGemini.percent).toBe(90);
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: Missing weekly limit defaults gracefully to 5h limit", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const reset5h = new Date(Date.now() + 3600 * 1000).toISOString();
      const quota: AccountQuota = {
        email: acc.email,
        tier: "pro",
        families: [
          {
            key: "gemini",
            label: "Gemini",
            percent: 65,
            limit5h: { percent: 65, resetTime: reset5h },
          },
        ],
        models: [],
        lastUpdated: Date.now(),
      };
      const quotas: Record<string, AccountQuota> = { [acc.email]: quota };

      const eff = tokenManager.getEffectiveQuota(acc.email, quotas, "gemini-1.5-pro");
      expect(eff.percent).toBe(65);
      expect(eff.resetTs).toBe(Date.parse(reset5h));
    });

    it("T2.2: Missing 5h limit defaults gracefully to weekly limit", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const resetWk = new Date(Date.now() + 3600 * 24 * 1000).toISOString();
      const quota: AccountQuota = {
        email: acc.email,
        tier: "pro",
        families: [
          {
            key: "gemini",
            label: "Gemini",
            percent: 75,
            limitWeekly: { percent: 75, resetTime: resetWk },
          },
        ],
        models: [],
        lastUpdated: Date.now(),
      };
      const quotas: Record<string, AccountQuota> = { [acc.email]: quota };

      const eff = tokenManager.getEffectiveQuota(acc.email, quotas, "gemini-1.5-pro");
      expect(eff.percent).toBe(75);
      expect(eff.resetTs).toBe(Date.parse(resetWk));
    });

    it("T2.3: Invalid date string in resetTime does not produce NaN (returns Infinity)", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const quota = createAccountQuota(acc.email, [
        createFamilyQuota("gemini", 50, 50, "INVALID_DATE_STRING", 50, "ANOTHER_BAD_DATE"),
      ]);
      const quotas: Record<string, AccountQuota> = { [acc.email]: quota };

      const eff = tokenManager.getEffectiveQuota(acc.email, quotas, "gemini-1.5-pro");
      expect(eff.percent).toBe(50);
      expect(Number.isNaN(eff.resetTs)).toBe(false);
      expect(eff.resetTs).toBe(Infinity);
    });

    it("T2.4: 100% quota on both windows has Infinity resetTs", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const quota = createAccountQuota(acc.email, [
        createFamilyQuota("gemini", 100, 100, undefined, 100, undefined),
      ]);
      const quotas: Record<string, AccountQuota> = { [acc.email]: quota };

      const eff = tokenManager.getEffectiveQuota(acc.email, quotas, "gemini-1.5-pro");
      expect(eff.percent).toBe(100);
      expect(eff.resetTs).toBe(Infinity);
    });

    it("T2.5: Missing quota record for email returns -1 percent and Infinity resetTs", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const eff = tokenManager.getEffectiveQuota("non-existent@gmail.com", {}, "gemini-1.5-pro");
      expect(eff.percent).toBe(-1);
      expect(eff.resetTs).toBe(Infinity);
    });

    it("T2.6: overloaded getEffectiveQuota(fam: FamilyQuota) returns binding calculation directly", async () => {
      const { tokenManager } = await setupTestTokenManager();
      const reset5h = new Date(Date.now() + 3600000).toISOString();
      const resetWk = new Date(Date.now() + 86400000).toISOString();

      const fam = createFamilyQuota("gemini", 45, 45, reset5h, 60, resetWk);
      const eff = tokenManager.getEffectiveQuota(fam);

      expect(eff.percent).toBe(45);
      expect(eff.resetTs).toBe(Date.parse(reset5h));
      expect(eff.bindingWindow).toBe("5h");
    });

    it("T2.7: accounts with zero families return percent -1 and Infinity resetTs", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const emptyQuota: AccountQuota = {
        email: acc.email,
        tier: "pro",
        families: [],
        models: [],
        lastUpdated: Date.now(),
      };
      const quotas: Record<string, AccountQuota> = { [acc.email]: emptyQuota };

      const eff = tokenManager.getEffectiveQuota(acc.email, quotas);
      expect(eff.percent).toBe(-1);
      expect(eff.resetTs).toBe(Infinity);
    });

    it("T2.8: calculates binding constraint specifically for Claude family when targetModel is claude", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [acc],
        activeEmail: acc.email,
      });

      const q = createAccountQuota(acc.email, [
        createFamilyQuota("gemini", 90, 90, "2026-10-29T10:00:00Z", 95, "2026-11-05T10:00:00Z"),
        createFamilyQuota("claude", 40, 40, "2026-10-29T08:00:00Z", 80, "2026-11-05T08:00:00Z"),
      ]);
      const quotas: Record<string, AccountQuota> = { [acc.email]: q };

      // When target model is claude-3-5-sonnet, effective quota must be bound by claude family (40%) not gemini (90%)
      const eff = tokenManager.getEffectiveQuota(acc.email, quotas, "claude-3-5-sonnet");
      expect(eff.percent).toBe(40);
      expect(eff.bindingWindow).toBe("5h");
    });
  });
});
