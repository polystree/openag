import { describe, it, expect } from "bun:test";
import {
  createTestAccount,
  createAccountQuota,
  createFamilyQuota,
  setupTestTokenManager,
  setupTestQuotaMonitor,
} from "../helpers/test-utils.js";

describe("F4: Cooldown Auto-Rehabilitation", () => {
  const accA = createTestAccount({ email: "exhausted@gmail.com", tier: "pro" });
  const accB = createTestAccount({ email: "healthy@gmail.com", tier: "pro" });

  describe("Tier 1: Exhaustion Recording & Priority Polling", () => {
    it("T1.1: markAccountExhausted sets quota percent to 0 and records cooldownExpiresAt", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 50, 50, undefined, 50, undefined),
      ]);
      (quotaMonitor as any).quotas.set(accA.email, quota);

      quotaMonitor.markAccountExhausted(accA.email, "gemini-1.5-pro", 30000);

      const updated = quotaMonitor.getQuota(accA.email);
      expect(updated).toBeDefined();
      expect(updated?.cooldownExpiresAt).toBeGreaterThan(Date.now());
      expect(updated?.families[0]?.percent).toBe(0);
    });

    it("T1.2: schedules priority cooldown timer when account is marked exhausted", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const quota = createAccountQuota(accA.email, [createFamilyQuota("gemini", 40)]);
      (quotaMonitor as any).quotas.set(accA.email, quota);

      quotaMonitor.markAccountExhausted(accA.email, "gemini-1.5-pro", 5000);

      const timers = (quotaMonitor as any).cooldownTimers;
      expect(timers.has(accA.email.toLowerCase())).toBe(true);
    });

    it("T1.3: onCooldownExpired priority polls account and rehabilitates when quota refills (> 10%)", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const { quotaMonitor, logs } = setupTestQuotaMonitor(tokenManager, context);
      const quota = createAccountQuota(accA.email, [createFamilyQuota("gemini", 0)]);
      quota.cooldownExpiresAt = Date.now() - 1000;
      (quotaMonitor as any).quotas.set(accA.email, quota);

      // Mock fetchAccountQuota to simulate refilled quota (80%)
      (quotaMonitor as any).fetchAccountQuota = async (account: any) => {
        const refilled = createAccountQuota(account.email, [createFamilyQuota("gemini", 80)]);
        (quotaMonitor as any).quotas.set(account.email.toLowerCase(), refilled);
        return refilled;
      };

      await quotaMonitor.onCooldownExpired(accA.email);

      const rehabilitated = quotaMonitor.getQuota(accA.email);
      expect(rehabilitated?.cooldownExpiresAt).toBeUndefined();
      expect(rehabilitated?.families[0]?.percent).toBe(80);
      expect(logs.some((l) => l.includes("successfully rehabilitated"))).toBe(true);
    });

    it("T1.4: onCooldownExpired reschedules cooldown if quota is still exhausted (<= 10%)", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const quota = createAccountQuota(accA.email, [createFamilyQuota("gemini", 0)]);
      quota.cooldownExpiresAt = Date.now() - 1000;
      (quotaMonitor as any).quotas.set(accA.email, quota);

      // Mock fetchAccountQuota to simulate still exhausted (5%)
      (quotaMonitor as any).fetchAccountQuota = async (account: any) => {
        const stillExhausted = createAccountQuota(account.email, [createFamilyQuota("gemini", 5)]);
        (quotaMonitor as any).quotas.set(account.email.toLowerCase(), stillExhausted);
        return stillExhausted;
      };

      await quotaMonitor.onCooldownExpired(accA.email);

      const current = quotaMonitor.getQuota(accA.email);
      expect(current?.cooldownExpiresAt).toBeGreaterThan(Date.now());
      const timers = (quotaMonitor as any).cooldownTimers;
      expect(timers.has(accA.email.toLowerCase())).toBe(true);
    });

    it("T1.5: custom cooldownMs parameter is accurately respected", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const quota = createAccountQuota(accA.email, [createFamilyQuota("gemini", 20)]);
      (quotaMonitor as any).quotas.set(accA.email, quota);

      const before = Date.now();
      const customCooldown = 45000; // 45 seconds
      quotaMonitor.markAccountExhausted(accA.email, undefined, customCooldown);

      const updated = quotaMonitor.getQuota(accA.email);
      expect(updated?.cooldownExpiresAt).toBeGreaterThanOrEqual(before + customCooldown);
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: multiple accounts maintain independent cooldown timers", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      (quotaMonitor as any).quotas.set(accA.email, createAccountQuota(accA.email, [createFamilyQuota("gemini", 10)]));
      (quotaMonitor as any).quotas.set(accB.email, createAccountQuota(accB.email, [createFamilyQuota("gemini", 10)]));

      quotaMonitor.markAccountExhausted(accA.email, "gemini-1.5-pro", 10000);
      quotaMonitor.markAccountExhausted(accB.email, "gemini-1.5-pro", 20000);

      const timers = (quotaMonitor as any).cooldownTimers;
      expect(timers.has(accA.email.toLowerCase())).toBe(true);
      expect(timers.has(accB.email.toLowerCase())).toBe(true);
    });

    it("T2.2: marking non-existent account exhausted does not throw", async () => {
      const { tokenManager, context } = await setupTestTokenManager();
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      expect(() => {
        quotaMonitor.markAccountExhausted("unknown-user@gmail.com");
      }).not.toThrow();
    });

    it("T2.3: markAccountExhausted without cooldownMs defaults to DEFAULT_COOLDOWN_MS or resetTime", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const quota = createAccountQuota(accA.email, [createFamilyQuota("gemini", 30)]);
      (quotaMonitor as any).quotas.set(accA.email, quota);

      const before = Date.now();
      quotaMonitor.markAccountExhausted(accA.email);

      const updated = quotaMonitor.getQuota(accA.email);
      expect(updated?.cooldownExpiresAt).toBeGreaterThanOrEqual(before + 60000);
    });

    it("T2.4: cleanupExpiredQuotas purges quotas older than 5 hours while preserving recent ones", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const staleQuota = createAccountQuota(accA.email, [createFamilyQuota("gemini", 0)]);
      staleQuota.lastUpdated = Date.now() - 6 * 3600 * 1000; // 6 hours old

      const freshQuota = createAccountQuota(accB.email, [createFamilyQuota("gemini", 50)]);
      freshQuota.lastUpdated = Date.now() - 1000; // 1 sec old

      (quotaMonitor as any).quotas.set(accA.email, staleQuota);
      (quotaMonitor as any).quotas.set(accB.email, freshQuota);

      quotaMonitor.cleanupExpiredQuotas();

      expect(quotaMonitor.getQuota(accA.email)).toBeUndefined();
      expect(quotaMonitor.getQuota(accB.email)).toBeDefined();
    });

    it("T2.5: dispose clears all active cooldown timers without memory leaks", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      (quotaMonitor as any).quotas.set(accA.email, createAccountQuota(accA.email, [createFamilyQuota("gemini", 0)]));
      quotaMonitor.markAccountExhausted(accA.email, undefined, 10000);

      const timers = (quotaMonitor as any).cooldownTimers;
      expect(timers.size).toBeGreaterThan(0);

      quotaMonitor.dispose();
      expect(timers.size).toBe(0);
    });

    it("T2.6: markAccountExhausted zeroes both family and model bucket percentages", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
      const quota = createAccountQuota(accA.email, [createFamilyQuota("gemini", 60)]);
      quota.models = [{ name: "gemini-1.5-pro", family: "gemini", percent: 60 }];
      (quotaMonitor as any).quotas.set(accA.email, quota);

      quotaMonitor.markAccountExhausted(accA.email, "gemini-1.5-pro");

      const current = quotaMonitor.getQuota(accA.email);
      expect(current?.families[0]?.percent).toBe(0);
      expect(current?.models[0]?.percent).toBe(0);
    });

    it("T2.7: onCooldownExpired priority queue recovers gracefully when network throws", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const { quotaMonitor, logs } = setupTestQuotaMonitor(tokenManager, context);
      const quota = createAccountQuota(accA.email, [createFamilyQuota("gemini", 0)]);
      (quotaMonitor as any).quotas.set(accA.email, quota);

      (quotaMonitor as any).fetchAccountQuota = async () => {
        throw new Error("Network timeout on quota endpoint");
      };

      await expect(quotaMonitor.onCooldownExpired(accA.email)).resolves.toBeUndefined();
      expect(logs.some((l) => l.includes("Priority poll failed"))).toBe(true);
    });
  });
});
