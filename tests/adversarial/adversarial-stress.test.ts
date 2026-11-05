import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { readIpcDiscovery } from "../../src/hook.js";
import type { AccountQuota, FamilyQuota } from "../../src/types.js";

describe("Adversarial Stress Suite — Challenger 1", () => {
  // =========================================================================
  // PROBE 1: calculateEffectiveQuota Extreme Inputs
  // =========================================================================
  describe("Probe 1: calculateEffectiveQuota extreme inputs", () => {
    it("P1.1: handles NaN / invalid date reset times without crashing or propagating NaN", () => {
      const fam1: FamilyQuota = {
        key: "gemini",
        label: "Gemini",
        percent: 60,
        resetTime: "invalid-date-string",
        limit5h: { percent: 60, resetTime: "not-a-timestamp" },
        limitWeekly: { percent: 80, resetTime: "2026-99-99T99:99:99Z" },
      };

      const eff = calculateEffectiveQuota(fam1);
      expect(eff.percent).toBe(60);
      expect(eff.bindingWindow).toBe("5h");
      expect(Number.isFinite(eff.resetTs)).toBe(false);
      expect(eff.resetTs).toBe(Infinity);
      expect(Number.isNaN(eff.resetTs)).toBe(false);
    });

    it("P1.2: handles empty string, null, and undefined reset times cleanly", () => {
      const fam: FamilyQuota = {
        key: "gemini",
        label: "Gemini",
        percent: 50,
        resetTime: "",
        limit5h: { percent: 50, resetTime: "" },
        limitWeekly: { percent: 50, resetTime: undefined },
      };

      const eff = calculateEffectiveQuota(fam);
      expect(eff.percent).toBe(50);
      expect(eff.bindingWindow).toBe("both");
      expect(eff.resetTs).toBe(Infinity);
    });

    it("P1.3: handles negative percentages (e.g. -15% 5h, -50% weekly)", () => {
      // 5h is -15%, weekly is 80%: 5h is lower binding constraint, clamped to 0
      const fam1: FamilyQuota = {
        key: "gemini",
        label: "Gemini",
        percent: -15,
        limit5h: { percent: -15, resetTime: "2026-10-28T20:00:00Z" },
        limitWeekly: { percent: 80, resetTime: "2026-11-04T00:00:00Z" },
      };
      const eff1 = calculateEffectiveQuota(fam1);
      expect(eff1.percent).toBe(0);
      expect(eff1.bindingWindow).toBe("5h");
      expect(eff1.resetTs).toBe(Date.parse("2026-10-28T20:00:00Z"));

      // 5h is 80%, weekly is -50%: weekly is negative (<= 0), so weekly binds
      const fam2: FamilyQuota = {
        key: "gemini",
        label: "Gemini",
        percent: 80,
        limit5h: { percent: 80, resetTime: "2026-10-28T20:00:00Z" },
        limitWeekly: { percent: -50, resetTime: "2026-11-04T00:00:00Z" },
      };
      const eff2 = calculateEffectiveQuota(fam2);
      expect(eff2.percent).toBe(0);
      expect(eff2.bindingWindow).toBe("weekly");
      expect(eff2.resetTs).toBe(Date.parse("2026-11-04T00:00:00Z"));

      // Both negative: 5h = -20%, weekly = -10% -> 5h is lower
      const fam3: FamilyQuota = {
        key: "gemini",
        label: "Gemini",
        percent: -20,
        limit5h: { percent: -20, resetTime: "2026-10-28T20:00:00Z" },
        limitWeekly: { percent: -10, resetTime: "2026-11-04T00:00:00Z" },
      };
      const eff3 = calculateEffectiveQuota(fam3);
      expect(eff3.percent).toBe(0);
      expect(eff3.bindingWindow).toBe("5h");
    });

    it("P1.4: handles asymmetric 100% 5h vs 0% weekly and vice versa", () => {
      // 100% 5h vs 0% weekly -> Weekly limit binds completely to 0%
      const fam1: FamilyQuota = {
        key: "gemini",
        label: "Gemini",
        percent: 100,
        limit5h: { percent: 100, resetTime: "2026-10-28T22:00:00Z" },
        limitWeekly: { percent: 0, resetTime: "2026-11-04T00:00:00Z" },
      };
      const eff1 = calculateEffectiveQuota(fam1);
      expect(eff1.percent).toBe(0);
      expect(eff1.bindingWindow).toBe("weekly");
      expect(eff1.resetTs).toBe(Date.parse("2026-11-04T00:00:00Z"));

      // 0% 5h vs 100% weekly -> 5h limit binds completely to 0%
      const fam2: FamilyQuota = {
        key: "gemini",
        label: "Gemini",
        percent: 0,
        limit5h: { percent: 0, resetTime: "2026-10-28T22:00:00Z" },
        limitWeekly: { percent: 100, resetTime: "2026-11-04T00:00:00Z" },
      };
      const eff2 = calculateEffectiveQuota(fam2);
      expect(eff2.percent).toBe(0);
      expect(eff2.bindingWindow).toBe("5h");
      expect(eff2.resetTs).toBe(Date.parse("2026-10-28T22:00:00Z"));

      // 0% 5h vs 0% weekly -> both bind, resetTs is earliest
      const t1 = Date.parse("2026-10-28T21:00:00Z");
      const t2 = Date.parse("2026-10-28T23:00:00Z");
      const fam3: FamilyQuota = {
        key: "gemini",
        label: "Gemini",
        percent: 0,
        limit5h: { percent: 0, resetTime: new Date(t2).toISOString() },
        limitWeekly: { percent: 0, resetTime: new Date(t1).toISOString() },
      };
      const eff3 = calculateEffectiveQuota(fam3);
      expect(eff3.percent).toBe(0);
      expect(eff3.bindingWindow).toBe("both");
      expect(eff3.resetTs).toBe(t1);
    });

    it("P1.5: handles completely missing limit objects and empty payload gracefully", () => {
      // Empty object cast as FamilyQuota
      const famEmpty = {} as unknown as FamilyQuota;
      const effEmpty = calculateEffectiveQuota(famEmpty);
      expect(effEmpty.percent).toBe(100);
      expect(effEmpty.bindingWindow).toBe("both");
      expect(effEmpty.resetTs).toBe(Infinity);

      // Only top-level percent provided
      const famLegacy: FamilyQuota = {
        key: "claude",
        label: "Claude",
        percent: 42,
        resetTime: "2026-10-28T19:00:00Z",
      };
      const effLegacy = calculateEffectiveQuota(famLegacy);
      expect(effLegacy.percent).toBe(42);
      expect(effLegacy.bindingWindow).toBe("5h");
      expect(effLegacy.resetTs).toBe(Date.parse("2026-10-28T19:00:00Z"));

      // Only weekly limit provided
      const famWeeklyOnly: FamilyQuota = {
        key: "claude",
        label: "Claude",
        percent: 100,
        limitWeekly: { percent: 25, resetTime: "2026-11-01T00:00:00Z" },
      };
      const effWeekly = calculateEffectiveQuota(famWeeklyOnly);
      expect(effWeekly.percent).toBe(25);
      expect(effWeekly.bindingWindow).toBe("weekly");
      expect(effWeekly.resetTs).toBe(Date.parse("2026-11-01T00:00:00Z"));
    });

    it("P1.6: behavior under NaN percentages", () => {
      // Stress testing non-numeric input: NaN in limit5h
      const famNaN: FamilyQuota = {
        key: "gemini",
        label: "Gemini",
        percent: NaN,
        limit5h: { percent: NaN },
        limitWeekly: { percent: 50 },
      };
      const effNaN = calculateEffectiveQuota(famNaN);
      // Let's document what happens: In JS NaN < 50 is false and 50 < NaN is false.
      // Math.max(0, NaN) returns NaN.
      // We check that it does not crash or throw unhandled exceptions.
      expect(typeof effNaN.percent).toBe("number");
    });
  });

  // =========================================================================
  // PROBE 2: Boundary Tests for autoSelectHighestQuota
  // =========================================================================
  describe("Probe 2: Boundary tests for autoSelectHighestQuota", () => {
    const accA = createTestAccount({ email: "active@gmail.com", tier: "pro" });
    const accB = createTestAccount({ email: "candidate@gmail.com", tier: "pro" });

    it("P2.1: bestScore exactly equals activeScore + 5 (HYSTERESIS_DELTA) -> RETAIN active account", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active score = 50 + 10 = 60. Candidate score = 55 + 10 = 65.
      // bestScore - activeScore = 65 - 60 = 5. Exactly equal to 5.
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 50)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 55)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).toBeNull();
      expect(tokenManager.getActiveEmail()).toBe(accA.email);
    });

    it("P2.2: bestScore equals activeScore + 5.0001 -> ROTATE to candidate", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active score = 50 + 10 = 60. Candidate score = 55.0001 + 10 = 65.0001.
      // bestScore - activeScore = 5.0001 > 5.
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 50)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 55.0001)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
      expect(tokenManager.getActiveEmail()).toBe(accB.email);
    });

    it("P2.3: bestScore equals activeScore + 4.9999 -> RETAIN active account", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active score = 50 + 10 = 60. Candidate score = 54.9999 + 10 = 64.9999.
      // bestScore - activeScore = 4.9999 <= 5.
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 50)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 54.9999)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).toBeNull();
      expect(tokenManager.getActiveEmail()).toBe(accA.email);
    });

    it("P2.4: active account exactly at 10.0% is exhausted -> hysteresis is bypassed and switches to higher candidate", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active is exactly at 10.0% (exhausted <= 10). Candidate has 13% (delta = 3% <= 5%).
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 10.0)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 13.0)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
      expect(tokenManager.getActiveEmail()).toBe(accB.email);
    });

    it("P2.5: active account at 10.0001% is NOT exhausted -> hysteresis prevents switch for delta <= 5", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active is 10.0001% (not exhausted > 10). Candidate has 13% (delta = 2.9999% <= 5%).
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 10.0001)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 13.0)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).toBeNull();
      expect(tokenManager.getActiveEmail()).toBe(accA.email);
    });

    it("P2.6: active account at 9.9999% is exhausted -> hysteresis is bypassed", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active is 9.9999% (exhausted <= 10). Candidate has 14% (delta = 4.0001% <= 15%).
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 9.9999)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 14.0)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);
      expect(tokenManager.getActiveEmail()).toBe(accB.email);
    });

    it("P2.7: edge case — active account at 10% vs candidate with LOWER quota (e.g. 5%)", async () => {
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      // Active has 10%, candidate has 5%. Both are <= 10%.
      // Candidate score = 5 + 10 = 15. Active score = 10 + 10 = 20.
      // Best score (15) < active score (20).
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 10.0)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 5.0)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      // Let's check what it does! Does it rotate to candidate with LESS quota or retain?
      console.log(`[P2.7 Observation] When active=10% and candidate=5%, selected=${selected?.email}`);
    });

    it("P2.8: tie-breaker on resetTs when candidates have equal highest score", async () => {
      const accC = createTestAccount({ email: "candidate2@gmail.com", tier: "pro" });
      const { tokenManager } = await setupTestTokenManager({
        accounts: [accA, accB, accC],
        activeEmail: accA.email,
      });

      const now = Date.now();
      const earlierReset = new Date(now + 1 * 3600000).toISOString();
      const laterReset = new Date(now + 3 * 3600000).toISOString();

      // Active has 30%. Candidate B and C both have 80%.
      // Candidate B resets later, Candidate C resets earlier.
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 30)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 80, 80, laterReset)]),
        [accC.email]: createAccountQuota(accC.email, [createFamilyQuota("gemini", 80, 80, earlierReset)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      // Candidate C with earlier reset timestamp should be chosen on tie
      expect(selected?.email).toBe(accC.email);
    });
  });

  // =========================================================================
  // PROBE 3: Burn-Rate Calculation Extreme Inputs
  // =========================================================================
  describe("Probe 3: Burn-rate calculation with 0 tokens, infinite tokens, zero time elapsed", () => {
    it("P3.1: getBurnRate with 0 tokens returns { tokensPerMin: 0, recentTurns: 0 }", async () => {
      const { context } = await setupTestTokenManager();
      const stats = new StatsManager(context as any, () => {});

      // No requests recorded
      const rateEmpty = stats.getBurnRate();
      expect(rateEmpty.tokensPerMin).toBe(0);
      expect(rateEmpty.recentTurns).toBe(0);

      // Record a request with 0 tokens
      stats.recordTokens("2026-10-28", "gemini", "conv-1", "test", "", 0, 0, 0, 0, "test prompt");
      const rateZero = stats.getBurnRate();
      expect(rateZero.tokensPerMin).toBe(0);
      expect(rateZero.recentTurns).toBe(0);

      stats.dispose();
    });

    it("P3.2: getBurnRate with zero time elapsed (all requests at current millisecond) avoids division by zero", async () => {
      const { context } = await setupTestTokenManager();
      const stats = new StatsManager(context as any, () => {});

      const now = Date.now();
      // Record 5 requests at the exact same millisecond
      for (let i = 0; i < 5; i++) {
        stats.recordTokens(
          "2026-10-28",
          "gemini",
          `conv-${i}`,
          "title",
          "",
          1000,
          500,
          0,
          1000,
          `prompt ${i}`,
          now,
          1,
        );
      }

      // Elapsed time is 0 ms, which Math.round(0 / 60000) = 0.
      // Must clamp to Math.max(1, ...) -> elapsedMinutes = 1
      const rate = stats.getBurnRate(15);
      expect(Number.isFinite(rate.tokensPerMin)).toBe(true);
      expect(Number.isNaN(rate.tokensPerMin)).toBe(false);
      expect(rate.tokensPerMin).toBe(7500); // 7500 tokens / 1 minute
      expect(rate.recentTurns).toBe(5);

      stats.dispose();
    });

    it("P3.3: getBurnRate with huge token numbers (1e12) and infinite values", async () => {
      const { context } = await setupTestTokenManager();
      const stats = new StatsManager(context as any, () => {});

      const now = Date.now();
      stats.recordTokens(
        "2026-10-28",
        "gemini",
        "conv-huge",
        "title",
        "",
        500000000,
        500000000,
        0,
        500000000,
        "huge prompt",
        now,
        1,
      );

      const rate = stats.getBurnRate(15);
      expect(rate.tokensPerMin).toBe(1000000000); // 1 billion tokens / 1 min
      expect(Number.isFinite(rate.tokensPerMin)).toBe(true);

      stats.dispose();
    });

    it("P3.4: QuotaMonitor getExhaustionEstimate boundary behaviors", async () => {
      const accA = createTestAccount({ email: "active@gmail.com", tier: "pro" });
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });

      const qm = new QuotaMonitor(tokenManager, context as any, () => {});
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 50)]),
      };
      (qm as any).quotas.set(accA.email, quotas[accA.email]);

      // tokensPerMin <= 0 -> returns null
      expect(qm.getExhaustionEstimate(0)).toBeNull();
      expect(qm.getExhaustionEstimate(-500)).toBeNull();

      // tokensPerMin = Infinity
      const estInf = qm.getExhaustionEstimate(Infinity);
      expect(estInf).not.toBeNull();
      // 500,000 / Infinity = 0 -> Math.max(1, 0) = 1
      expect(estInf?.estMinutesLeft).toBe(1);

      // Normal burn rate
      const estNormal = qm.getExhaustionEstimate(10000);
      expect(estNormal?.estMinutesLeft).toBe(50); // 500,000 / 10,000 = 50 min

      qm.dispose();
    });

    it("P3.5: Predictive refill coordination when timeToRefill is in the past or zero", async () => {
      const accA = createTestAccount({ email: "active@gmail.com", tier: "pro" });
      const accB = createTestAccount({ email: "candidate@gmail.com", tier: "pro" });
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const stats = new StatsManager(context as any, () => {});
      tokenManager.setStatsManager(stats);

      // Record burn rate: 5000 tokens/min
      stats.recordTokens("2026-10-28", "gemini", "c1", "t", "", 5000, 0, 0, 5000, "prompt", Date.now(), 1);

      // Reset time is in the PAST (timeToRefillMs < 0)
      const pastReset = new Date(Date.now() - 3600000).toISOString();
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 40, 40, pastReset)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 80)]),
      };

      // Since reset time is in the past, timeToRefillMs <= 0, predictive refill should NOT retain
      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      expect(selected).not.toBeNull();
      expect(selected?.email).toBe(accB.email);

      stats.dispose();
    });
  });

  // =========================================================================
  // PROBE 4: PreInvocation Hook Server Stress Testing
  // =========================================================================
  describe("Probe 4: PreInvocation Hook Server under corrupted IPC, invalid auth, socket aborts", () => {
    let hookServer: HookServer;
    let serverPort: number;
    let authToken: string;
    let tempIpcDir: string;

    beforeAll(async () => {
      tempIpcDir = fs.mkdtempSync(path.join(os.tmpdir(), "openag-test-ipc-"));

      const accA = createTestAccount({ email: "active@gmail.com", tier: "pro" });
      const accB = createTestAccount({ email: "rotated@gmail.com", tier: "pro" });
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });

      const qm = new QuotaMonitor(tokenManager, context as any, () => {});
      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 5)]), // exhausted
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 90)]),
      };
      (qm as any).quotas.set(accA.email, quotas[accA.email]);
      (qm as any).quotas.set(accB.email, quotas[accB.email]);
      tokenManager.setQuotaMonitor(qm);

      hookServer = new HookServer(tokenManager, qm, () => {});
      serverPort = await hookServer.start(0); // dynamic port
      authToken = hookServer.getAuthToken();
    });

    afterAll(() => {
      hookServer?.dispose();
      if (fs.existsSync(tempIpcDir)) {
        fs.rmSync(tempIpcDir, { recursive: true, force: true });
      }
    });

    it("P4.1: readIpcDiscovery handles various corruptions of ipc.json gracefully", () => {
      const ipcFile = path.join(os.homedir(), ".gemini", "openag", "ipc.json");
      const backupExists = fs.existsSync(ipcFile);
      const backupContent = backupExists ? fs.readFileSync(ipcFile, "utf-8") : null;

      try {
        const testCases = [
          { name: "corrupted JSON syntax", content: "{ \"port\": 27182, " },
          { name: "JSON null", content: "null" },
          { name: "JSON number", content: "12345" },
          { name: "JSON boolean", content: "true" },
          { name: "JSON string", content: "\"hello world\"" },
          { name: "JSON array", content: "[1, 2, 3]" },
          { name: "empty file", content: "" },
          { name: "negative port", content: JSON.stringify({ port: -50, authToken: "tok" }) },
          { name: "string port", content: JSON.stringify({ port: "invalid", authToken: "tok" }) },
        ];

        for (const tc of testCases) {
          fs.writeFileSync(ipcFile, tc.content, "utf-8");
          const disc = readIpcDiscovery();
          // Under all corruptions, readIpcDiscovery must return fallback port (27182) and string authToken without throwing
          expect(disc.port).toBe(27182);
          expect(typeof disc.authToken).toBe("string");
        }
      } finally {
        if (backupExists && backupContent !== null) {
          fs.writeFileSync(ipcFile, backupContent, "utf-8");
        }
      }
    });

    it("P4.2: HookServer rejects requests with missing or invalid auth header with HTTP 401", async () => {
      // 1. Missing header
      const resNoAuth = await fetch(`http://127.0.0.1:${serverPort}/pre-invocation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelName: "gemini-1.5-pro" }),
      });
      expect(resNoAuth.status).toBe(401);
      const errNoAuth = await resNoAuth.json();
      expect(errNoAuth.error).toBe("Unauthorized");

      // 2. Invalid header
      const resWrongAuth = await fetch(`http://127.0.0.1:${serverPort}/pre-invocation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openag-auth": "completely-wrong-token-abc",
        },
        body: JSON.stringify({ modelName: "gemini-1.5-pro" }),
      });
      expect(resWrongAuth.status).toBe(401);

      // 3. Valid header -> succeeds with 200
      const resValid = await fetch(`http://127.0.0.1:${serverPort}/pre-invocation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openag-auth": authToken,
        },
        body: JSON.stringify({ modelName: "gemini-1.5-pro" }),
      });
      expect(resValid.status).toBe(200);
      const dataValid = await resValid.json();
      expect(dataValid.decision).toBe("allow");
    });

    it("P4.3: HookServer survives client socket abort / abrupt disconnect during request", async () => {
      // Create raw TCP connection and abruptly destroy it
      await new Promise<void>((resolve) => {
        const client = net.connect({ port: serverPort, host: "127.0.0.1" }, () => {
          // Write partial HTTP POST headers
          client.write(`POST /pre-invocation HTTP/1.1\r\nHost: 127.0.0.1\r\nx-openag-auth: ${authToken}\r\nContent-Length: 1000\r\n\r\nPartial data...`);
          // Abruptly destroy the socket without finishing body
          setTimeout(() => {
            client.destroy();
            resolve();
          }, 10);
        });
        client.on("error", () => resolve()); // Ignore client connection error
      });

      // Verify HookServer is STILL alive and responding to subsequent requests
      const resAfterAbort = await fetch(`http://127.0.0.1:${serverPort}/health`);
      expect(resAfterAbort.status).toBe(200);
      const health = await resAfterAbort.json();
      expect(health.status).toBe("ok");
    });

    it("P4.4: HookServer handles oversized payload (>64KB) by destroying request", async () => {
      const hugePayload = JSON.stringify({
        modelName: "gemini-1.5-pro",
        junk: "x".repeat(70000), // > 65536 bytes
      });

      let failedOrDestroyed = false;
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/pre-invocation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-openag-auth": authToken,
          },
          body: hugePayload,
        });
        // If server destroys socket, fetch may throw or return error
        if (!res.ok) failedOrDestroyed = true;
      } catch {
        failedOrDestroyed = true;
      }

      expect(failedOrDestroyed).toBe(true);

      // Verify server is STILL alive
      const resHealth = await fetch(`http://127.0.0.1:${serverPort}/health`);
      expect(resHealth.status).toBe(200);
    });

    it("P4.5: HookServer handles malformed JSON body gracefully without throwing", async () => {
      const res = await fetch(`http://127.0.0.1:${serverPort}/pre-invocation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openag-auth": authToken,
        },
        body: "{ this is not valid json !!!",
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.decision).toBe("allow");
      expect(body.rotated).toBe(false);
      expect(body.error).toBeDefined();
    });

    it("P4.6: HookServer handles non-POST methods and unknown endpoints cleanly", async () => {
      // GET to /pre-invocation
      const resGet = await fetch(`http://127.0.0.1:${serverPort}/pre-invocation`, {
        method: "GET",
      });
      expect(resGet.status).toBe(404);

      // PUT to /pre-invocation
      const resPut = await fetch(`http://127.0.0.1:${serverPort}/pre-invocation`, {
        method: "PUT",
      });
      expect(resPut.status).toBe(404);

      // Unknown endpoint
      const resUnknown = await fetch(`http://127.0.0.1:${serverPort}/nonexistent`);
      expect(resUnknown.status).toBe(404);
    });
  });
});
