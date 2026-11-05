import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { BurnRateInfo, ConversationStats, DayTokenStats, HourlyTokenStats, MonthTokenStats, RequestStats, TokenBucket, TokenStatsRegistry, WeekTokenStats } from "../types.js";
import { aggregateBlockTokens, readGenMetadata } from "./gen-metadata-reader.js";
import { CONV_DIR, getBrainDirs, resolveConversationDb, resolveTranscriptPath, withSqliteDb } from "./sqlite-utils.js";

const STATS_KEY = "openag_token_stats_v8";
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

function parseTitleFromBuffer(buf: Buffer): string | null {
  for (let i = 0; i < buf.length - 10; i++) {
    if (buf[i] !== 0x22) continue;
    const len = buf[i + 1];
    if (!len || len < 3 || len > 80 || i + 2 + len >= buf.length || buf[i + 2 + len] !== 0x48) continue;
    const cand = buf.subarray(i + 2, i + 2 + len).toString("utf8").trim();
    if (
      cand.length >= 3 &&
      !cand.includes("sessionID") &&
      !cand.includes("$") &&
      !cand.includes("file:") &&
      !cand.includes("{") &&
      !cand.includes("=") &&
      !cand.includes("return") &&
      !cand.includes(";")
    ) {
      return cand;
    }
  }
  return null;
}

const subagentTitleCache = new Map<string, string>();

export function extractSubagentTitle(convId: string): string | null {
  const cleanId = convId.endsWith(".db") ? convId.slice(0, -3) : convId;
  const cached = subagentTitleCache.get(cleanId);
  if (cached) return cached;

  for (const brainDir of getBrainDirs()) {
    try {
      if (!fs.existsSync(brainDir)) continue;
      const parentDirs = fs.readdirSync(brainDir, { withFileTypes: true });
      for (const p of parentDirs) {
        if (!p.isDirectory()) continue;
        const subagentsDir = path.join(brainDir, p.name, ".system_generated", "subagents");
        if (fs.existsSync(subagentsDir)) {
          const files = fs.readdirSync(subagentsDir);
          const match = files.find((f) => f === `${cleanId}.json` || f.startsWith(`${cleanId}-`));
          if (match) {
            const raw = fs.readFileSync(path.join(subagentsDir, match), "utf8");
            const parsed = JSON.parse(raw) as { subagentDescriptor?: { role?: string; typeName?: string } };
            const title = parsed.subagentDescriptor?.role
              ? `Subagent: ${parsed.subagentDescriptor.role}`
              : parsed.subagentDescriptor?.typeName
                ? `Subagent: ${parsed.subagentDescriptor.typeName}`
                : null;
            if (title) {
              subagentTitleCache.set(cleanId, title);
              return title;
            }
          }
        }
      }
    } catch { /* ignore filesystem errors */ }
  }

  const transcriptPath = resolveTranscriptPath(cleanId);
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const fd = fs.openSync(transcriptPath, "r");
      const buf = Buffer.alloc(8192);
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      if (bytesRead > 0) {
        const chunk = buf.toString("utf8", 0, bytesRead);
        const firstLine = chunk.split("\n")[0];
        if (firstLine) {
          const obj = JSON.parse(firstLine) as { content?: string };
          const content = obj.content || "";
          const youAreMatch = content.match(/You are ([a-zA-Z0-9_-]+)/i);
          if (youAreMatch?.[1]) {
            const roleName = youAreMatch[1]
              .replace(/^teamwork_/i, "")
              .replace(/[_-]+/g, " ")
              .trim()
              .replace(/\b\w/g, (c) => c.toUpperCase());
            const title = `Subagent: ${roleName}`;
            subagentTitleCache.set(cleanId, title);
            return title;
          }
          const roleMatch = content.match(/Role\s*[:=]\s*"?([^"\r\n]+)"?/i) ||
            content.match(/role\s*[:=]\s*"?([^"\r\n]+)"?/i);
          if (roleMatch?.[1]) {
            const title = `Subagent: ${roleMatch[1].trim()}`;
            subagentTitleCache.set(cleanId, title);
            return title;
          }
          const promptMatch = content.match(/content=([^\r\n]+)/i);
          if (promptMatch?.[1] && promptMatch[1].length > 5) {
            const title = `Subagent: ${promptMatch[1].trim().slice(0, 50)}`;
            subagentTitleCache.set(cleanId, title);
            return title;
          }
        }
      }
    } catch { /* ignore */ }
  }

  return null;
}

