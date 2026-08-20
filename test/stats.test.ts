import { describe, expect, mock, test } from "bun:test";

let store: Record<string, unknown> = {};

mock.module("vscode", () => ({
  EventEmitter: class {
    private listeners: Array<(arg: unknown) => void> = [];
    public event = (fn: (arg: unknown) => void) => {
      this.listeners.push(fn);
      return { dispose: () => {} };
    };
    public fire = (val: unknown) => {
      for (const fn of this.listeners) fn(val);
    };
    public dispose = () => {
      this.listeners = [];
    };
  },
}));

const { StatsManager } = await import("../src/core/stats-manager.js");

describe("StatsManager Token Usage Engine", () => {
  const fakeContext = {
    globalState: {
      get: <T>(key: string): T | undefined => store[key] as T | undefined,
      update: async (key: string, val: unknown) => {
        store[key] = val;
      },
    },
  } as unknown as import("vscode").ExtensionContext;

  test("records tokens and updates today stats and conversations accurately", () => {
    store = {};
    const manager = new StatsManager(fakeContext, () => {});
    const today = new Date().toISOString().slice(0, 10);

    manager.recordTokens(today, "Gemini 3.7 Flash High", "conv-1", "Fix database connection", "", 45000, 2200, 40000, 5000, "Fix database connection", Date.now(), 4);
    const todayStats = manager.getTodayStats();

    expect(todayStats.totalTokens).toBe(47200);
    expect(todayStats.inputTokens).toBe(45000);
    expect(todayStats.outputTokens).toBe(2200);
    expect(todayStats.cacheHitTokens).toBe(40000);
    expect(todayStats.cacheMissTokens).toBe(5000);
    expect(todayStats.models["Gemini 3.7 Flash High"]?.totalTokens).toBe(47200);

    const convList = manager.getConversationsList();
    expect(convList.length).toBe(1);
    expect(convList[0]?.id).toBe("conv-1");
    expect(convList[0]?.title).toBe("Fix database connection");
    expect(convList[0]?.cacheHitTokens).toBe(40000);
    expect(convList[0]?.turnCount).toBe(4);

    const reqList = manager.getRequestsList();
    expect(reqList.length).toBe(1);
    expect(reqList[0]?.promptPreview).toBe("Fix database connection");
    expect(reqList[0]?.turnCount).toBe(4);

    manager.dispose();
  });

  test("aggregates daily and weekly rollups with cache metrics", () => {
    store = {};
    const manager = new StatsManager(fakeContext, () => {});

    manager.recordTokens("2026-08-18", "Gemini 3.6 Flash Medium", "c1", "Audit code", "", 30000, 1500, 25000, 5000);
    manager.recordTokens("2026-08-19", "Claude Sonnet 4.6 (Thinking)", "c2", "Refactor UI", "", 50000, 2500, 45000, 5000);

    const daily = manager.getDailyStats(7);
    expect(daily.length).toBe(7);

    const weekly = manager.getWeeklyStats(4);
    expect(weekly.length).toBe(4);

    const monthly = manager.getMonthlyStats(12);
    expect(monthly.length).toBe(12);

    const allTime = manager.getAllTimeSummary();
    expect(allTime.totalTokens).toBe(84000);
    expect(allTime.inputTokens).toBe(80000);
    expect(allTime.outputTokens).toBe(4000);
    expect(allTime.cacheHitTokens).toBe(70000);
    expect(allTime.cacheHitRate).toBe(87.5);
    expect(allTime.totalTurns).toBe(2);

    const hourly = manager.getTodayHourlyStats();
    expect(Array.isArray(hourly)).toBe(true);
    expect(hourly.length).toBeGreaterThan(0);
    expect(hourly[0]?.hourLabel).toBe("00:00");
    manager.dispose();
  });
});
