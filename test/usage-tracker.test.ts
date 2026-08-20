import { describe, expect, mock, test } from "bun:test";

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

const { countBpeTokens, UsageTracker } = await import("../src/core/usage-tracker.js");

describe("UsageTracker & BPE Tokenizer", () => {
  test("countBpeTokens calculates accurate tokens for plain text and code", () => {
    expect(countBpeTokens("")).toBe(0);
    expect(countBpeTokens("Hello world")).toBe(2);
    expect(countBpeTokens("const x = 42;")).toBe(6);
    const code = `function calculate(a: number, b: number): number {
      return a + b * 100;
    }`;
    const tokens = countBpeTokens(code);
    expect(tokens).toBeGreaterThan(10);
    expect(tokens).toBeLessThan(30);
  });

  test("getModelContextLimit returns correct context limits", () => {
    const tracker = new UsageTracker();
    expect(tracker.getModelContextLimit("gemini-3.7-flash")).toBe(1048576);
    expect(tracker.getModelContextLimit("gemini-2.5-pro")).toBe(1048576);
    expect(tracker.getModelContextLimit("claude-3-7-sonnet")).toBe(200000);
    expect(tracker.getModelContextLimit("gpt-oss-128k")).toBe(128000);
    expect(tracker.getModelContextLimit("gpt-4o")).toBe(128000);
    tracker.dispose();
  });
});
