import { describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

const { readGenMetadata, readGenMetadataSince } = await import("../src/core/gen-metadata-reader.js");

describe("GenMetadataReader", () => {
  const convDir = path.join(os.homedir(), ".gemini", "antigravity-ide", "conversations");

  test("readGenMetadata returns null for non-existent conversation", () => {
    const result = readGenMetadata("non-existent-conversation-id");
    expect(result).toBeNull();
  });

  test("readGenMetadataSince returns empty array for non-existent conversation", () => {
    const result = readGenMetadataSince("non-existent-conversation-id", 0);
    expect(result).toEqual([]);
  });

  test("readGenMetadata extracts token counts from real conversation database", () => {
    const dbs = fs.readdirSync(convDir).filter((f: string) => f.endsWith(".db"));
    if (dbs.length === 0) return;

    const convId = dbs[0]!.replace(".db", "");
    const result = readGenMetadata(convId);
    if (!result) return;

    expect(result.turns.length).toBeGreaterThan(0);
    expect(result.latestModel).toBeTruthy();
    expect(result.contextTokens).toBeGreaterThan(0);
    expect(result.totalOutputTokens).toBeGreaterThan(0);

    const firstTurn = result.turns[0]!;
    expect(firstTurn.idx).toBeGreaterThanOrEqual(0);
    expect(firstTurn.outputTokens).toBeGreaterThan(0);
    expect(firstTurn.model).toBeTruthy();
    expect(firstTurn.requestId).toBeTruthy();
  });

  test("readGenMetadataSince returns only turns after the given index", () => {
    const dbs = fs.readdirSync(convDir).filter((f: string) => f.endsWith(".db"));
    if (dbs.length === 0) return;

    const convId = dbs[0]!.replace(".db", "");
    const allMetrics = readGenMetadata(convId);
    if (!allMetrics || allMetrics.turns.length < 2) return;

    const midIdx = allMetrics.turns[Math.floor(allMetrics.turns.length / 2)]!.idx;
    const partial = readGenMetadataSince(convId, midIdx);

    expect(partial.length).toBeLessThan(allMetrics.turns.length);
    for (const turn of partial) {
      expect(turn.idx).toBeGreaterThan(midIdx);
    }
  });
});
