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
    if (!fs.existsSync(convDir)) return;
    const dbs = fs.readdirSync(convDir).filter((f: string) => f.endsWith(".db"));
    const firstDb = dbs[0];
    if (!firstDb) return;

    const convId = firstDb.replace(".db", "");
    const result = readGenMetadata(convId);
    if (!result) return;

    expect(result.turns.length).toBeGreaterThan(0);
    expect(result.latestModel).toBeTruthy();
    expect(result.contextTokens).toBeGreaterThan(0);
    expect(result.totalOutputTokens).toBeGreaterThan(0);

    const firstTurn = result.turns[0];
    if (!firstTurn) return;
    expect(firstTurn.idx).toBeGreaterThanOrEqual(0);
    expect(firstTurn.outputTokens).toBeGreaterThan(0);
    expect(firstTurn.model).toBeTruthy();
    expect(firstTurn.requestId).toBeTruthy();
  });

  test("readGenMetadataSince returns only turns after the given index", () => {
    if (!fs.existsSync(convDir)) return;
    const dbs = fs.readdirSync(convDir).filter((f: string) => f.endsWith(".db"));
    const firstDb = dbs[0];
    if (!firstDb) return;

    const convId = firstDb.replace(".db", "");
    const allMetrics = readGenMetadata(convId);
    if (!allMetrics || allMetrics.turns.length < 2) return;

    const midTurn = allMetrics.turns[Math.floor(allMetrics.turns.length / 2)];
    if (!midTurn) return;
    const midIdx = midTurn.idx;
    const partial = readGenMetadataSince(convId, midIdx);

    expect(partial.length).toBeLessThan(allMetrics.turns.length);
    for (const turn of partial) {
      expect(turn.idx).toBeGreaterThan(midIdx);
    }
  });

  test("aggregateBlockTokens correctly filters by turn indices and aggregates metrics", async () => {
    const { aggregateBlockTokens } = await import("../src/core/gen-metadata-reader.js");
    const mockTurns = [
      { idx: 1, model: "gemini-3.7-flash", modelId: 1, newInputTokens: 2000, outputTokens: 200, cachedInputTokens: 50000, thinkingTokens: 0, contentTokens: 200, requestId: "r1", maxOutputTokens: 8192, temperature: 0 },
      { idx: 2, model: "gemini-3.7-flash", modelId: 1, newInputTokens: 500, outputTokens: 300, cachedInputTokens: 52000, thinkingTokens: 0, contentTokens: 300, requestId: "r2", maxOutputTokens: 8192, temperature: 0 },
      { idx: 3, model: "gemini-3.7-flash", modelId: 1, newInputTokens: 1000, outputTokens: 500, cachedInputTokens: 60000, thinkingTokens: 0, contentTokens: 500, requestId: "r3", maxOutputTokens: 8192, temperature: 0 },
    ];

    const block1 = aggregateBlockTokens(mockTurns, 1, 2);
    expect(block1.inputTokens).toBe(52500); // last turn cached (52000) + new (500)
    expect(block1.cacheHitTokens).toBe(52000);
    expect(block1.cacheMissTokens).toBe(500);
    expect(block1.outputTokens).toBe(500); // 200 + 300
    expect(block1.maxGenIdx).toBe(2);

    const block2 = aggregateBlockTokens(mockTurns, 3, 3);
    expect(block2.inputTokens).toBe(61000);
    expect(block2.outputTokens).toBe(500);
    expect(block2.maxGenIdx).toBe(3);
  });
});
