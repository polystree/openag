import { describe, it, expect } from "bun:test";
import {
  createTestAccount,
  createAccountQuota,
  createFamilyQuota,
  setupTestTokenManager,
} from "../helpers/test-utils.js";
import type { AccountQuota } from "../../src/types.js";

describe("F1: Anti-Flapping Hysteresis", () => {
  const accA = createTestAccount({ email: "active@gmail.com", tier: "pro" });
  const accB = createTestAccount({ email: "candidate@gmail.com", tier: "pro" });

  describe("Tier 1: Core Hysteresis Logic", () => {
    it("T1.1: retains active account when candidate quota advantage is within hysteresis delta (<= 15%)", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active has 70%, candidate has 80% (delta = 10% <= 15%)
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 70)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 80)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      // Hysteresis prevents flapping: should not rotate
      expect(selected).toBeNull();
      expect(tokenManager.getActiveEmail()).toBe(accA.email);
    });

    it("T1.2: switches to candidate when quota advantage strictly exceeds hysteresis delta (> 15%)", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active has 60%, candidate has 85% (delta = 25% > 15%)
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 60)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 85)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
      expect(tokenManager.getActiveEmail()).toBe(accB.email);
    });

    it("T1.3: bypasses hysteresis and switches immediately when active account is exhausted (<= 10%)", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active has 8% (exhausted <= 10%), candidate has 15% (delta = 7% <= 15%)
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 8)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 15)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
    });

    it("T1.4: bypasses hysteresis on explicit rate limit failover", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active has 50%, candidate has 55% (delta = 5% <= 15%)
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 50)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 55)]),
      };

      // Reason: rate_limit_failover
      const selected = await tokenManager.autoSelectHighestQuota(quotas, "rate_limit_failover", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
    });

    it("T1.5: switches when candidate matches model affinity but active account does not", async () => {
      const claudeOnlyAcc = createTestAccount({
        email: "claude@gmail.com",
        affinity: "claude",
        tier: "pro",
      });
      const geminiAcc = createTestAccount({
        email: "gemini@gmail.com",
        affinity: "gemini",
        tier: "pro",
      });

      const { tokenManager } = await setupTestTokenManager({
        accounts: [claudeOnlyAcc, geminiAcc],
        activeEmail: claudeOnlyAcc.email,
      });

      // Both have 80% quota, but active affinity is claude while target model is gemini
      const quotas: Record<string, AccountQuota> = {
        [claudeOnlyAcc.email]: createAccountQuota(claudeOnlyAcc.email, [createFamilyQuota("gemini", 80)]),
        [geminiAcc.email]: createAccountQuota(geminiAcc.email, [createFamilyQuota("gemini", 80)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-flash");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(geminiAcc.email);
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: boundary threshold: exactly 15% delta retains active; 15.1% switches", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active has 70%, candidate has 85% (exact delta = 15%)
      const quotasExact: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 70)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 85)]),
      };

      const selectedExact = await tokenManager.autoSelectHighestQuota(quotasExact, "auto", "gemini-1.5-pro");
      expect(selectedExact).toBeNull();

      // Active has 70%, candidate has 85.1% (delta = 15.1% > 15%)
      const quotasOver: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 70)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 85.1)]),
      };

      const selectedOver = await tokenManager.autoSelectHighestQuota(quotasOver, "auto", "gemini-1.5-pro");
      expect(selectedOver).not.toBeNull();
      expect(selectedOver?.email).toBe(accB.email);
    });

    it("T2.2: active account at 0% switches to candidate with any positive quota", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 0)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 1)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
    });

    it("T2.3: candidate at 100% vs active at 86% (delta 14% -> retains) vs active at 84% (delta 16% -> switches)", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Candidate 100% vs Active 86% -> delta 14% -> retain
      const quotas14: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 86)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 100)]),
      };
      const res14 = await tokenManager.autoSelectHighestQuota(quotas14, "auto", "gemini-1.5-pro");
      expect(res14).toBeNull();

      // Candidate 100% vs Active 84% -> delta 16% -> switch
      const quotas16: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 84)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 100)]),
      };
      const res16 = await tokenManager.autoSelectHighestQuota(quotas16, "auto", "gemini-1.5-pro");
      expect(res16).not.toBeNull();
      expect(res16?.email).toBe(accB.email);
    });

    it("T2.4: equal quotas (50% vs 50%) retains active account", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 50)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 50)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).toBeNull();
      expect(tokenManager.getActiveEmail()).toBe(accA.email);
    });

    it("T2.5: single account pool returns null without error", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 100)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).toBeNull();
    });

    it("T2.6: forceSwitch option forces rotation to candidate even within hysteresis delta", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active 70%, candidate 75% (delta 5% <= 15%)
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 70)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 75)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "manual_switch", "gemini-1.5-pro", {
        forceSwitch: true,
      });
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
    });

    it("T2.7: custom hysteresisDelta in options overrides default 15% threshold", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active 70%, candidate 78% (delta 8%)
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 70)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 78)]),
      };

      // With custom hysteresisDelta = 5%: delta 8% > 5% -> switches!
      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro", {
        hysteresisDelta: 5,
      });
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
    });
  });
});
