import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as net from "node:net";

import {
  createTestAccount,
  createAccountQuota,
  createFamilyQuota,
  setupTestTokenManager,
} from "../helpers/test-utils.js";
import {
  calculateEffectiveQuota,
} from "../../src/core/token-manager.js";
import { StatsManager } from "../../src/core/stats-manager.js";
import { QuotaMonitor } from "../../src/core/quota-monitor.js";
import { HookServer } from "../../src/core/hook-server.js";
import type { AccountQuota, FamilyQuota } from "../../src/types.js";

describe("Adversarial Fuzz & Concurrency Stress — Challenger 1", () => {
  // =========================================================================
  // FUZZ 1: 5,000 Randomized Permutations of calculateEffectiveQuota
  // =========================================================================
  describe("Fuzz 1: Randomized Permutation Invariant Testing on calculateEffectiveQuota", () => {
    it("survives 5,000 random input permutations without unhandled exceptions and maintains invariants", () => {
      const samplePercents = [
        -100, -1, -0.0001, 0, 0.0001, 5, 10, 15, 50, 99.99, 100, 150,
        Infinity, -Infinity, NaN, undefined, null,
      ];
      const sampleResetTimes = [
        undefined,
        null,
        "",
        "2026-10-28T18:00:00.000Z",
        "2027-01-01T00:00:00Z",
        "1970-01-01T00:00:00Z",
        "not-a-date",
        "9999999999",
        "NaN",
        "2026-02-30T00:00:00Z", // Invalid leap/day
        "\0\0\0",
        " ",
      ];

      let iterations = 0;
      for (let i = 0; i < 5000; i++) {
        const p5h = samplePercents[Math.floor(Math.random() * samplePercents.length)];
        const pWk = samplePercents[Math.floor(Math.random() * samplePercents.length)];
        const r5h = sampleResetTimes[Math.floor(Math.random() * sampleResetTimes.length)];
        const rWk = sampleResetTimes[Math.floor(Math.random() * sampleResetTimes.length)];

        const fam: FamilyQuota = {
          key: "gemini",
          label: "Gemini",
          percent: p5h as any,
          limit5h: p5h !== undefined ? { percent: p5h as any, resetTime: r5h as any } : undefined,
          limitWeekly: pWk !== undefined ? { percent: pWk as any, resetTime: rWk as any } : undefined,
        };

        const eff = calculateEffectiveQuota(fam);
        iterations++;

        // Invariant 1: eff.percent must be a number
        expect(typeof eff.percent).toBe("number");

        // Invariant 2: if inputs are valid numbers, percent must not be negative
        if (typeof p5h === "number" && !isNaN(p5h) && typeof pWk === "number" && !isNaN(pWk)) {
          expect(eff.percent).toBeGreaterThanOrEqual(0);
        }

        // Invariant 3: bindingWindow must be one of "5h", "weekly", "both"
        expect(["5h", "weekly", "both"]).toContain(eff.bindingWindow);

        // Invariant 4: resetTs must be either a valid positive number or Infinity (never negative or NaN)
        expect(Number.isNaN(eff.resetTs)).toBe(false);
        expect(eff.resetTs >= 0 || eff.resetTs === Infinity).toBe(true);
      }

      expect(iterations).toBe(5000);
    });
  });

  // =========================================================================
  // FUZZ 2: Hysteresis & Affinity Precision Matrix
  // =========================================================================
  describe("Fuzz 2: Hysteresis Delta & Model Affinity Boundary Matrix", () => {
    it("verifies floating point precision thresholds around delta = 5", async () => {
      const accA = createTestAccount({ email: "active@gmail.com", tier: "pro" });
      const accB = createTestAccount({ email: "candidate@gmail.com", tier: "pro" });

      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active score = 40 + 10 = 50.
      const testDeltas = [
        { delta: 4.999999, shouldSwitch: false },
        { delta: 5.0, shouldSwitch: false },
        { delta: 5.000001, shouldSwitch: true },
        { delta: 5.1, shouldSwitch: true },
      ];

      for (const td of testDeltas) {
        const candidatePercent = 40 + td.delta;
        const quotas: Record<string, AccountQuota> = {
          [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 40)]),
          [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", candidatePercent)]),
        };

        const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
        if (td.shouldSwitch) {
          expect(selected?.email).toBe(accB.email);
          // Reset active account back to accA for next iteration
          await tokenManager.selectAccount(accA.email);
        } else {
          expect(selected).toBeNull();
        }
      }
    });

    it("verifies model affinity overrides hysteresis delta completely", async () => {
      // accA has affinity 'gemini', accB has affinity 'claude'
      const accA = createTestAccount({ email: "gemini-user@gmail.com", affinity: "gemini", tier: "pro" });
      const accB = createTestAccount({ email: "claude-user@gmail.com", affinity: "claude", tier: "pro" });

      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active (accA) has 80% Claude quota. Candidate (accB) has 81% Claude quota (delta = 1% <= 15%).
      // Because model target is Claude and accA does NOT match affinity ('gemini') while accB DOES ('claude'),
      // candidateMatchesAffinityWhenActiveDoesNot is true -> Hysteresis is bypassed!
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("claude", 80)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("claude", 81)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "claude-3.7-sonnet");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
    });

    it("verifies forceSwitch flag overrides hysteresis and switches even for delta = 0.1%", async () => {
      const accA = createTestAccount({ email: "active@gmail.com", tier: "pro" });
      const accB = createTestAccount({ email: "candidate@gmail.com", tier: "pro" });

      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 70)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 70.1)]),
      };

      // Normal auto: retained because delta 0.1 <= 15
      const normalSelected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(normalSelected).toBeNull();

      // Forced switch: overrides hysteresis
      const forcedSelected = await tokenManager.autoSelectHighestQuota({
        quotas,
        reason: "user_forced",
        targetModel: "gemini-1.5-pro",
        forceSwitch: true,
      });
      expect(forcedSelected?.email).toBe(accB.email);
    });
  });

  // =========================================================================
  // FUZZ 3: StatsManager Memory Bound & Clock Skew
  // =========================================================================
  describe("Fuzz 3: StatsManager Pruning & Clock Invariant Verification", () => {
    it("strictly bounds memory: requests array never exceeds 500 items under 2,000 rapid requests", async () => {
      const { context } = await setupTestTokenManager();
      const stats = new StatsManager(context as any, () => {});

      const baseTime = Date.now() - 600000;
      for (let i = 0; i < 2000; i++) {
        stats.recordTokens(
          "2026-10-28",
          "gemini-1.5-pro",
          `conv-${i % 20}`,
          "title",
          "",
          100 + (i % 50),
          50 + (i % 20),
          0,
          100,
          `prompt unique ${i}`,
          baseTime + i * 100,
          1,
        );
      }

      stats.cleanupStaleStats();
      const list = stats.getRequestsList(1000);
      expect(list.length).toBeLessThanOrEqual(500);

      const burn = stats.getBurnRate(15);
      expect(burn.tokensPerMin).toBeGreaterThan(0);
      expect(Number.isFinite(burn.tokensPerMin)).toBe(true);

      stats.dispose();
    });

    it("handles backward clock jumps (clock skew) gracefully", async () => {
      const { context } = await setupTestTokenManager();
      const stats = new StatsManager(context as any, () => {});

      const now = Date.now();
      // Future request (due to clock skew)
      stats.recordTokens("2026-10-28", "gemini", "c1", "t", "", 5000, 1000, 0, 5000, "future", now + 600000, 1);
      // Current request
      stats.recordTokens("2026-10-28", "gemini", "c1", "t", "", 2000, 500, 0, 2000, "current", now, 1);

      const burn = stats.getBurnRate(15);
      expect(burn.tokensPerMin).toBeGreaterThan(0);
      expect(Number.isFinite(burn.tokensPerMin)).toBe(true);
      expect(Number.isNaN(burn.tokensPerMin)).toBe(false);

      stats.dispose();
    });
  });

  // =========================================================================
  // FUZZ 4: HookServer Concurrency Stress & Rapid Reconnects
  // =========================================================================
  describe("Fuzz 4: HookServer High Concurrency & Socket Stress", () => {
    let hookServer: HookServer;
    let serverPort: number;
    let authToken: string;

    beforeAll(async () => {
      const accA = createTestAccount({ email: "acc-1@gmail.com", tier: "pro" });
      const accB = createTestAccount({ email: "acc-2@gmail.com", tier: "pro" });
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const qm = new QuotaMonitor(tokenManager, context as any, () => {});
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 80)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 90)]),
      };
      (qm as any).quotas.set(accA.email, quotas[accA.email]);
      (qm as any).quotas.set(accB.email, quotas[accB.email]);
      tokenManager.setQuotaMonitor(qm);

      hookServer = new HookServer(tokenManager, qm, () => {});
      serverPort = await hookServer.start(0);
      authToken = hookServer.getAuthToken();
    });

    afterAll(() => {
      hookServer?.dispose();
    });

    it("handles 50 concurrent HTTP requests simultaneously without socket exhaustion or errors", async () => {
      const requests = Array.from({ length: 50 }, async (_, i) => {
        const res = await fetch(`http://127.0.0.1:${serverPort}/pre-invocation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-openag-auth": authToken,
          },
          body: JSON.stringify({
            modelName: "gemini-1.5-pro",
            invocationNum: i,
          }),
        });
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.decision).toBe("allow");
      });

      await Promise.all(requests);
    });

    it("survives rapid consecutive TCP connect-and-abort cycles without server crash", async () => {
      const abortCycles = Array.from({ length: 20 }, async () => {
        return new Promise<void>((resolve) => {
          const s = net.connect({ port: serverPort, host: "127.0.0.1" }, () => {
            s.write("POST /pre-inv");
            s.destroy();
            resolve();
          });
          s.on("error", () => resolve());
        });
      });

      await Promise.all(abortCycles);

      // Verify health check succeeds immediately after
      const res = await fetch(`http://127.0.0.1:${serverPort}/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("ok");
    });
  });
});