export function extractFirstPromptFromTranscript(convId: string): string | null {
  const cleanId = convId.endsWith(".db") ? convId.slice(0, -3) : convId;
  const transcriptPath = resolveTranscriptPath(cleanId);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.split("\n").slice(0, 15);
    for (const line of lines) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as { source?: string; type?: string; content?: string };
      if (obj.type === "USER_INPUT" || obj.source === "USER_EXPLICIT") {
        const raw = String(obj.content || "");
        const reqMatch = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
        const text = (reqMatch ? reqMatch[1] : raw) || "";
        const clean = text
          .replace(/<[^>]+>/g, "")
          .replace(/[\r\n\t]+/g, " ")
          .trim();
        if (clean.length > 2) {
          return clean.slice(0, 55);
        }
      }
    }
  } catch { /* ignore filesystem errors */ }

  return null;
}

export function extractAntigravityTitle(convId: string, fallbackPrompt = ""): string {
  const dbPath = resolveConversationDb(convId) || path.join(CONV_DIR, `${convId}.db`);
  if (fs.existsSync(dbPath)) {
    const foundTitle = withSqliteDb(dbPath, (db) => {
      const rows = db.prepare("SELECT idx, step_payload FROM steps WHERE step_type = 23 ORDER BY idx ASC").all<{ idx: number; step_payload?: Uint8Array | Buffer }>();
      for (const r of rows) {
        if (!r.step_payload) continue;
        const found = parseTitleFromBuffer(Buffer.from(r.step_payload));
        if (found) return found;
      }
      return null;
    });

    if (foundTitle) return foundTitle;
  }

  const subagentTitle = extractSubagentTitle(convId);
  if (subagentTitle) return subagentTitle;

  const promptTitle = extractFirstPromptFromTranscript(convId);
  if (promptTitle) return promptTitle;

  if (fallbackPrompt) {
    const clean = fallbackPrompt.replace(/[\r\n]+/g, " ").trim();
    if (clean.length > 0) return clean.slice(0, 60);
  }

  return convId.slice(0, 8);
}

