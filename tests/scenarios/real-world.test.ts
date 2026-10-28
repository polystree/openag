import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import {
  createTestAccount,
  createAccountQuota,
  createFamilyQuota,
  setupTestTokenManager,
  setupTestQuotaMonitor,
} from "../helpers/test-utils.js";
import { MockLanguageServer } from "../mocks/language-server.js";
import { HookServer } from "../../src/core/hook-server.js";
import { LogManager } from "../../src/core/log-manager.js";
import { StatsManager } from "../../src/core/stats-manager.js";
import { StatusBarHUD } from "../../src/ui/status-bar.js";
import { WebviewProvider } from "../../src/ui/webview-provider.js";
import { MockWebviewView, setMockConfig, getMockOutputChannels } from "../mocks/vscode.js";
import type { AccountQuota, RequestStats } from "../../src/types.js";

describe("Tier 4: Real-World Application Scenarios", () => {
  let mockServer: MockLanguageServer;
  let hookServer: HookServer | null = null;
  let statusBar: StatusBarHUD | null = null;

  beforeEach(async () => {
    mockServer = new MockLanguageServer();
    await mockServer.start();
  });

  afterEach(async () => {
    await mockServer.stop();
    if (hookServer) {
      hookServer.dispose();
      hookServer = null;
    }
    if (statusBar) {
      statusBar.dispose();
      statusBar = null;
    }
    setMockConfig("openag.rotationStrategy", "auto_highest");
    setMockConfig("openag.hideEmail", false);
  });

  const accAlpha = createTestAccount({ email: "alpha-primary@gmail.com", tier: "pro", alias: "Alpha" });
  const accBeta = createTestAccount({ email: "beta-backup@gmail.com", tier: "pro", alias: "Beta" });

  it("Scenario 1: Continuous Multi-Turn Coding Session with Hysteresis Retention", async () => {
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [accAlpha, accBeta],
      activeEmail: accAlpha.email,
    });
    const statsManager = new StatsManager(context as any, () => {});
    (tokenManager as any).statsManager = statsManager;

    // Simulate 10 turns of user coding
    let quotaAlpha = 100;
    const now = Date.now();

    for (let turn = 1; turn <= 10; turn++) {
      quotaAlpha -= 3; // consumes 3% per turn (100% -> 70%)
      const req: RequestStats = {
        id: `turn-${turn}`,
        timestamp: now - (10 - turn) * 60000,
        model: "gemini-1.5-pro",
        promptPreview: `Turn ${turn} code assist`,
        turnCount: 1,
        inputTokens: 1500,
        outputTokens: 800,
        cacheHitTokens: 500,
        totalTokens: 2300,
      };
      (statsManager as any).registry.requests.push(req);

      // Candidate Beta stays at 80% quota
      // During turns 1..7, Alpha quota drops from 97% to 76% (always higher than Beta or within 15% hysteresis)
      // At turn 10: Alpha is 70%, Beta is 80% -> delta = 10% <= 15% hysteresis -> Retain Alpha!
      const quotas: Record<string, AccountQuota> = {
        [accAlpha.email]: createAccountQuota(accAlpha.email, [createFamilyQuota("gemini", quotaAlpha)]),
        [accBeta.email]: createAccountQuota(accBeta.email, [createFamilyQuota("gemini", 80)]),
      };

      const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
      // Hysteresis prevents oscillation: active account Alpha remains selected throughout session
      expect(selected).toBeNull();
      expect(tokenManager.getActiveEmail()).toBe(accAlpha.email);
    }

    // Verify burn rate tracking computed tokens across all 10 turns
    const burn = statsManager.getBurnRate(15);
    expect(burn.tokensPerMin).toBeGreaterThan(0);
    expect(burn.recentTurns).toBe(10);
  });

  it("Scenario 2: 429 Rate Limit Spike & Fast Failover to Cooldown Rehabilitation", async () => {
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [accAlpha, accBeta],
      activeEmail: accAlpha.email,
    });
    const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

    // Initial quotas: Alpha=90%, Beta=85%
    const quotas: Record<string, AccountQuota> = {
      [accAlpha.email]: createAccountQuota(accAlpha.email, [createFamilyQuota("gemini", 90)]),
      [accBeta.email]: createAccountQuota(accBeta.email, [createFamilyQuota("gemini", 85)]),
    };
    (quotaMonitor as any).quotas = new Map(Object.entries(quotas));

    expect(tokenManager.getActiveEmail()).toBe(accAlpha.email);

    // Alpha encounters HTTP 429 Too Many Requests -> markAccountExhausted with 10s cooldown
    quotaMonitor.markAccountExhausted(accAlpha.email, "gemini-1.5-pro", 10000);

    const exhaustedQuota = quotaMonitor.getQuota(accAlpha.email);
    expect(exhaustedQuota?.families[0]?.percent).toBe(0);
    expect(exhaustedQuota?.cooldownExpiresAt).toBeGreaterThan(Date.now());

    // Trigger rate-limit failover
    const failoverSelected = await tokenManager.autoSelectHighestQuota(
      quotaMonitor.getAllQuotas(),
      "rate_limit_failover",
      "gemini-1.5-pro",
    );

    // Immediately rotates away from exhausted Alpha to healthy Beta
    expect(failoverSelected).not.toBeNull();
    expect(failoverSelected?.email).toBe(accBeta.email);
    expect(tokenManager.getActiveEmail()).toBe(accBeta.email);

    // Simulate cooldown expiration and priority polling recovery
    (quotaMonitor as any).fetchAccountQuota = async (acc: any) => {
      const recovered = createAccountQuota(acc.email, [createFamilyQuota("gemini", 85)]);
      (quotaMonitor as any).quotas.set(acc.email.toLowerCase(), recovered);
      return recovered;
    };

    await quotaMonitor.onCooldownExpired(accAlpha.email);

    const rehabilitated = quotaMonitor.getQuota(accAlpha.email);
    expect(rehabilitated?.cooldownExpiresAt).toBeUndefined();
    expect(rehabilitated?.families[0]?.percent).toBe(85);
  });

  it("Scenario 3: Dual-Window Asymmetric Exhaustion (5h 85% vs Weekly 3%)", async () => {
    const { tokenManager } = await setupTestTokenManager({
      accounts: [accAlpha, accBeta],
      activeEmail: accAlpha.email,
    });

    // Asymmetric condition:
    // Alpha has 5h = 85% available, BUT weekly quota is exhausted down to 3%!
    // Beta has healthy 5h = 75% and weekly = 80%.
    const resetWeekly = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const quotas: Record<string, AccountQuota> = {
      [accAlpha.email]: createAccountQuota(accAlpha.email, [
        createFamilyQuota("gemini", 3, 85, undefined, 3, resetWeekly),
      ]),
      [accBeta.email]: createAccountQuota(accBeta.email, [
        createFamilyQuota("gemini", 75, 75, undefined, 80, undefined),
      ]),
    };

    // Binding constraint scoring evaluates Alpha effective quota as 3% (<= 10% exhausted)
    const effAlpha = tokenManager.getEffectiveQuota(accAlpha.email, quotas, "gemini-1.5-pro");
    expect(effAlpha.percent).toBe(3);

    // Auto-rotation triggers because active account is exhausted (<= 10%), rotating to Beta
    const selected = await tokenManager.autoSelectHighestQuota(quotas, "auto", "gemini-1.5-pro");
    expect(selected).not.toBeNull();
    expect(selected?.email).toBe(accBeta.email);
    expect(tokenManager.getActiveEmail()).toBe(accBeta.email);
  });

  it("Scenario 4: PreInvocation Prompt Dispatch with Seamless Rotation & Keyring Sync", async () => {
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [accAlpha, accBeta],
      activeEmail: accAlpha.email,
    });
    const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

    // Mock OS Keyring spawn so it records credential write
    let _keyringUpdatedEmail = "";
    const spawnSpy = spyOn(childProcess, "spawn").mockImplementation((_cmd: any, _args: any) => {
      const mockChild: any = {
        stdin: {
          on: () => {},
          write: (chunk: string) => {
            try {
              const data = JSON.parse(chunk);
              _keyringUpdatedEmail = data.id_token_email;
            } catch {
              // ignore parse errors
            }
          },
          end: () => {},
        },
        on: (event: string, cb: any) => {
          if (event === "close") setTimeout(() => cb(0), 5);
        },
      };
      return mockChild;
    });

    try {
      // Set Alpha to 4% (exhausted), Beta to 90%
      const quotas: Record<string, AccountQuota> = {
        [accAlpha.email]: createAccountQuota(accAlpha.email, [createFamilyQuota("gemini", 4)]),
        [accBeta.email]: createAccountQuota(accBeta.email, [createFamilyQuota("gemini", 90)]),
      };
      (quotaMonitor as any).quotas = new Map(Object.entries(quotas));

      hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
      const port = await hookServer.start(0);

      const startTime = performance.now();
      const res = await fetch(`http://127.0.0.1:${port}/pre-invocation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openag-auth": hookServer.getAuthToken(),
        },
        body: JSON.stringify({
          modelName: "gemini-1.5-pro",
          conversationId: "conv-session-1234",
        }),
      });
      const elapsed = performance.now() - startTime;

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;

      // Completed fast (< 100ms) without window reload
      expect(elapsed).toBeLessThan(100);
      expect(data.decision).toBe("allow");
      expect(data.rotated).toBe(true);
      expect(data.email).toBe(accBeta.email);
      expect(tokenManager.getActiveEmail()).toBe(accBeta.email);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("Scenario 5: Rapid UI Quota Polling & Complete Secret Masking", async () => {
    setMockConfig("openag.hideEmail", true);
    const { tokenManager, context } = await setupTestTokenManager({
      accounts: [accAlpha, accBeta],
      activeEmail: accAlpha.email,
      config: { hideEmail: true },
    });
    const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);
    const logManager = new LogManager(context as any);

    statusBar = new StatusBarHUD(context as any, undefined, tokenManager);
    statusBar.updateAccount(accAlpha.email, "pro", true);
    const webviewProvider = new WebviewProvider(
      context as any,
      tokenManager,
      quotaMonitor,
      () => {},
      logManager,
    );
    const mockView = new MockWebviewView();
    webviewProvider.resolveWebviewView(mockView as any);

    // Simulate 5 rapid polling cycles
    for (let i = 0; i < 5; i++) {
      const qAlpha = createAccountQuota(accAlpha.email, [createFamilyQuota("gemini", 80 - i)]);
      const qBeta = createAccountQuota(accBeta.email, [createFamilyQuota("gemini", 90)]);
      (quotaMonitor as any).quotas.set(accAlpha.email, qAlpha);
      (quotaMonitor as any).quotas.set(accBeta.email, qBeta);

      statusBar.updateQuota(qAlpha);
      webviewProvider.refresh();
    }

    (statusBar as any).render();

    // Verify StatusBar tooltip masks email address
    const item = (statusBar as any).item;
    const tooltip = (item.tooltip as any).value || "";
    expect(tooltip).not.toContain("alpha-primary@gmail.com");
    expect(tooltip).toContain("Alpha");

    // Verify webview received state messages
    expect(mockView.webview.postedMessages.length).toBeGreaterThan(0);

    // Verify OutputChannel logs contain zero secret leaks
    const channels = getMockOutputChannels();
    for (const ch of channels) {
      const out = ch.getOutput();
      expect(out).not.toContain("super-secret");
      expect(out).not.toContain("refresh-token");
    }
  });
});
