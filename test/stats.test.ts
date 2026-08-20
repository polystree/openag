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

const { StatsManager, parseTranscriptLines } = await import("../src/core/stats-manager.js");

describe("StatsManager Token Usage Engine", () => {
  // SAFETY: Mock VSCode ExtensionContext for unit testing
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- test double mock
  const fakeContext = {
    globalState: {
      // SAFETY: Map lookup returns stored generic state
      get: <T>(key: string): T | undefined => store.get(key) as T | undefined,
      update: async <T>(key: string, val: T): Promise<void> => {
        store.set(key, val);
      },
    },
  } as unknown as import("vscode").ExtensionContext;

  test("records tokens and updates today stats and conversations accurately", () => {
    store.clear();
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
    store.clear();
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

  test("parseTranscriptLines ignores in-progress active request until it finishes", () => {
    const linesInProgress = [
      JSON.stringify({ step_index: 0, source: "USER_INPUT", type: "USER_INPUT", content: "<USER_REQUEST>Refactor auth logic</USER_REQUEST>" }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "Looking up auth file", tool_calls: [{ name: "view_file", args: {} }] }),
      JSON.stringify({ step_index: 2, source: "MODEL", type: "VIEW_FILE", content: "export function auth() {}" }),
    ];

    const parsedActive = parseTranscriptLines(linesInProgress);
    expect(parsedActive.completedBlocks.length).toBe(0);
    expect(parsedActive.activeBlock).not.toBeNull();
    expect(parsedActive.activeBlock?.isFinished).toBe(false);
    expect(parsedActive.activeBlock?.promptText).toBe("Refactor auth logic");
    expect(parsedActive.completedEndLine).toBe(0);

    // When the final model response arrives with no tool calls, request completes
    const linesCompleted = [
      ...linesInProgress,
      JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", content: "I have refactored the auth logic.", tool_calls: [] }),
    ];

    const parsedDone = parseTranscriptLines(linesCompleted);
    expect(parsedDone.completedBlocks.length).toBe(1);
    expect(parsedDone.activeBlock).toBeNull();
    expect(parsedDone.completedBlocks[0]?.isFinished).toBe(true);
    expect(parsedDone.completedBlocks[0]?.turnCount).toBe(2);
    expect(parsedDone.completedBlocks[0]?.promptText).toBe("Refactor auth logic");
    expect(parsedDone.completedEndLine).toBe(4);
  });

  test("parseTranscriptLines handles multiple requests with trailing active request", () => {
    const lines = [
      // Request 1: Completed
      JSON.stringify({ step_index: 0, source: "USER_INPUT", type: "USER_INPUT", content: "<USER_REQUEST>First prompt</USER_REQUEST>" }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "First answer", tool_calls: [] }),
      // Request 2: Active / in progress
      JSON.stringify({ step_index: 2, source: "USER_INPUT", type: "USER_INPUT", content: "<USER_REQUEST>Second prompt</USER_REQUEST>" }),
      JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", content: "Calling tool", tool_calls: [{ name: "run_command" }] }),
      JSON.stringify({ step_index: 4, source: "MODEL", type: "RUN_COMMAND", content: "Command output" }),
    ];

    const parsed = parseTranscriptLines(lines);
    expect(parsed.completedBlocks.length).toBe(1);
    expect(parsed.completedBlocks[0]?.promptText).toBe("First prompt");
    expect(parsed.completedBlocks[0]?.turnCount).toBe(1);
    expect(parsed.completedEndLine).toBe(2);

    expect(parsed.activeBlock).not.toBeNull();
    expect(parsed.activeBlock?.promptText).toBe("Second prompt");
    expect(parsed.activeBlock?.isFinished).toBe(false);
  });

  test("tracks multiple models accurately within a single session", () => {
    store.clear();
    const manager = new StatsManager(fakeContext, () => {});
    const today = new Date().toISOString().slice(0, 10);

    // Turn 1 with Gemini 3.7 Flash
    manager.recordTokens(today, "gemini-3.7-flash", "conv-multi", "Multi-model session", "", 10000, 500, 8000, 2000, "First turn", Date.now() - 1000, 1);
    // Turn 2 with Claude Opus 4.6
    manager.recordTokens(today, "claude-opus-4-6-thinking", "conv-multi", "Multi-model session", "", 20000, 1000, 15000, 5000, "Second turn", Date.now(), 1);

    const convList = manager.getConversationsList();
    expect(convList.length).toBe(1);
    const conv = convList[0];
    expect(conv?.id).toBe("conv-multi");
    expect(conv?.totalTokens).toBe(31500);
    expect(conv?.turnCount).toBe(2);
    expect(conv?.models).toBeDefined();
    expect(conv?.models?.["Gemini 3.7 Flash"]?.totalTokens).toBe(10500);
    expect(conv?.models?.["Claude Opus 4 6 Thinking"]?.totalTokens).toBe(21000);

    manager.dispose();
  });
});
