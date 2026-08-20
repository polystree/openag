import * as fs from "node:fs";
import * as path from "node:path";
import { CONV_DIR, loadSqlite } from "./sqlite-utils.js";

export interface GenTurnMetrics {
  idx: number;
  model: string;
  modelId: number;
  newInputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  thinkingTokens: number;
  contentTokens: number;
  requestId: string;
  maxOutputTokens: number;
  temperature: number;
}

export interface GenConversationMetrics {
  turns: GenTurnMetrics[];
  latestModel: string;
  contextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
}

function decodeVarint(buf: Buffer, offset: number): { value: number; offset: number } | null {
  let result = 0;
  let shift = 0;
  while (offset < buf.length) {
    const byte = buf[offset++]!;
    result |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) return { value: result >>> 0, offset };
    if (shift >= 35) return null;
  }
  return null;
}

interface ProtoField {
  type: "varint" | "string" | "message" | "float64";
  value: number | string | Map<number, ProtoField[]>;
}

function decodeMessage(buf: Buffer, start: number, end: number): Map<number, ProtoField[]> {
  const fields = new Map<number, ProtoField[]>();
  let pos = start;
  while (pos < end) {
    const tag = decodeVarint(buf, pos);
    if (!tag) break;
    pos = tag.offset;
    const fieldNum = tag.value >>> 3;
    const wireType = tag.value & 7;

    if (wireType === 0) {
      const val = decodeVarint(buf, pos);
      if (!val) break;
      pos = val.offset;
      const arr = fields.get(fieldNum) ?? [];
      arr.push({ type: "varint", value: val.value });
      fields.set(fieldNum, arr);
    } else if (wireType === 2) {
      const len = decodeVarint(buf, pos);
      if (!len) break;
      pos = len.offset;
      const sub = buf.subarray(pos, pos + len.value);
      const arr = fields.get(fieldNum) ?? [];
      const printable = sub.length < 300 && sub.every((b: number) => (b >= 0x20 && b <= 0x7e) || b === 0x0a || b === 0x0d);
      if (printable) {
        arr.push({ type: "string", value: sub.toString("utf-8") });
      } else {
        arr.push({ type: "message", value: decodeMessage(buf, pos, pos + len.value) });
      }
      fields.set(fieldNum, arr);
      pos += len.value;
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      const val = buf.readDoubleLE(pos);
      const arr = fields.get(fieldNum) ?? [];
      arr.push({ type: "float64", value: val });
      fields.set(fieldNum, arr);
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function getVarint(msg: Map<number, ProtoField[]>, field: number): number {
  const arr = msg.get(field);
  if (!arr || arr.length === 0) return 0;
  const entry = arr[0]!;
  // SAFETY: discriminated on entry.type === "varint", value is always number
  return entry.type === "varint" ? (entry.value as number) : 0;
}

function getString(msg: Map<number, ProtoField[]>, field: number): string {
  const arr = msg.get(field);
  if (!arr || arr.length === 0) return "";
  const entry = arr[0]!;
  // SAFETY: discriminated on entry.type === "string", value is always string
  return entry.type === "string" ? (entry.value as string) : "";
}

function getFloat64(msg: Map<number, ProtoField[]>, field: number): number {
  const arr = msg.get(field);
  if (!arr || arr.length === 0) return 0;
  const entry = arr[0]!;
  // SAFETY: discriminated on entry.type === "float64", value is always number
  return entry.type === "float64" ? (entry.value as number) : 0;
}

function getSubmsg(msg: Map<number, ProtoField[]>, field: number): Map<number, ProtoField[]> | null {
  const arr = msg.get(field);
  if (!arr || arr.length === 0) return null;
  const entry = arr[0]!;
  // SAFETY: discriminated on entry.type === "message", value is always Map
  return entry.type === "message" ? (entry.value as Map<number, ProtoField[]>) : null;
}

function parseTurnFromBlob(buf: Buffer): GenTurnMetrics | null {
  const top = decodeMessage(buf, 0, buf.length);
  const gen = getSubmsg(top, 1);
  if (!gen) return null;

  const tokenMsg = getSubmsg(gen, 4);
  if (!tokenMsg) return null;

  const modelId = getVarint(tokenMsg, 1);
  const newInputTokens = getVarint(tokenMsg, 2);
  const outputTokens = getVarint(tokenMsg, 3);
  const cachedInputTokens = getVarint(tokenMsg, 5);
  const thinkingTokens = getVarint(tokenMsg, 9);
  const contentTokens = getVarint(tokenMsg, 10);
  const requestId = getString(tokenMsg, 11);

  const model = getString(gen, 19) || getString(gen, 21) || "";

  const cfgMsg = getSubmsg(gen, 15);
  const maxOutputTokens = cfgMsg ? getVarint(cfgMsg, 2) : 0;
  const temperature = cfgMsg ? getFloat64(cfgMsg, 5) : 0;

  return {
    idx: 0,
    model,
    modelId,
    newInputTokens,
    outputTokens,
    cachedInputTokens,
    thinkingTokens,
    contentTokens,
    requestId,
    maxOutputTokens,
    temperature,
  };
}

interface GenRow { idx: number; data?: Uint8Array | Buffer }

function queryGenRows(conversationId: string, sinceIdx?: number): GenRow[] {
  const dbPath = path.join(CONV_DIR, `${conversationId}.db`);
  if (!fs.existsSync(dbPath)) return [];

  const sqlite = loadSqlite();
  if (!sqlite) return [];

  try {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true, open: true });
    const rows = sinceIdx !== undefined
      ? db.prepare("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx ASC").all<GenRow>(sinceIdx)
      : db.prepare("SELECT idx, data FROM gen_metadata ORDER BY idx ASC").all<GenRow>();
    db.close();
    return rows;
  } catch {
    return [];
  }
}

function parseRows(rows: GenRow[]): GenTurnMetrics[] {
  const turns: GenTurnMetrics[] = [];
  for (const row of rows) {
    if (!row.data) continue;
    const turn = parseTurnFromBlob(Buffer.from(row.data));
    if (!turn) continue;
    turn.idx = row.idx;
    turns.push(turn);
  }
  return turns;
}

export function readGenMetadata(conversationId: string): GenConversationMetrics | null {
  const rows = queryGenRows(conversationId);
  if (rows.length === 0) return null;

  const turns = parseRows(rows);
  if (turns.length === 0) return null;

  let latestModel = "";
  let totalInput = 0;
  let totalOutput = 0;

  for (const turn of turns) {
    if (turn.model) latestModel = turn.model;
    totalInput += turn.newInputTokens;
    totalOutput += turn.outputTokens;
  }

  const lastTurn = turns[turns.length - 1]!;
  const totalCached = lastTurn.cachedInputTokens;

  return {
    turns,
    latestModel,
    contextTokens: lastTurn.cachedInputTokens + lastTurn.newInputTokens,
    totalInputTokens: totalInput + totalCached,
    totalOutputTokens: totalOutput,
    totalCachedTokens: totalCached,
  };
}

export function readGenMetadataSince(conversationId: string, sinceIdx: number): GenTurnMetrics[] {
  return parseRows(queryGenRows(conversationId, sinceIdx));
}

export interface BlockTokens {
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  model: string;
  maxGenIdx: number;
}

export function aggregateBlockTokens(turns: GenTurnMetrics[], startLine: number, endLine: number): BlockTokens {
  const result: BlockTokens = { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, model: "", maxGenIdx: 0 };
  for (const turn of turns) {
    if (turn.idx < startLine || turn.idx > endLine) continue;
    result.inputTokens = turn.cachedInputTokens + turn.newInputTokens;
    result.outputTokens += turn.outputTokens;
    result.cacheHitTokens = turn.cachedInputTokens;
    result.cacheMissTokens = turn.newInputTokens;
    if (turn.model) result.model = turn.model;
    if (turn.idx > result.maxGenIdx) result.maxGenIdx = turn.idx;
  }
  return result;
}
