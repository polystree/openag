import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ConversationStats, DayTokenStats, HourlyTokenStats, MonthTokenStats, RequestStats, TokenBucket, TokenStatsRegistry, WeekTokenStats } from "../types.js";

const STATS_KEY = "openag_token_stats_v8";
const BASE_SYSTEM_PROMPT_TOKENS = 4200;
const CONV_DIR = path.join(os.homedir(), ".gemini", "antigravity-ide", "conversations");
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

interface SqliteDb {
  prepare: (sql: string) => { all: (param?: unknown) => Array<{ idx: number; step_payload?: Uint8Array | Buffer }> };
  close?: () => void;
}

export function extractAntigravityTitle(convId: string, fallbackPrompt = ""): string {
  const dbPath = path.join(CONV_DIR, `${convId}.db`);
  if (fs.existsSync(dbPath)) {
    try {
      let sqlite: { DatabaseSync: new (p: string, opts?: { readOnly?: boolean; open?: boolean }) => SqliteDb } | null = null;
      try {
        sqlite = require("node:sqlite");
      } catch {
        sqlite = null;
      }

      if (sqlite?.DatabaseSync) {
        const db = new sqlite.DatabaseSync(dbPath, { readOnly: true, open: true });
        const rows = db.prepare("SELECT idx, step_payload FROM steps WHERE step_type = 23 ORDER BY idx ASC").all();
        if (typeof db.close === "function") db.close();

        for (const r of rows) {
          if (!r.step_payload) continue;
          const buf = Buffer.from(r.step_payload);
          for (let i = 0; i < buf.length - 10; i++) {
            if (buf[i] === 0x22) {
              const len = buf[i + 1];
              if (len && len >= 3 && len <= 80 && i + 2 + len < buf.length && buf[i + 2 + len] === 0x48) {
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
            }
          }
        }
      }
    } catch { /* ignore sqlite error */ }
  }

  if (fallbackPrompt) {
    const clean = fallbackPrompt.replace(/[\r\n]+/g, " ").trim();
    if (clean.length > 0) return clean.slice(0, 60);
  }

  return convId.slice(0, 8);
}

export function formatDynamicModelName(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
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
      .map((w) => (w.length <= 3 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
      .join(" ")
      .replace(/Gpt/g, "GPT")
      .replace(/Oss/g, "OSS");
  }

  return s.replace(/\s+/g, " ");
}

function createEmptyBucket(): TokenBucket {
  return { inputTokens: 0, outputTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0 };
}

function addToBucket(
  target: TokenBucket,
  add: { input?: number; output?: number; cacheHit?: number; cacheMiss?: number },
): void {
  const inp = add.input || 0;
  const out = add.output || 0;
  const hit = add.cacheHit || 0;
  const mis = add.cacheMiss || (inp - hit > 0 ? inp - hit : 0);
  target.inputTokens += inp;
  target.outputTokens += out;
  target.cacheHitTokens += hit;
  target.cacheMissTokens += mis;
  target.totalTokens += inp + out;
}

function getTodayString(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
    this.registry.requests.sort((a, b) => b.timestamp - a.timestamp);
    if (this.registry.requests.length > 500) {
      this.registry.requests = this.registry.requests.slice(0, 500);
    }
    if (this.registry.conversations) {
      for (const [id, c] of Object.entries(this.registry.conversations)) {
        if (c && (c.lastActive || 0) < cutoff && (c.totalTokens || 0) === 0) {
          delete this.registry.conversations[id];
        }
      }
    }
    this.schedulePersist();
  }

  public mergeRegistry(other: TokenStatsRegistry): void {
    if (!other?.days) return;

    if (Array.isArray(other.requests)) {
      const existingIds = new Set((this.registry.requests || []).map((r) => r.id));
      for (const req of other.requests) {
        if (!req) continue;
        if (!existingIds.has(req.id)) {
          this.registry.requests.push(req);
          existingIds.add(req.id);
        }
      }
      this.registry.requests.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      if (this.registry.requests.length > 500) {
        this.registry.requests = this.registry.requests.slice(0, 500);
      }
    }

    if (other.conversations) {
      if (!this.registry.conversations) this.registry.conversations = {};
      for (const [id, oc] of Object.entries(other.conversations)) {
        if (!oc) continue;
        const tc = this.registry.conversations[id];
        if (!tc) {
          this.registry.conversations[id] = { ...oc };
        } else if ((oc.lastActive || 0) > (tc.lastActive || 0)) {
          tc.lastActive = oc.lastActive;
          tc.turnCount = Math.max(tc.turnCount || 0, oc.turnCount || 0);
          tc.totalTokens = Math.max(tc.totalTokens || 0, oc.totalTokens || 0);
          tc.inputTokens = Math.max(tc.inputTokens || 0, oc.inputTokens || 0);
          tc.outputTokens = Math.max(tc.outputTokens || 0, oc.outputTokens || 0);
          tc.cacheHitTokens = Math.max(tc.cacheHitTokens || 0, oc.cacheHitTokens || 0);
          tc.cacheMissTokens = Math.max(tc.cacheMissTokens || 0, oc.cacheMissTokens || 0);
          if (oc.title && oc.title !== id.slice(0, 8)) tc.title = oc.title;
          if (oc.model && oc.model !== "Unknown Model") tc.model = oc.model;
        }
      }
    }

    if (other.days) {
      if (!this.registry.days) this.registry.days = {};
      for (const [date, od] of Object.entries(other.days)) {
        if (!od) continue;
        const td = this.registry.days[date];
        if (!td) {
          this.registry.days[date] = { ...od };
        } else {
          if (od.totalTokens > td.totalTokens) {
            td.totalTokens = od.totalTokens;
            td.inputTokens = od.inputTokens;
            td.outputTokens = od.outputTokens;
            td.cacheHitTokens = od.cacheHitTokens;
            td.cacheMissTokens = od.cacheMissTokens;
          }
          if (od.models) {
            if (!td.models) td.models = {};
            for (const [m, om] of Object.entries(od.models)) {
              if (!om) continue;
              const tm = td.models[m];
              if (!tm) {
                td.models[m] = { ...om };
              } else if (om.totalTokens > tm.totalTokens) {
                td.models[m] = { ...om };
              }
            }
          }
        }
      }
    }
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
  ): void {
    if (inputTokens <= 0 && outputTokens <= 0) return;

    const date = dateStr || getTodayString();
    const cleanModel = formatDynamicModelName(rawModelName) || rawModelName || "Unknown Model";
    const cid = convId || "default";
    const title = convTitle || extractAntigravityTitle(cid, promptPreview);

    if (!this.registry.days[date]) {
      this.registry.days[date] = {
        date,
        ...createEmptyBucket(),
        models: {},
        conversations: {},
      };
    }

    const day = this.registry.days[date];
    if (!day) return;
    addToBucket(day, { input: inputTokens, output: outputTokens, cacheHit: cacheHitTokens, cacheMiss: cacheMissTokens });

    if (!day.models[cleanModel]) day.models[cleanModel] = createEmptyBucket();
    const modelBucket = day.models[cleanModel];
    if (modelBucket) {
      addToBucket(modelBucket, {
        input: inputTokens,
        output: outputTokens,
        cacheHit: cacheHitTokens,
        cacheMiss: cacheMissTokens,
      });
    }

    if (!this.registry.conversations[cid]) {
      this.registry.conversations[cid] = {
        id: cid,
        title,
        workspace: workspacePath || "",
        model: cleanModel,
        turnCount: 0,
        lastActive: timestamp,
        ...createEmptyBucket(),
      };
    }

    const cStat = this.registry.conversations[cid];
    if (cStat) {
      cStat.turnCount += turnCount;
      cStat.lastActive = Math.max(cStat.lastActive || 0, timestamp);
      if (cleanModel && cleanModel !== "Unknown Model") cStat.model = cleanModel;
      if (title && (!cStat.title || cStat.title === cid.slice(0, 8))) cStat.title = title;
      addToBucket(cStat, {
        input: inputTokens,
        output: outputTokens,
        cacheHit: cacheHitTokens,
        cacheMiss: cacheMissTokens,
      });
    }

    if (promptPreview) {
      const cleanPrompt = promptPreview.slice(0, 80);
      const existingReq = this.registry.requests.find(
        (r) =>
          (r.promptPreview === cleanPrompt && Math.abs(r.timestamp - timestamp) < 60000) ||
          (timestamp > 0 && Math.abs(r.timestamp - timestamp) < 1500),
      );

      if (existingReq) {
        existingReq.turnCount += turnCount;
        existingReq.outputTokens += outputTokens;
        existingReq.inputTokens += inputTokens;
        existingReq.cacheHitTokens += cacheHitTokens;
        existingReq.totalTokens = existingReq.inputTokens + existingReq.outputTokens;
        if (cleanModel && cleanModel !== "Unknown Model") existingReq.model = cleanModel;
      } else {
        this.registry.requests.push({
          id: `req_${timestamp}_${crypto.randomUUID().slice(0, 8)}`,
          timestamp,
          promptPreview: cleanPrompt,
          model: cleanModel,
          turnCount: Math.max(1, turnCount),
          inputTokens,
          outputTokens,
          cacheHitTokens,
          totalTokens: inputTokens + outputTokens,
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
      addToBucket(bucket, {
        input: h.inputTokens,
        output: h.outputTokens,
        cacheHit: h.cacheHitTokens,
        cacheMiss: h.cacheMissTokens,
      });
      for (const [m, b] of Object.entries(h.models || {})) {
        if (!models[m]) models[m] = createEmptyBucket();
        const target = models[m];
        if (target) {
          addToBucket(target, {
            input: b.inputTokens,
            output: b.outputTokens,
            cacheHit: b.cacheHitTokens,
            cacheMiss: b.cacheMissTokens,
          });
        }
      }
    }

    const dayRecord = this.registry.days[today];
    const total = Math.max(bucket.totalTokens, dayRecord?.totalTokens || 0);

    const mergedToday: DayTokenStats = {
      date: today,
      inputTokens: bucket.totalTokens >= (dayRecord?.totalTokens || 0) ? bucket.inputTokens : (dayRecord?.inputTokens || 0),
      outputTokens: bucket.totalTokens >= (dayRecord?.totalTokens || 0) ? bucket.outputTokens : (dayRecord?.outputTokens || 0),
      cacheHitTokens: bucket.totalTokens >= (dayRecord?.totalTokens || 0) ? bucket.cacheHitTokens : (dayRecord?.cacheHitTokens || 0),
      cacheMissTokens: bucket.totalTokens >= (dayRecord?.totalTokens || 0) ? bucket.cacheMissTokens : (dayRecord?.cacheMissTokens || 0),
      totalTokens: total,
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
      addToBucket(bucket, {
        input: req.inputTokens,
        output: req.outputTokens,
        cacheHit: req.cacheHitTokens,
        cacheMiss: Math.max(0, req.inputTokens - (req.cacheHitTokens || 0)),
      });
      const m = req.model || "Unknown";
      if (!bucket.models[m]) bucket.models[m] = createEmptyBucket();
      const target = bucket.models[m];
      if (target) {
        addToBucket(target, {
          input: req.inputTokens,
          output: req.outputTokens,
          cacheHit: req.cacheHitTokens,
          cacheMiss: Math.max(0, req.inputTokens - (req.cacheHitTokens || 0)),
        });
      }
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
        addToBucket(weekBucket, {
          input: day.inputTokens,
          output: day.outputTokens,
          cacheHit: day.cacheHitTokens,
          cacheMiss: day.cacheMissTokens,
        });
        for (const [m, b] of Object.entries(day.models)) {
          if (!weekBucket.models[m]) weekBucket.models[m] = createEmptyBucket();
          const target = weekBucket.models[m];
          if (target) {
            addToBucket(target, {
              input: b.inputTokens,
              output: b.outputTokens,
              cacheHit: b.cacheHitTokens,
              cacheMiss: b.cacheMissTokens,
            });
          }
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

      addToBucket(targetMonth, {
        input: day.inputTokens,
        output: day.outputTokens,
        cacheHit: day.cacheHitTokens,
        cacheMiss: day.cacheMissTokens,
      });

      for (const [m, b] of Object.entries(day.models)) {
        if (!targetMonth.models[m]) targetMonth.models[m] = createEmptyBucket();
        const target = targetMonth.models[m];
        if (target) {
          addToBucket(target, {
            input: b.inputTokens,
            output: b.outputTokens,
            cacheHit: b.cacheHitTokens,
            cacheMiss: b.cacheMissTokens,
          });
        }
      }
    }

    return months;
  }

  public getConversationsList(limit = 100): ConversationStats[] {
    return Object.values(this.registry.conversations || {})
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, limit);
  }

  public getRequestsList(limit = 100): RequestStats[] {
    return (this.registry.requests || [])
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  public getAllTimeSummary(): TokenBucket & { totalTurns: number; cacheHitRate: number } {
    const summary = createEmptyBucket();
    let totalTurns = 0;

    for (const day of Object.values(this.registry.days)) {
      addToBucket(summary, {
        input: day.inputTokens,
        output: day.outputTokens,
        cacheHit: day.cacheHitTokens,
        cacheMiss: day.cacheMissTokens,
      });
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

  public async resetAndRecalculate(
    brainDir: string,
    countBpeTokens: (text: string) => number,
  ): Promise<void> {
    this.registry = { days: {}, conversations: {}, requests: [], lastUpdated: Date.now() };
    await this.context.globalState.update(STATS_KEY, this.registry);
    await this.backfillFromTranscripts(brainDir, countBpeTokens, true);
  }

  public async backfillFromTranscripts(
    brainDir: string,
    countBpeTokens: (text: string) => number,
    force = false,
  ): Promise<void> {
    if (!fs.existsSync(brainDir)) return;

    try {
      const convs = fs.readdirSync(brainDir);
      const convList: Array<{ id: string; mtime: number }> = [];
      for (const convId of convs) {
        const transcriptPath = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
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
        const transcriptPath = path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");

        try {
          if (!force && this.registry.conversations[convId]) {
            continue;
          }

          const content = await fs.promises.readFile(transcriptPath, "utf8");
          const lines = content.split("\n").filter(Boolean);
          if (lines.length === 0) continue;

          let detectedModel = "Gemini 3.7 Flash High";
          let initialPrompt = "";
          let runningContextTokens = BASE_SYSTEM_PROMPT_TOKENS;

          // Extract initial prompt from step 0
          try {
            const firstLine = lines[0];
            if (firstLine) {
              const firstObj = JSON.parse(firstLine) as { content?: string };
              if (firstObj.content) {
                const reqMatch = firstObj.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
                if (reqMatch?.[1]) {
                  initialPrompt = reqMatch[1].trim().replace(/[\r\n]+/g, " ").slice(0, 75);
                }
              }
            }
          } catch { /* ignore */ }

          const convTitle = extractAntigravityTitle(convId, initialPrompt);

          interface ActivePromptBlock {
            timestamp: number;
            promptText: string;
            turnCount: number;
            inputTokens: number;
            outputTokens: number;
            cacheHitTokens: number;
            cacheMissTokens: number;
          }

          let activeBlock: ActivePromptBlock | null = null;

          const flushBlock = (blk: ActivePromptBlock | null) => {
            if (!blk || blk.turnCount === 0) return;
            const dateObj = new Date(blk.timestamp);
            const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")}`;
            this.recordTokens(
              dateStr,
              detectedModel,
              convId,
              convTitle,
              "",
              blk.inputTokens,
              blk.outputTokens,
              blk.cacheHitTokens,
              blk.cacheMissTokens,
              blk.promptText,
              blk.timestamp,
              blk.turnCount,
            );
          };

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;

            try {
              const obj = JSON.parse(line) as {
                type?: string;
                source?: string;
                content?: string;
                thinking?: string;
                tool_calls?: unknown[];
                created_at?: string;
              };

              if (obj.source !== "MODEL" && obj.content) {
                const mMatch = obj.content.match(/`?Model Selection`? from [^`\r\n]+? to ([^\r\n`]+?)(?:\.\s+No need|\.\s*$|$)/i);
                if (mMatch?.[1]) {
                  const parsed = formatDynamicModelName(mMatch[1]);
                  if (parsed) detectedModel = parsed;
                }
              }

              if (obj.type === "CHECKPOINT") {
                const cac = countBpeTokens(obj.content || "");
                runningContextTokens = cac;
              } else if (obj.source === "USER_INPUT" || obj.source === "USER_EXPLICIT") {
                flushBlock(activeBlock);

                const text = obj.content || "";
                const req = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
                const pText = (req?.[1] || text).trim().replace(/[\r\n]+/g, " ").slice(0, 80);
                const reqTime = obj.created_at ? Date.parse(obj.created_at) : (item.mtime || Date.now());

                const inpTurn = countBpeTokens(text);
                runningContextTokens += inpTurn;

                activeBlock = {
                  timestamp: reqTime,
                  promptText: pText || "User Prompt",
                  turnCount: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheHitTokens: 0,
                  cacheMissTokens: 0,
                };
              } else if (obj.type === "PLANNER_RESPONSE" || (!obj.type && obj.source === "MODEL")) {
                const stepTime = obj.created_at ? Date.parse(obj.created_at) : (item.mtime || Date.now());
                if (!activeBlock) {
                  activeBlock = {
                    timestamp: stepTime,
                    promptText: initialPrompt || convTitle || "Initial Request",
                    turnCount: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheHitTokens: 0,
                    cacheMissTokens: 0,
                  };
                }

                activeBlock.turnCount += 1;
                const turnInp = runningContextTokens;
                const turnHit = Math.max(0, turnInp - BASE_SYSTEM_PROMPT_TOKENS);
                const turnMiss = Math.min(turnInp, BASE_SYSTEM_PROMPT_TOKENS);

                let outTurn = countBpeTokens(obj.content || "");
                if (obj.thinking) outTurn += countBpeTokens(obj.thinking);
                if (Array.isArray(obj.tool_calls)) outTurn += countBpeTokens(JSON.stringify(obj.tool_calls));

                activeBlock.inputTokens += turnInp;
                activeBlock.cacheHitTokens += turnHit;
                activeBlock.cacheMissTokens += turnMiss;
                activeBlock.outputTokens += outTurn;
                runningContextTokens += outTurn;
              } else {
                const toolOut = countBpeTokens(obj.content || "");
                runningContextTokens += toolOut;
              }
            } catch { /* ignore */ }
          }

          flushBlock(activeBlock);
        } catch { /* ignore */ }
      }

      // Sort and prune requests strictly by latest timestamp
      this.registry.requests.sort((a, b) => b.timestamp - a.timestamp);
      if (this.registry.requests.length > 500) {
        this.registry.requests = this.registry.requests.slice(0, 500);
      }
      this.schedulePersist();
    } catch { /* ignore */ }
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
      this.registry.requests.sort((a, b) => b.timestamp - a.timestamp);
      if (this.registry.requests.length > 500) {
        this.registry.requests = this.registry.requests.slice(0, 500);
      }
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
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.onStatsChangeEmitter.dispose();
  }
}