export function formatDynamicModelName(raw: string): string {
  if (!raw) return "";
  let s = raw.trim();

  // Strip prompt artifacts, model selection tags, and instructions
  s = s.replace(/`?Model Selection`? from [^`\r\n]+? to /i, "");
  s = s.replace(/\.\s+No need to comment.*$/i, "");
  s = s.replace(/^[#`*\s]+|[#`*.;\r\n\s]+$/g, "").trim();

  // Reject code snippets / regex strings
  if (/[{}<>;=\\/]/.test(s) || s.length > 50 || s.length < 2) {
    return "";
  }

  // Handle hyphenated IDs like gemini-3.7-flash-high or claude-sonnet-4-6
  if (/^[a-z0-9]+(?:[-_][a-z0-9.]+)+$/i.test(s)) {
    return s
      .split(/[-_]/)
      .map((w) => (w.toLowerCase() === "gpt" || w.toLowerCase() === "oss" ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join(" ");
  }

  return s.replace(/\s+/g, " ");
}

function createEmptyBucket(): TokenBucket {
  return { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0, thinkingTokens: 0, contentTokens: 0 };
}

function addToBucket(
  target: TokenBucket,
  add: {
    input?: number;
    output?: number;
    cacheHit?: number;
    cacheMiss?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    thinkingTokens?: number;
    contentTokens?: number;
  },
): void {
  const inp = add.input ?? add.inputTokens ?? 0;
  const out = add.output ?? add.outputTokens ?? 0;
  const hit = add.cacheHit ?? add.cacheHitTokens ?? 0;
  const mis = add.cacheMiss ?? add.cacheMissTokens ?? Math.max(0, inp - hit);
  const thk = add.thinkingTokens ?? 0;
  const cnt = add.contentTokens ?? Math.max(0, out - thk);
  target.inputTokens += inp;
  target.outputTokens += out;
  target.cacheHitTokens += hit;
  target.cacheMissTokens += mis;
  target.totalTokens += inp + out;
  target.thinkingTokens = (target.thinkingTokens || 0) + thk;
  target.contentTokens = (target.contentTokens || 0) + cnt;
}

function getTodayString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export interface RequestBlock {
  startLine: number;
  endLine: number;
  startTurnIdx: number;
  endTurnIdx: number;
  timestamp: number;
  promptText: string;
  turnCount: number;
  detectedModel: string;
  isFinished: boolean;
}

export interface ParsedTranscript {
  detectedModel: string;
  initialPrompt: string;
  completedBlocks: RequestBlock[];
  activeBlock: RequestBlock | null;
  completedEndLine: number;
  rateLimitErrorLine: number;
  rateLimitErrorDetail: string;
}

export function parseTranscriptLines(
  lines: string[],
  fallbackPrompt = "",
  convTitle = "",
): ParsedTranscript {
  let detectedModel = "";
  let initialPrompt = fallbackPrompt;
  const completedBlocks: RequestBlock[] = [];
  let currentBlock: RequestBlock | null = null;
  let completedEndLine = 0;
  let modelTurnCount = 0;
  let rateLimitErrorLine = -1;
  let rateLimitErrorDetail = "";

  if (!initialPrompt && lines.length > 0 && lines[0]) {
    try {
      // SAFETY: Transcript JSON line parsing for initial prompt extraction
      const firstObj = JSON.parse(lines[0]) as { content?: string };
      if (firstObj.content) {
        const reqMatch = firstObj.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
        if (reqMatch?.[1]) {
          initialPrompt = reqMatch[1].trim().replace(/[\r\n]+/g, " ").slice(0, 75);
        } else if (firstObj.content.includes("<SYSTEM_MESSAGE>")) {
          const youAreMatch = firstObj.content.match(/You are ([a-zA-Z0-9_-]+)/i);
          if (youAreMatch?.[1]) {
            const roleName = youAreMatch[1]
              .replace(/^teamwork_/i, "")
              .replace(/[_-]+/g, " ")
              .trim()
              .replace(/\b\w/g, (c) => c.toUpperCase());
            initialPrompt = `Subagent: ${roleName}`;
          } else {
            const msgMatch = firstObj.content.match(/content=([^\r\n]+)/i);
            if (msgMatch?.[1] && msgMatch[1].trim().length > 3) {
              initialPrompt = msgMatch[1].trim().replace(/[\r\n]+/g, " ").slice(0, 75);
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    try {
      // SAFETY: Transcript JSONL line structure with optional metadata fields
      const obj = JSON.parse(line) as {
        type?: string;
        source?: string;
        content?: string;
        tool_calls?: unknown[];
        created_at?: string;
        status?: string;
      };

      // Only recognize true SYSTEM/MODEL execution errors indicating rate limit / quota exhaustion
      if (
        obj.status === "ERROR" &&
        obj.source !== "USER_INPUT" &&
        obj.source !== "USER_EXPLICIT" &&
        obj.type !== "USER_INPUT"
      ) {
        const rawContent = obj.content || "";
        if (
          rawContent.includes("RESOURCE_EXHAUSTED") ||
          rawContent.includes("RATE_LIMIT_EXCEEDED") ||
          rawContent.includes("Quota exceeded") ||
          rawContent.includes("quota exceeded")
        ) {
          rateLimitErrorLine = i;
          rateLimitErrorDetail = rawContent.slice(0, 150);
        }
      }

      if (obj.source !== "MODEL" && obj.content) {
        const mMatch = obj.content.match(/`?Model Selection`? from [^`\r\n]+? to ([^\r\n`]+?)(?:\.\s+No need|\.\s*$|$)/i);
        if (mMatch?.[1]) {
          const parsed = formatDynamicModelName(mMatch[1]);
          if (parsed) detectedModel = parsed;
        }
      }

      if (obj.type === "CHECKPOINT" || obj.content?.includes("{{ CHECKPOINT")) {
        continue;
      }

      if (obj.source === "USER_INPUT" || obj.source === "USER_EXPLICIT" || obj.type === "USER_INPUT") {
        if (currentBlock && currentBlock.turnCount > 0) {
          currentBlock.endLine = i;
          currentBlock.isFinished = true;
          completedBlocks.push(currentBlock);
          completedEndLine = i;
        }

        const text = obj.content || "";
        const req = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
        const pText = (req?.[1] || text).trim().replace(/[\r\n]+/g, " ").slice(0, 80);
        const reqTime = obj.created_at ? Date.parse(obj.created_at) : Date.now();

        currentBlock = {
          startLine: i,
          endLine: i + 1,
          startTurnIdx: -1,
          endTurnIdx: -1,
          timestamp: reqTime,
          promptText: pText || "User Prompt",
          turnCount: 0,
          detectedModel,
          isFinished: false,
        };
      } else if (obj.type === "PLANNER_RESPONSE" || (!obj.type && obj.source === "MODEL")) {
        const turnIdx = modelTurnCount;
        modelTurnCount += 1;
        const stepTime = obj.created_at ? Date.parse(obj.created_at) : Date.now();
        if (!currentBlock) {
          currentBlock = {
            startLine: i,
            endLine: i + 1,
            startTurnIdx: turnIdx,
            endTurnIdx: turnIdx,
            timestamp: stepTime,
            promptText: initialPrompt || convTitle || "Initial Request",
            turnCount: 0,
            detectedModel,
            isFinished: false,
          };
        }

        if (currentBlock.startTurnIdx < 0) {
          currentBlock.startTurnIdx = turnIdx;
        }
        currentBlock.endTurnIdx = turnIdx;
        currentBlock.turnCount += 1;
        currentBlock.detectedModel = detectedModel;
        currentBlock.endLine = i + 1;

        const hasToolCalls = Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
        const isRunning = obj.status === "RUNNING";
        currentBlock.isFinished = !hasToolCalls && !isRunning;
      } else {
        if (obj.source !== "SYSTEM" && obj.type !== "CHECKPOINT") {
          if (currentBlock) {
            currentBlock.isFinished = false;
            currentBlock.endLine = i + 1;
          }
        }
      }
    } catch { /* ignore */ }
  }

  let activeBlock: RequestBlock | null = null;
  if (currentBlock) {
    if (currentBlock.isFinished && currentBlock.turnCount > 0) {
      currentBlock.endLine = lines.length;
      completedBlocks.push(currentBlock);
      completedEndLine = lines.length;
    } else {
      activeBlock = currentBlock;
    }
  }

  return {
    detectedModel,
    initialPrompt,
    completedBlocks,
    activeBlock,
    completedEndLine,
    rateLimitErrorLine,
    rateLimitErrorDetail,
  };
}

export class StatsManager {
  private registry: TokenStatsRegistry;
  private readonly onStatsChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onStatsChange = this.onStatsChangeEmitter.event;
  private persistDebounce: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void,
  ) {
    const raw = this.context.globalState.get<TokenStatsRegistry>(STATS_KEY);
    this.registry = raw?.days ? raw : { days: {}, conversations: {}, requests: [], lastUpdated: Date.now() };
    if (!Array.isArray(this.registry.requests)) this.registry.requests = [];
    this.cleanupStaleStats();
    this.cleanupTimer = setInterval(() => this.cleanupStaleStats(), 3600000);
  }

  public cleanupStaleStats(): void {
    const cutoff = Date.now() - SEVEN_DAYS;
    this.registry.requests = (this.registry.requests || []).filter((r) => (r.timestamp || 0) >= cutoff);
    this.pruneRequests();
    if (this.registry.conversations) {
      for (const [id, c] of Object.entries(this.registry.conversations)) {
        if (c && (c.lastActive || 0) < cutoff && (c.totalTokens || 0) === 0) {
          delete this.registry.conversations[id];
        }
      }
    }
    this.schedulePersist();
  }

  public recordTokens(
    dateStr: string,
    rawModelName: string,
    convId: string,
    convTitle: string,
    workspacePath: string,
    inputTokens: number,
    outputTokens: number,
    cacheHitTokens: number,
    cacheMissTokens: number,
    promptPreview = "",
    timestamp = Date.now(),
    turnCount = 1,
    thinkingTokens = 0,
    contentTokens = 0,
  ): void {
    if (inputTokens <= 0 && outputTokens <= 0) return;

    const date = dateStr || getTodayString();
    const cleanModel = formatDynamicModelName(rawModelName) || rawModelName || "Unknown Model";
    const cid = convId || "default";
    const title = convTitle || extractAntigravityTitle(cid, promptPreview);

    const cleanPrompt = promptPreview ? promptPreview.slice(0, 80) : "";
    const existingReq = cleanPrompt
      ? this.registry.requests.find(
          (r) =>
            r.promptPreview === cleanPrompt &&
            Math.abs(r.timestamp - timestamp) < 60000,
        )
      : undefined;

    let deltaIn = inputTokens;
    let deltaOut = outputTokens;
    let deltaHit = cacheHitTokens;
    let deltaMiss = cacheMissTokens;
    let deltaTurns = turnCount;
    let deltaThinking = thinkingTokens;
    let deltaContent = contentTokens;

    if (existingReq) {
      if (
        existingReq.turnCount === turnCount &&
        existingReq.inputTokens === inputTokens &&
        existingReq.outputTokens === outputTokens &&
        existingReq.cacheHitTokens === cacheHitTokens &&
        (existingReq.thinkingTokens || 0) === thinkingTokens &&
        (existingReq.contentTokens || 0) === contentTokens
      ) {
        return;
      }
      deltaIn = Math.max(0, inputTokens - existingReq.inputTokens);
      deltaOut = Math.max(0, outputTokens - existingReq.outputTokens);
      deltaHit = Math.max(0, cacheHitTokens - existingReq.cacheHitTokens);
      deltaMiss = Math.max(0, cacheMissTokens - (existingReq.inputTokens - existingReq.cacheHitTokens));
      deltaTurns = Math.max(0, turnCount - existingReq.turnCount);
      deltaThinking = Math.max(0, thinkingTokens - (existingReq.thinkingTokens || 0));
      deltaContent = Math.max(0, contentTokens - (existingReq.contentTokens || 0));

      existingReq.turnCount = Math.max(existingReq.turnCount, turnCount);
      existingReq.inputTokens = Math.max(existingReq.inputTokens, inputTokens);
      existingReq.outputTokens = Math.max(existingReq.outputTokens, outputTokens);
      existingReq.cacheHitTokens = Math.max(existingReq.cacheHitTokens, cacheHitTokens);
      existingReq.thinkingTokens = Math.max(existingReq.thinkingTokens || 0, thinkingTokens);
      existingReq.contentTokens = Math.max(existingReq.contentTokens || 0, contentTokens);
      existingReq.totalTokens = existingReq.inputTokens + existingReq.outputTokens;
      if (cleanModel && cleanModel !== "Unknown Model") existingReq.model = cleanModel;
    } else if (cleanPrompt) {
      this.registry.requests.push({
        id: `req_${timestamp}_${crypto.randomUUID().slice(0, 8)}`,
        timestamp,
        promptPreview: cleanPrompt,
        model: cleanModel,
        turnCount: Math.max(1, turnCount),
        inputTokens,
        outputTokens,
        cacheHitTokens,
        thinkingTokens,
        contentTokens,
        totalTokens: inputTokens + outputTokens,
      });
    }

    if (!this.registry.days[date]) {
      this.registry.days[date] = {
        date,
        ...createEmptyBucket(),
        models: {},
        conversations: {},
      };
    }

    const day = this.registry.days[date];
    if (deltaIn > 0 || deltaOut > 0) {
      addToBucket(day, {
        input: deltaIn,
        output: deltaOut,
        cacheHit: deltaHit,
        cacheMiss: deltaMiss,
        thinkingTokens: deltaThinking,
        contentTokens: deltaContent,
      });
    }

    if (!day.models[cleanModel]) day.models[cleanModel] = createEmptyBucket();
    const modelBucket = day.models[cleanModel];
    if (modelBucket && (deltaIn > 0 || deltaOut > 0)) {
      addToBucket(modelBucket, {
        input: deltaIn,
        output: deltaOut,
        cacheHit: deltaHit,
        cacheMiss: deltaMiss,
        thinkingTokens: deltaThinking,
        contentTokens: deltaContent,
      });
    }

    if (!this.registry.conversations[cid]) {
      this.registry.conversations[cid] = {
        id: cid,
        title,
        workspace: workspacePath || "",
        model: cleanModel,
        models: {},
        turnCount: 0,
        lastActive: timestamp,
        ...createEmptyBucket(),
      };
    }

    const cStat = this.registry.conversations[cid];
    if (cStat) {
      cStat.turnCount += deltaTurns;
      cStat.lastActive = Math.max(cStat.lastActive || 0, timestamp);
      if (cleanModel && cleanModel !== "Unknown Model") cStat.model = cleanModel;
      if (title && (!cStat.title || cStat.title === cid.slice(0, 8))) cStat.title = title;
      if (!cStat.models) cStat.models = {};
      if (cleanModel && cleanModel !== "Unknown Model") {
        if (!cStat.models[cleanModel]) cStat.models[cleanModel] = createEmptyBucket();
        const mBucket = cStat.models[cleanModel];
        if (mBucket && (deltaIn > 0 || deltaOut > 0)) {
          addToBucket(mBucket, {
            input: deltaIn,
            output: deltaOut,
            cacheHit: deltaHit,
            cacheMiss: deltaMiss,
            thinkingTokens: deltaThinking,
            contentTokens: deltaContent,
          });
        }
      }
      if (deltaIn > 0 || deltaOut > 0) {
        addToBucket(cStat, {
          input: deltaIn,
          output: deltaOut,
          cacheHit: deltaHit,
          cacheMiss: deltaMiss,
          thinkingTokens: deltaThinking,
          contentTokens: deltaContent,
        });
      }
    }

    this.registry.lastUpdated = Date.now();
    this.schedulePersist();
  }

  public getTodayStats(): DayTokenStats {
    const today = getTodayString();
    const hourly = this.getTodayHourlyStats();
    const bucket = createEmptyBucket();
    const models: Record<string, TokenBucket> = {};

    for (const h of hourly) {
      addToBucket(bucket, h);
      for (const [m, b] of Object.entries(h.models || {})) {
        if (!models[m]) models[m] = createEmptyBucket();
        const target = models[m];
        if (target) addToBucket(target, b);
      }
    }

    const dayRecord = this.registry.days[today];
    const isBucketLarger = bucket.totalTokens >= (dayRecord?.totalTokens || 0);
    const chosen = isBucketLarger ? bucket : (dayRecord ?? createEmptyBucket());

    const mergedToday: DayTokenStats = {
      date: today,
      inputTokens: chosen.inputTokens,
      outputTokens: chosen.outputTokens,
      cacheHitTokens: chosen.cacheHitTokens,
      cacheMissTokens: chosen.cacheMissTokens,
      totalTokens: chosen.totalTokens,
      thinkingTokens: chosen.thinkingTokens || 0,
      contentTokens: chosen.contentTokens || 0,
      models: Object.keys(models).length > 0 ? models : (dayRecord?.models || {}),
      conversations: dayRecord?.conversations || {},
    };

    this.registry.days[today] = mergedToday;
    return mergedToday;
  }

  public getTodayHourlyStats(): HourlyTokenStats[] {
    const today = new Date();
    const startOfTodayMs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const endOfTodayMs = startOfTodayMs + 864e5;
    const currentHour = today.getHours();

    const hourlyMap: Record<number, HourlyTokenStats> = {};
    for (let h = 0; h <= currentHour; h++) {
      hourlyMap[h] = {
        hour: h,
        hourLabel: `${String(h).padStart(2, "0")}:00`,
        ...createEmptyBucket(),
        models: {},
      };
    }

    const todayReqs = (this.registry.requests || []).filter(
      (r) => r && r.timestamp >= startOfTodayMs && r.timestamp < endOfTodayMs,
    );

    for (const req of todayReqs) {
      const d = new Date(req.timestamp);
      const h = d.getHours();
      let bucket = hourlyMap[h];
      if (!bucket) {
        bucket = {
          hour: h,
          hourLabel: `${String(h).padStart(2, "0")}:00`,
          ...createEmptyBucket(),
          models: {},
        };
        hourlyMap[h] = bucket;
      }
      addToBucket(bucket, req);
      const m = req.model || "Unknown";
      if (!bucket.models[m]) bucket.models[m] = createEmptyBucket();
      const target = bucket.models[m];
      if (target) addToBucket(target, req);
    }

    return Object.values(hourlyMap).sort((a, b) => a.hour - b.hour);
  }

  public getDailyStats(daysCount = 7): DayTokenStats[] {
    const result: DayTokenStats[] = [];
    const today = new Date();
    const todayStr = getTodayString();

    for (let i = daysCount - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const dateStr = `${year}-${month}-${day}`;

      if (dateStr === todayStr) {
        result.push(this.getTodayStats());
      } else {
        const existing = this.registry.days[dateStr];
        if (existing) {
          result.push(existing);
        } else {
          result.push({
            date: dateStr,
            ...createEmptyBucket(),
            models: {},
            conversations: {},
          });
        }
      }
    }

    return result;
  }

  public getWeeklyStats(weeksCount = 4): WeekTokenStats[] {
    const daily = this.getDailyStats(weeksCount * 7);
    const weeks: WeekTokenStats[] = [];

    for (let w = 0; w < weeksCount; w++) {
      const slice = daily.slice(w * 7, (w + 1) * 7);
      if (slice.length === 0) continue;

      const firstDate = slice[0]?.date || "";
      const lastDate = slice[slice.length - 1]?.date || "";
      const weekBucket: WeekTokenStats = {
        weekLabel: `${firstDate.slice(5)} to ${lastDate.slice(5)}`,
        startDate: firstDate,
        endDate: lastDate,
        ...createEmptyBucket(),
        models: {},
      };

      for (const day of slice) {
        addToBucket(weekBucket, day);
        for (const [m, b] of Object.entries(day.models)) {
          if (!weekBucket.models[m]) weekBucket.models[m] = createEmptyBucket();
          const target = weekBucket.models[m];
          if (target) addToBucket(target, b);
        }
      }

      weeks.push(weekBucket);
    }

    return weeks;
  }

  public getMonthlyStats(monthsCount = 12): MonthTokenStats[] {
    const months: MonthTokenStats[] = [];
    const today = new Date();
    const monthMap = new Map<string, MonthTokenStats>();
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    for (let i = monthsCount - 1; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const year = d.getFullYear();
      const monthNum = d.getMonth() + 1;
      const monthStr = String(monthNum).padStart(2, "0");
      const prefix = `${year}-${monthStr}`;
      const label = `${monthNames[d.getMonth()]} ${String(year).slice(2)}`;

      const monthBucket: MonthTokenStats = {
        monthLabel: label,
        startDate: `${prefix}-01`,
        endDate: `${prefix}-31`,
        ...createEmptyBucket(),
        models: {},
      };

      monthMap.set(prefix, monthBucket);
      months.push(monthBucket);
    }

    for (const [dayKey, day] of Object.entries(this.registry.days)) {
      const prefix = dayKey.slice(0, 7);
      const targetMonth = monthMap.get(prefix);
      if (!targetMonth) continue;

      addToBucket(targetMonth, day);

      for (const [m, b] of Object.entries(day.models)) {
        if (!targetMonth.models[m]) targetMonth.models[m] = createEmptyBucket();
        const target = targetMonth.models[m];
        if (target) addToBucket(target, b);
      }
    }

    return months;
  }

  public getConversationsList(limit = 100): ConversationStats[] {
    const list = Object.entries(this.registry.conversations || {})
      .sort(([, a], [, b]) => b.lastActive - a.lastActive)
      .slice(0, limit);

    for (const [id, c] of list) {
      if (!c.title || /^[0-9a-f]{8}$/i.test(c.title)) {
        const fresh = extractAntigravityTitle(id);
        if (fresh && fresh !== id.slice(0, 8)) {
          c.title = fresh;
        }
      }
    }

    return list.map(([, c]) => c);
  }

  public getRequestsList(limit = 100): RequestStats[] {
    const reqs = this.registry.requests || [];
    let changed = false;

    for (const r of reqs) {
      if (!r.promptPreview || /^[0-9a-f]{8}$/i.test(r.promptPreview.trim())) {
        const raw = (r.promptPreview || "").trim();
        let healed: string | null = null;
        if (raw && /^[0-9a-f]{8}$/i.test(raw)) {
          healed = extractAntigravityTitle(raw);
          if (!healed || /^[0-9a-f]{8}$/i.test(healed)) {
            const matchingConv = Object.entries(this.registry.conversations || {}).find(([cid]) => cid.toLowerCase().startsWith(raw.toLowerCase()));
            if (matchingConv?.[1]?.title && !/^[0-9a-f]{8}$/i.test(matchingConv[1].title)) {
              healed = matchingConv[1].title;
            }
          }
        }
        if (healed && healed !== raw && !/^[0-9a-f]{8}$/i.test(healed)) {
          r.promptPreview = healed;
          changed = true;
        }
      }
    }

    if (changed) {
      this.persist();
    }

    return reqs
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  public getAllTimeSummary(): TokenBucket & { totalTurns: number; cacheHitRate: number } {
    const summary = createEmptyBucket();
    let totalTurns = 0;

    for (const day of Object.values(this.registry.days)) {
      addToBucket(summary, day);
    }

    for (const c of Object.values(this.registry.conversations || {})) {
      totalTurns += c.turnCount || 0;
    }

    const cacheHitRate =
      summary.inputTokens > 0 ? Math.round((summary.cacheHitTokens / summary.inputTokens) * 1000) / 10 : 0;

    return {
      ...summary,
      totalTurns,
      cacheHitRate,
    };
  }

  public async resetAndRecalculate(brainDir?: string): Promise<void> {
    this.registry = { days: {}, conversations: {}, requests: [], lastUpdated: Date.now() };
    await this.context.globalState.update(STATS_KEY, this.registry);
    await this.backfillFromTranscripts(brainDir, true);
  }

  public async backfillFromTranscripts(brainDir?: string, force = false): Promise<void> {
    const targetDirs = brainDir ? [brainDir] : getBrainDirs();

    for (const dir of targetDirs) {
      if (!fs.existsSync(dir)) continue;

      try {
        const convs = fs.readdirSync(dir);
        const convList: Array<{ id: string; mtime: number }> = [];
        for (const convId of convs) {
          const transcriptPath = path.join(dir, convId, ".system_generated", "logs", "transcript.jsonl");
          if (fs.existsSync(transcriptPath)) {
            try {
              const st = fs.statSync(transcriptPath);
              convList.push({ id: convId, mtime: st.mtimeMs });
            } catch {
              convList.push({ id: convId, mtime: 0 });
            }
          }
        }
        convList.sort((a, b) => b.mtime - a.mtime);

        for (const item of convList) {
          const convId = item.id;
          const transcriptPath = path.join(dir, convId, ".system_generated", "logs", "transcript.jsonl");

          try {
            if (!force && this.registry.conversations[convId]) {
              continue;
            }

            const content = await fs.promises.readFile(transcriptPath, "utf8");
            const lines = content.split("\n").filter(Boolean);
            if (lines.length === 0) continue;

            const convTitle = extractAntigravityTitle(convId);
            const parsed = parseTranscriptLines(lines, "", convTitle);
            const genMetrics = readGenMetadata(convId);

            for (const block of parsed.completedBlocks) {
              if (block.turnCount === 0) continue;
              const dateObj = new Date(block.timestamp);
              const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")}`;

              const agg = genMetrics
                ? aggregateBlockTokens(genMetrics.turns, block.startTurnIdx, block.endTurnIdx)
                : { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, thinkingTokens: 0, contentTokens: 0, model: "", maxGenIdx: 0 };

              const model = agg.model
                ? (formatDynamicModelName(agg.model) || block.detectedModel)
                : block.detectedModel;

              this.recordTokens(
                dateStr,
                model,
                convId,
                convTitle,
                "",
                agg.inputTokens,
                agg.outputTokens,
                agg.cacheHitTokens,
                agg.cacheMissTokens,
                block.promptText,
                block.timestamp,
                block.turnCount,
                agg.thinkingTokens,
                agg.contentTokens,
              );
            }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }

    this.pruneRequests();
    await this.persist();
  }

  public getBurnRate(windowMinutes = 15): BurnRateInfo {
    const windowMs = windowMinutes * 60 * 1000;
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (this.registry.requests || []).filter((r) => (r.timestamp || 0) >= cutoff);
    let totalTokens = 0;
    let totalTurns = 0;
    for (const r of recent) {
      totalTokens += r.totalTokens || 0;
      totalTurns += r.turnCount || 1;
    }
    if (recent.length === 0 || totalTokens === 0) {
      return { tokensPerMin: 0, recentTurns: 0 };
    }
    const earliestTs = recent[recent.length - 1]?.timestamp || now;
    const elapsedMinutes = Math.max(1, Math.min(windowMinutes, Math.round((now - earliestTs) / 60000) || 1));
    const tokensPerMin = Math.round(totalTokens / elapsedMinutes);
    return { tokensPerMin, recentTurns: totalTurns };
  }

  private pruneRequests(): void {
    if (!this.registry.requests) {
      this.registry.requests = [];
      return;
    }
    this.registry.requests.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    if (this.registry.requests.length > 500) {
      this.registry.requests = this.registry.requests.slice(0, 500);
    }
  }

  private schedulePersist(): void {
    if (this.persistDebounce) clearTimeout(this.persistDebounce);
    this.persistDebounce = setTimeout(() => {
      this.persistDebounce = null;
      void this.persist();
    }, 500);
  }

  private async persist(): Promise<void> {
    try {
      this.pruneRequests();
      await this.context.globalState.update(STATS_KEY, this.registry);
      this.onStatsChangeEmitter.fire();
    } catch (e: unknown) {
      this.log(`Failed to persist token stats: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  public dispose(): void {
    if (this.persistDebounce) {
      clearTimeout(this.persistDebounce);
      this.persistDebounce = null;
      void this.persist();
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.onStatsChangeEmitter.dispose();
  }
}
