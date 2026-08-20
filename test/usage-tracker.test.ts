import { describe, expect, mock, test } from "bun:test";

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

const { UsageTracker } = await import("../src/core/usage-tracker.js");

describe("UsageTracker", () => {
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
