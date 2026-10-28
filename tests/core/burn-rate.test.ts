import { describe, it, expect } from "bun:test";
import {
  createTestAccount,
  createAccountQuota,
  createFamilyQuota,
  setupTestTokenManager,
  setupTestQuotaMonitor,
} from "../helpers/test-utils.js";
import { StatsManager } from "../../src/core/stats-manager.js";
import type { AccountQuota, RequestStats } from "../../src/types.js";

describe("F3: Burn-Rate Predictive Refill Coordination", () => {
  const accA = createTestAccount({ email: "active@gmail.com", tier: "pro" });
  const accB = createTestAccount({ email: "candidate@gmail.com", tier: "pro" });

  describe("Tier 1: Core Burn-Rate & Predictive Refill", () => {
    it("T1.1: StatsManager calculates burn rate (tokensPerMin) from recent request stats", async () => {
      const { context } = await setupTestTokenManager();
      const statsManager = new StatsManager(context as any, () => {});

      const now = Date.now();
      const mockRequests: RequestStats[] = [
        {
          id: "req-1",
          timestamp: now - 60000, // 1 min ago
          model: "gemini-1.5-pro",
          promptPreview: "hello",
          turnCount: 1,
          inputTokens: 500,
          outputTokens: 500,
          cacheHitTokens: 0,
          totalTokens: 1000,
        },
        {
          id: "req-2",
          timestamp: now - 30000, // 30 sec ago
          model: "gemini-1.5-pro",
          promptPreview: "world",
          turnCount: 1,
          inputTokens: 1000,
          outputTokens: 1000,
          cacheHitTokens: 0,
          totalTokens: 2000,
        },
      ];

      (statsManager as any).registry.requests = mockRequests;

      const burn = statsManager.getBurnRate(15);
      expect(burn.tokensPerMin).toBeGreaterThan(0);
      expect(burn.recentTurns).toBe(2);
    });

    it("T1.2: retains active account when token headroom outlasts time-to-refill (timeToExhaustion >= timeToRefill)", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const statsManager = new StatsManager(context as any);
      (tokenManager as any).statsManager = statsManager;

      // Active has 40% quota, resets in 10 minutes (refill is fast)
      // 40% of 1,000,000 = 400,000 tokens remaining
      const resetTime = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [
          createFamilyQuota("gemini", 40, 40, resetTime, 40, resetTime),
        ]),
        // Candidate has 90% quota (would normally trigger switch)
        [accB.email]: createAccountQuota(accB.email, [
          createFamilyQuota("gemini", 90, 90, undefined, 90, undefined),
        ]),
      };

      // Burn rate = 1,000 tokens/min -> 400,000 / 1,000 = 400 minutes of headroom (>> 10 min refill)
      (statsManager as any).getBurnRate = () => ({ tokensPerMin: 1000, recentTurns: 5 });

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      // Predictive refill allows active account to drain down to refill without switching
      expect(selected).toBeNull();
      expect(tokenManager.getActiveEmail()).toBe(accA.email);
    });

    it("T1.3: switches when burn rate exhausts headroom before refill (timeToExhaustion < timeToRefill)", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const statsManager = new StatsManager(context as any);
      (tokenManager as any).statsManager = statsManager;

      // Active has 15% quota, resets in 120 minutes (refill is slow)
      // 15% of 1,000,000 = 150,000 tokens remaining
      const resetTime = new Date(Date.now() + 120 * 60 * 1000).toISOString();
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [
          createFamilyQuota("gemini", 15, 15, resetTime, 15, resetTime),
        ]),
        // Candidate has 85% quota
        [accB.email]: createAccountQuota(accB.email, [
          createFamilyQuota("gemini", 85, 85, undefined, 85, undefined),
        ]),
      };

      // Burn rate = 50,000 tokens/min -> 150,000 / 50,000 = 3 minutes left (< 120 min refill)
      (statsManager as any).getBurnRate = () => ({ tokensPerMin: 50000, recentTurns: 10 });

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
    });

    it("T1.4: falls back to 30-minute drain window when burn rate is zero (idle editor)", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active has 30% quota, resets in 20 minutes (within 30m drain window)
      const resetTime = new Date(Date.now() + 20 * 60 * 1000).toISOString();
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [
          createFamilyQuota("gemini", 30, 30, resetTime, 30, resetTime),
        ]),
        [accB.email]: createAccountQuota(accB.email, [
          createFamilyQuota("gemini", 90, 90, undefined, 90, undefined),
        ]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      // Retained due to imminent reset <= 30m
      expect(selected).toBeNull();
      expect(tokenManager.getActiveEmail()).toBe(accA.email);
    });

    it("T1.5: QuotaMonitor getExhaustionEstimate returns valid estimates given burn rate", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      const resetTime = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 50, 50, resetTime, 50, resetTime),
      ]);
      (quotaMonitor as any).quotas.set(accA.email, quota);

      // 50% = 500,000 tokens remaining. At 10,000 tokens/min -> ~50 mins left
      const estimate = quotaMonitor.getExhaustionEstimate(10000, "gemini-1.5-pro");
      expect(estimate).not.toBeNull();
      expect(estimate?.estMinutesLeft).toBe(50);
      expect(estimate?.earliestResetMinutes).toBeGreaterThanOrEqual(59);
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: zero burn rate produces safe default without division by zero or NaN", async () => {
      const { context } = await setupTestTokenManager();
      const statsManager = new StatsManager(context as any, () => {});

      const burn = statsManager.getBurnRate(15);
      expect(burn.tokensPerMin).toBe(0);
      expect(burn.recentTurns).toBe(0);
      expect(Number.isNaN(burn.tokensPerMin)).toBe(false);
    });

    it("T2.2: QuotaMonitor getExhaustionEstimate returns null when burn rate is 0", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      const estimate = quotaMonitor.getExhaustionEstimate(0, "gemini-1.5-pro");
      expect(estimate).toBeNull();
    });

    it("T2.3: QuotaMonitor getExhaustionEstimate returns null when quota is 0%", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 0, 0, undefined, 0, undefined),
      ]);
      (quotaMonitor as any).quotas.set(accA.email, quota);

      const estimate = quotaMonitor.getExhaustionEstimate(5000, "gemini-1.5-pro");
      expect(estimate).toBeNull();
    });

    it("T2.4: extreme burst burn rate (e.g. 500,000 tok/min) yields estMinutesLeft = 1", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      const quota = createAccountQuota(accA.email, [
        createFamilyQuota("gemini", 10, 10, undefined, 10, undefined),
      ]);
      (quotaMonitor as any).quotas.set(accA.email, quota);

      const estimate = quotaMonitor.getExhaustionEstimate(500000, "gemini-1.5-pro");
      expect(estimate).not.toBeNull();
      expect(estimate?.estMinutesLeft).toBe(1);
    });

    it("T2.5: request pruning keeps maximum 500 requests to bound memory consumption", async () => {
      const { context } = await setupTestTokenManager();
      const statsManager = new StatsManager(context as any, () => {});

      const requests: RequestStats[] = [];
      const now = Date.now();
      for (let i = 0; i < 600; i++) {
        requests.push({
          id: `req-${i}`,
          timestamp: now - i * 1000,
          model: "gemini-1.5-flash",
          promptPreview: `prompt ${i}`,
          turnCount: 1,
          inputTokens: 100,
          outputTokens: 100,
          cacheHitTokens: 0,
          totalTokens: 200,
        });
      }

      (statsManager as any).registry.requests = requests;
      (statsManager as any).pruneRequests();

      expect((statsManager as any).registry.requests.length).toBe(500);
    });

    it("T2.6: StatsManager calculates burn rate accurately across custom 30-minute window", async () => {
      const { context } = await setupTestTokenManager();
      const statsManager = new StatsManager(context as any, () => {});

      const now = Date.now();
      (statsManager as any).registry.requests = [
        {
          id: "r1",
          timestamp: now - 25 * 60 * 1000, // 25m ago (inside 30m window)
          model: "gemini",
          promptPreview: "",
          turnCount: 2,
          inputTokens: 3000,
          outputTokens: 3000,
          cacheHitTokens: 0,
          totalTokens: 6000,
        },
      ];

      const burn30 = statsManager.getBurnRate(30);
      expect(burn30.tokensPerMin).toBeGreaterThan(0);
      expect(burn30.recentTurns).toBe(2);

      // Outside 15m window -> should be 0
      const burn15 = statsManager.getBurnRate(15);
      expect(burn15.tokensPerMin).toBe(0);
    });

    it("T2.7: TokenManager getBurnRate returns null when no statsManager is set", async () => {
      const { tokenManager } = await setupTestTokenManager();
      const burn = tokenManager.getBurnRate();
      expect(burn).toBeNull();
    });
  });
});
