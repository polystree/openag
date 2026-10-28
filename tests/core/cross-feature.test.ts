import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  createTestAccount,
  createAccountQuota,
  createFamilyQuota,
  setupTestTokenManager,
  setupTestQuotaMonitor,
} from "../helpers/test-utils.js";
import { MockLanguageServer } from "../mocks/language-server.js";
import { HookServer } from "../../src/core/hook-server.js";
import { exportPool, importPool } from "../../src/core/pool-crypto.js";
import { StatusBarHUD } from "../../src/ui/status-bar.js";
import { OAuthFlow } from "../../src/core/oauth-flow.js";
import { setMockConfig } from "../mocks/vscode.js";
import type { AccountQuota, OAuthTokens } from "../../src/types.js";

describe("Tier 3: Cross-Feature Combinations", () => {
  let mockServer: MockLanguageServer;
  let hookServer: HookServer | null = null;

  beforeEach(async () => {
    mockServer = new MockLanguageServer();
    await mockServer.start();
  });

  afterEach(async () => {
    setMockConfig("openag.rotationStrategy", "auto_highest");
    setMockConfig("openag.hideEmail", false);
    await mockServer.stop();
    if (hookServer) {
      hookServer.dispose();
      hookServer = null;
    }
  });

  const acc1 = createTestAccount({ email: "user1@gmail.com", tier: "pro", role: "primary" });
  const acc2 = createTestAccount({ email: "user2@gmail.com", tier: "pro", role: "primary" });
  const accReserve = createTestAccount({ email: "reserve@gmail.com", tier: "pro", role: "reserve" });

  it("T3.1: Hysteresis + Dual-Window: binding window determines effective percentage for hysteresis delta", async () => {
    const { tokenManager } = await setupTestTokenManager({
      accounts: [acc1, acc2],
      activeEmail: acc1.email,
    });

    // Acc1 has 5h=90%, Weekly=70% -> binding is Weekly (70%)
    // Acc2 has 5h=80%, Weekly=82% -> binding is 5h (80%)
    // Delta = 80 - 70 = 10% <= 15% hysteresis -> Active account RETAINED
    const quotas: Record<string, AccountQuota> = {
      [acc1.email]: createAccountQuota(acc1.email, [
        createFamilyQuota("gemini", 70, 90, undefined, 70, undefined),
      ]),
      [acc2.email]: createAccountQuota(acc2.email, [
        createFamilyQuota("gemini", 80, 80, undefined, 82, undefined),
      ]),
    };

    const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
    expect(selected).toBeNull();
    expect(tokenManager.getActiveEmail()).toBe(acc1.email);
  });

  it("T3.2: Hysteresis + Burn Rate: predictive drain overrides hysteresis when refill is imminent", async () => {
    const { tokenManager } = await setupTestTokenManager({
      accounts: [acc1, acc2],
      activeEmail: acc1.email,
    });

    // Acc1 is at 25% (delta with Acc2 90% is 65% > 15%), but Acc1 resets in 15 mins (<= 30m drain window)
    const resetTime = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const quotas: Record<string, AccountQuota> = {
      [acc1.email]: createAccountQuota(acc1.email, [
        createFamilyQuota("gemini", 25, 25, resetTime, 25, resetTime),
      ]),
      [acc2.email]: createAccountQuota(acc2.email, [
        createFamilyQuota("gemini", 90, 90, undefined, 90, undefined),
      ]),
    };

    const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
    // Retained to burn remaining quota before imminent refill
    expect(selected).toBeNull();
    expect(tokenManager.getActiveEmail()).toBe(acc1.email);
  });

  it("T3.3: Cooldown + Rotation: account in cooldown is skipped during hysteresis selection", async () => {
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [acc1, acc2],
      activeEmail: acc1.email,
    });
    const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

    // Acc1 exhausted (5%) -> marks exhausted into cooldown
    quotaMonitor.markAccountExhausted(acc1.email, "gemini-1.5-pro", 60000);

    const quotas = quotaMonitor.getAllQuotas();
    quotas[acc2.email] = createAccountQuota(acc2.email, [createFamilyQuota("gemini", 80)]);

    const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
    expect(selected).not.toBeNull();
    expect(selected?.email).toBe(acc2.email);
  });

  it("T3.4: Hook IPC + Seamless Rotation: hook request auto-selects and rotates account cleanly", async () => {
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [acc1, acc2],
      activeEmail: acc1.email,
    });
    const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

    // Acc1 at 5% (exhausted), Acc2 at 95%
    const quotas: Record<string, AccountQuota> = {
      [acc1.email]: createAccountQuota(acc1.email, [createFamilyQuota("gemini", 5)]),
      [acc2.email]: createAccountQuota(acc2.email, [createFamilyQuota("gemini", 95)]),
    };
    (quotaMonitor as any).quotas = new Map(Object.entries(quotas));

    hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
    const port = await hookServer.start(0);

    const res = await fetch(`http://127.0.0.1:${port}/pre-invocation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-openag-auth": hookServer.getAuthToken(),
      },
      body: JSON.stringify({ modelName: "gemini-1.5-pro" }),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.decision).toBe("allow");
    expect(data.rotated).toBe(true);
    expect(data.email).toBe(acc2.email);
    expect(tokenManager.getActiveEmail()).toBe(acc2.email);
  });

  it("T3.5: Dual-Window + Cooldown: account with weekly exhausted (0%) stays in cooldown until weekly reset", async () => {
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [acc1],
      activeEmail: acc1.email,
    });
    const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

    const weeklyReset = Date.now() + 24 * 3600 * 1000;
    const quota = createAccountQuota(acc1.email, [
      createFamilyQuota("gemini", 0, 80, undefined, 0, new Date(weeklyReset).toISOString()),
    ]);
    (quotaMonitor as any).quotas.set(acc1.email, quota);

    quotaMonitor.markAccountExhausted(acc1.email, "gemini-1.5-pro");
    const updated = quotaMonitor.getQuota(acc1.email);
    expect(updated?.cooldownExpiresAt).toBeGreaterThanOrEqual(Date.now() + 60000);
  });

  it("T3.6: Secret Masking + Status Bar: hideEmail hides account email in HUD tooltip", async () => {
    setMockConfig("openag.hideEmail", true);
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [acc1],
      activeEmail: acc1.email,
      config: { hideEmail: true },
    });

    const sb = new StatusBarHUD(context as any, undefined, tokenManager);
    sb.updateAccount(acc1.email, "pro", true);
    (sb as any).render();

    const tooltip = ((sb as any).item.tooltip as any).value || "";
    expect(tooltip).not.toContain("user1@gmail.com");
    sb.dispose();
  });

  it("T3.7: Async Crypto + Token Manager: exported encrypted pool can be imported into TokenManager", async () => {
    const { tokenManager: _tokenManager } = await setupTestTokenManager({
      accounts: [acc1, acc2],
      activeEmail: acc1.email,
    });

    const secrets: Record<string, OAuthTokens> = {
      [acc1.email]: { accessToken: "tok-1", refreshToken: "ref-1", expiryDateSeconds: 10000 },
      [acc2.email]: { accessToken: "tok-2", refreshToken: "ref-2", expiryDateSeconds: 10000 },
    };

    const enc = await exportPool([acc1, acc2], secrets, "pass123");
    const dec = await importPool(enc, "pass123");

    expect(dec.accounts.length).toBe(2);
    expect(dec.secrets[acc1.email]?.refreshToken).toBe("ref-1");
  });

  it("T3.8: Reserve Pool + Hysteresis: primary accounts used until all primary accounts drop <= 10%", async () => {
    const { tokenManager } = await setupTestTokenManager({
      accounts: [acc1, accReserve],
      activeEmail: acc1.email,
    });

    // Acc1 (primary) at 30%, Reserve at 100%
    // Even though delta is 70%, Reserve is NOT touched while primary is > 10%
    const quotas: Record<string, AccountQuota> = {
      [acc1.email]: createAccountQuota(acc1.email, [createFamilyQuota("gemini", 30)]),
      [accReserve.email]: createAccountQuota(accReserve.email, [createFamilyQuota("gemini", 100)]),
    };

    const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
    expect(selected).toBeNull();
    expect(tokenManager.getActiveEmail()).toBe(acc1.email);
  });

  it("T3.9: Reserve Pool switches when all primaries drop <= 10%", async () => {
    const { tokenManager } = await setupTestTokenManager({
      accounts: [acc1, accReserve],
      activeEmail: acc1.email,
    });

    // Acc1 (primary) drops to 8% (<= 10%), Reserve at 100%
    const quotas: Record<string, AccountQuota> = {
      [acc1.email]: createAccountQuota(acc1.email, [createFamilyQuota("gemini", 8)]),
      [accReserve.email]: createAccountQuota(accReserve.email, [createFamilyQuota("gemini", 100)]),
    };

    const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
    expect(selected).not.toBeNull();
    expect(selected?.email).toBe(accReserve.email);
  });

  it("T3.10: Tier Priority: Ultra/Pro tier accounts used before Free accounts", async () => {
    const freeAcc = createTestAccount({ email: "free@gmail.com", tier: "free" });
    const { tokenManager } = await setupTestTokenManager({
      accounts: [freeAcc, acc1],
      activeEmail: freeAcc.email,
    });

    // Free has 90%, Pro (acc1) has 70%
    // OpenAG must switch to paid account before burning free tier quota
    const quotas: Record<string, AccountQuota> = {
      [freeAcc.email]: createAccountQuota(freeAcc.email, [createFamilyQuota("gemini", 90)], "free"),
      [acc1.email]: createAccountQuota(acc1.email, [createFamilyQuota("gemini", 70)], "pro"),
    };

    const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
    expect(selected).not.toBeNull();
    expect(selected?.email).toBe(acc1.email);
  });

  it("T3.11: Connect-RPC 401 Unauthorized invalidates language server cache", async () => {
    mockServer.simulateAuthError = true;
    const client = mockServer.createClient();

    const status = await client.getUserStatus();
    expect(status).toBeNull();
    expect((client as any).cachedInfo).toBeNull();
  });

  it("T3.12: Hook Server fail-open on unexpected error", async () => {
    const { tokenManager, context } = await setupTestTokenManager();
    const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

    // Force error in autoSelectHighestQuota
    (tokenManager as any).autoSelectHighestQuota = async () => {
      throw new Error("Simulated rotation engine crash");
    };

    hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
    const port = await hookServer.start(0);

    const res = await fetch(`http://127.0.0.1:${port}/pre-invocation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-openag-auth": hookServer.getAuthToken(),
      },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.decision).toBe("allow");
    expect(data.rotated).toBe(false);
  });

  it("T3.13: Multiple concurrent hook requests are handled gracefully without socket hang up", async () => {
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [acc1, acc2],
      activeEmail: acc1.email,
    });
    const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

    hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
    const port = await hookServer.start(0);

    const requests = Array.from({ length: 10 }, () =>
      fetch(`http://127.0.0.1:${port}/pre-invocation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openag-auth": hookServer!.getAuthToken(),
        },
        body: JSON.stringify({ modelName: "gemini-1.5-pro" }),
      }),
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.decision).toBe("allow");
    }
  });

  it("T3.14: Round-Robin strategy prioritizes imminent refill candidate (<= 45m)", async () => {
    setMockConfig("openag.rotationStrategy", "round_robin");
    const { tokenManager } = await setupTestTokenManager({
      accounts: [acc1, acc2],
      activeEmail: acc1.email,
      config: { rotationStrategy: "round_robin" },
    });

    // Acc1 has 60%
    // Acc2 has 30%, but refills in 20 mins (<= 45m imminent)
    const resetTime = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const quotas: Record<string, AccountQuota> = {
      [acc1.email]: createAccountQuota(acc1.email, [createFamilyQuota("gemini", 60)]),
      [acc2.email]: createAccountQuota(acc2.email, [createFamilyQuota("gemini", 30, 30, resetTime)]),
    };

    const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
    expect(selected).not.toBeNull();
    expect(selected?.email).toBe(acc2.email);
  });

  it("T3.15: Cache-Optimized strategy retains active account as long as quota > 15%", async () => {
    setMockConfig("openag.rotationStrategy", "cache_optimized");
    const { tokenManager } = await setupTestTokenManager({
      accounts: [acc1, acc2],
      activeEmail: acc1.email,
      config: { rotationStrategy: "cache_optimized" },
    });

    // Acc1 has 20% (> 15%), Acc2 has 100%
    // Cache-optimized sticks to active account to preserve KV cache
    const quotas: Record<string, AccountQuota> = {
      [acc1.email]: createAccountQuota(acc1.email, [createFamilyQuota("gemini", 20)]),
      [acc2.email]: createAccountQuota(acc2.email, [createFamilyQuota("gemini", 100)]),
    };

    const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
    expect(selected).toBeNull();
    expect(tokenManager.getActiveEmail()).toBe(acc1.email);
  });

  it("T3.16: TokenManager.reauthAccount rejects when browser signs into a different email", async () => {
    const { tokenManager } = await setupTestTokenManager({
      accounts: [acc1],
      activeEmail: acc1.email,
    });

    const loginSpy = spyOn(OAuthFlow, "startLogin").mockResolvedValue({
      email: "another-user@gmail.com",
      tokens: {
        accessToken: "tok-diff",
        refreshToken: "ref-diff",
        expiryDateSeconds: 12345,
      },
    });

    try {
      await expect(tokenManager.reauthAccount(acc1.email)).rejects.toThrow(
        /Signed in as another-user@gmail.com, but re-authenticating user1@gmail.com/
      );
      expect(loginSpy).toHaveBeenCalledWith(acc1.email);
    } finally {
      loginSpy.mockRestore();
    }
  });

  it("T3.17: TokenManager.reauthAccount succeeds and updates token when email matches", async () => {
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [acc1],
      activeEmail: acc1.email,
    });

    const loginSpy = spyOn(OAuthFlow, "startLogin").mockResolvedValue({
      email: acc1.email,
      tokens: {
        accessToken: "brand-new-acc-tok",
        refreshToken: "brand-new-ref-tok",
        expiryDateSeconds: 99999999,
      },
    });

    try {
      const updated = await tokenManager.reauthAccount(acc1.email);
      expect(updated.email).toBe(acc1.email);
      expect(loginSpy).toHaveBeenCalledWith(acc1.email);

      const secretKey = `openag.secret.${acc1.email}`;
      const storedSecret = await context.secrets.get(secretKey);
      expect(storedSecret).not.toBeNull();
      const parsedSecret = JSON.parse(storedSecret!);
      expect(parsedSecret.refreshToken).toBe("brand-new-ref-tok");
    } finally {
      loginSpy.mockRestore();
    }
  });
});
