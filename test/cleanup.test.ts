import { describe, expect, mock, test } from "bun:test";

const store = new Map<string, unknown>();

mock.module("vscode", () => ({
  EventEmitter: class<T = void> {
    private listeners: Array<(arg: T) => void> = [];
    public event = (fn: (arg: T) => void) => {
      this.listeners.push(fn);
      return { dispose: () => {} };
    };
    public fire = (val: T) => {
      for (const fn of this.listeners) fn(val);
    };
    public dispose = () => {
      this.listeners = [];
    };
  },
}));

const { LogManager } = await import("../src/core/log-manager.js");
const { QuotaMonitor } = await import("../src/core/quota-monitor.js");
const { StatsManager } = await import("../src/core/stats-manager.js");

interface LogManagerFixture {
  logs: Array<{ id: string; timestamp: number; level: string; category: string; message: string }>;
}

interface QuotaMonitorFixture {
  quotas: Map<string, unknown>;
}

describe("Database & Cache Cleanup Engine", () => {
  // SAFETY: Mock VSCode ExtensionContext for unit testing
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double mock
  const fakeContext = {
    globalState: {
      // SAFETY: Map lookup returns stored generic state
      get: <T>(key: string, def?: T): T => (store.has(key) ? (store.get(key) as T) : (def as T)),
      update: async <T>(key: string, val: T): Promise<void> => {
        store.set(key, val);
      },
    },
  } as unknown as import("vscode").ExtensionContext;

  test("LogManager purges logs older than 24h", () => {
    store.clear();
    const logMgr = new LogManager(fakeContext);
    const now = Date.now();
    // SAFETY: test fixture injecting mock logs directly into instance
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test fixture access
    const testLogMgr = logMgr as unknown as LogManagerFixture;
    testLogMgr.logs = [
      { id: "old", timestamp: now - 25 * 3600 * 1000, level: "info", category: "SYSTEM", message: "old message" },
      { id: "new", timestamp: now - 1 * 3600 * 1000, level: "info", category: "SYSTEM", message: "recent message" },
    ];

    logMgr.cleanupLogs();
    const logs = logMgr.getLogs();
    expect(logs.length).toBe(1);
    expect(logs[0]?.id).toBe("new");
    logMgr.dispose();
  });

  test("QuotaMonitor cleans up quota caches older than 5h", () => {
    store.clear();
    const fakeTokenMgr = {
      isExtensionEnabled: () => true,
      isRotationEnabled: () => true,
      getAccounts: () => [],
      getActiveAccount: () => undefined,
      autoSelectHighestQuota: () => {},
    };

    // SAFETY: Mock TokenManager interface for QuotaMonitor test
    const quotaMon = new QuotaMonitor(fakeTokenMgr as never, () => {}, undefined, undefined, fakeContext);
    const now = Date.now();

    // SAFETY: test fixture injecting mock quotas directly into instance
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test fixture access
    const testQuotaMon = quotaMon as unknown as QuotaMonitorFixture;
    testQuotaMon.quotas.set("stale@gmail.com", {
      email: "stale@gmail.com",
      tier: "pro",
      families: [],
      models: [],
      lastUpdated: now - 6 * 3600 * 1000,
    });
    testQuotaMon.quotas.set("fresh@gmail.com", {
      email: "fresh@gmail.com",
      tier: "pro",
      families: [],
      models: [],
      lastUpdated: now - 2 * 3600 * 1000,
    });

    quotaMon.cleanupExpiredQuotas();
    const all = quotaMon.getAllQuotas();
    expect(all["stale@gmail.com"]).toBeUndefined();
    expect(all["fresh@gmail.com"]).toBeDefined();
    quotaMon.dispose();
  });

  test("StatsManager cleans up requests older than 7d", () => {
    store.clear();
    const statsMgr = new StatsManager(fakeContext, () => {});
    const now = Date.now();

    statsMgr.recordTokens("2026-08-20", "Gemini 3.7 Flash", "conv-old", "Old prompt", "", 100, 50, 80, 20, "Old prompt", now - 8 * 24 * 3600 * 1000);
    statsMgr.recordTokens("2026-08-20", "Gemini 3.7 Flash", "conv-recent", "Recent prompt", "", 100, 50, 80, 20, "Recent prompt", now - 1 * 24 * 3600 * 1000);

    statsMgr.cleanupStaleStats();
    const reqs = statsMgr.getRequestsList();
    expect(reqs.length).toBe(1);
    expect(reqs[0]?.promptPreview).toBe("Recent prompt");
    statsMgr.dispose();
  });

  test("StatsManager preserves distinct request cards for identical prompts across sessions", () => {
    store.clear();
    const statsMgr = new StatsManager(fakeContext, () => {});
    const now = Date.now();

    // Two identical prompts 2 hours apart should not collapse into one
    statsMgr.recordTokens("2026-08-20", "Gemini 3.7 Flash", "conv-1", "Fix database connection", "", 100, 50, 80, 20, "Fix database connection", now - 7200000);
    statsMgr.recordTokens("2026-08-20", "Gemini 3.7 Flash", "conv-2", "Fix database connection", "", 200, 100, 160, 40, "Fix database connection", now);

    const reqs = statsMgr.getRequestsList();
    expect(reqs.length).toBe(2);
    expect(reqs[0]?.totalTokens).toBe(300);
    expect(reqs[1]?.totalTokens).toBe(150);
    statsMgr.dispose();
  });
});

