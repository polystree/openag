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

const { formatDynamicModelName } = await import("../src/core/stats-manager.js");

describe("formatDynamicModelName", () => {
  test("formats new future Gemini models dynamically", () => {
    expect(formatDynamicModelName("Gemini 3.7 Flash High")).toBe("Gemini 3.7 Flash High");
    expect(formatDynamicModelName("Gemini 3.6 Flash Medium")).toBe("Gemini 3.6 Flash Medium");
    expect(formatDynamicModelName("Gemini 4.0 Pro High")).toBe("Gemini 4.0 Pro High");
    expect(formatDynamicModelName("Gemini 4 Flash")).toBe("Gemini 4 Flash");
    expect(formatDynamicModelName("gemini-3.7-flash-high")).toBe("Gemini 3.7 Flash High");
  });

  test("formats new Claude and GPT-OSS models dynamically", () => {
    expect(formatDynamicModelName("Claude Sonnet 4.6 (Thinking)")).toBe("Claude Sonnet 4.6 (Thinking)");
    expect(formatDynamicModelName("Claude Opus 4.6 (Thinking)")).toBe("Claude Opus 4.6 (Thinking)");
    expect(formatDynamicModelName("GPT-OSS 120B (Medium)")).toBe("GPT-OSS 120B (Medium)");
  });

  test("strips system prompt instructions and comments", () => {
    expect(formatDynamicModelName("`Model Selection` from gemini-2.5-pro to Gemini 3.7 Flash (High). No need to comment on this.")).toBe("Gemini 3.7 Flash (High)");
  });

  test("rejects code snippets and regex fragments cleanly without hardcoded fallback", () => {
    expect(formatDynamicModelName("([^.]+\\./i) || text.match(/\"model\":\\s*\"([")).toBe("");
    expect(formatDynamicModelName("const x = { model: 'test' };")).toBe("");
    expect(formatDynamicModelName("")).toBe("");
  });
});
