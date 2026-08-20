import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextUsage } from "../types.js";
import { extractAntigravityTitle, formatDynamicModelName, type StatsManager } from "./stats-manager.js";

const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity-ide", "brain");
const CONV_DIR = path.join(os.homedir(), ".gemini", "antigravity-ide", "conversations");

const BPE_PATTERN = /'(?:[sdmt]|ll|ve|re)| ?[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const BASE_SYSTEM_PROMPT_TOKENS = 4200;

function normalizePath(p: string): string {
  if (!p) return "";
  try {
    p = decodeURIComponent(p);
  } catch { /* ignore */ }
  return p.replace(/\\/g, "/").toLowerCase().replace(/^file:\/\/\/?/, "").replace(/^\/+/, "").replace(/\/$/, "");
}

interface SqliteDb {
  prepare: (sql: string) => { get: (param?: unknown) => { data?: Uint8Array | Buffer } | undefined };
  close?: () => void;
}

export function countBpeTokens(text: string): number {
  if (!text) return 0;
  BPE_PATTERN.lastIndex = 0;
  let total = 0;
  for (let m = BPE_PATTERN.exec(text); m !== null; m = BPE_PATTERN.exec(text)) {
    const len = m[0].length;
    total += len <= 8 ? 1 : ((len + 3) >> 2);
  }
  return total;
}

export class UsageTracker {
  private activeModel = "Gemini 3.7 Flash High";
  private readonly modelContextLimits = new Map<string, number>();
  private currentUsage: ContextUsage = {
    current: 0,
    limit: 1048576,
    model: "Gemini 3.7 Flash High",
    percent: 0,
  };

  private activeConversationId: string | null = null;
  private activeTranscriptPath: string | null = null;
  private workspacePaths: string[] = [];
  private lastProcessedLineCount = 0;
  private lastProcessedPath: string | null = null;

  private cachedLineTokens: number[] = [];
  private cachedRunningTokens = BASE_SYSTEM_PROMPT_TOKENS;
  private cachedInitialPrompt = "";
  private isComputing = false;

  private readonly dbWorkspaceCache = new Map<string, { mtime: number; size: number; uri: string | null }>();

  private transcriptWatcher: fs.FSWatcher | null = null;
  private convDirWatcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  private readonly onContextChangeEmitter = new vscode.EventEmitter<ContextUsage>();
  public readonly onContextChange = this.onContextChangeEmitter.event;

  constructor(private readonly statsManager?: StatsManager) {
    this.initWatchers();
    this.refresh();
    this.pollInterval = setInterval(() => this.refresh(), 10000);
    if (this.statsManager) {
      void this.statsManager.backfillFromTranscripts(BRAIN_DIR, countBpeTokens);
    }
  }

  public registerModelMetadata(models: Record<string, { maxTokens?: number }>): void {
    for (const [id, meta] of Object.entries(models)) {
      if (meta.maxTokens && meta.maxTokens > 0) {
        this.modelContextLimits.set(id.toLowerCase(), meta.maxTokens);
      }
    }
    this.scheduleCompute();
  }

  public setWorkspacePaths(paths: string[]): void {
    this.workspacePaths = paths.map((p) => normalizePath(p)).filter(Boolean);
    this.refresh();
  }

  public getActiveModel(): string {
    return this.activeModel;
  }

  public getCurrentUsage(): ContextUsage {
    return { ...this.currentUsage };
  }

  public getModelContextLimit(modelId?: string): number {
    const key = (modelId || this.activeModel || "").toLowerCase();
    const registered = this.modelContextLimits.get(key);
    if (registered && registered > 0) return registered;
    if (key.includes("gpt") || key.includes("oss")) {
      return 128000;
    }
    if (key.includes("claude") || key.includes("sonnet") || key.includes("opus") || key.includes("haiku")) {
      return 200000;
    }
    return 1048576;
  }

  public refresh(): void {
    const convId = this.resolveActiveConversationId();
    if (!convId) return;

    if (convId !== this.activeConversationId) {
      this.activeConversationId = convId;
      this.activeTranscriptPath = path.join(BRAIN_DIR, convId, ".system_generated", "logs", "transcript.jsonl");
      this.lastProcessedLineCount = 0;
      this.lastProcessedPath = null;
      this.cachedLineTokens = [];
      this.cachedRunningTokens = BASE_SYSTEM_PROMPT_TOKENS;
      this.cachedInitialPrompt = "";
      this.attachTranscriptWatcher();
    }

    this.scheduleCompute();
  }

  private initWatchers(): void {
    try {
      if (fs.existsSync(CONV_DIR)) {
        this.convDirWatcher = fs.watch(CONV_DIR, { persistent: false }, () => {
          this.scheduleCompute();
        });
      }
    } catch { /* ignore watcher error */ }
  }

  private attachTranscriptWatcher(): void {
    if (this.transcriptWatcher) {
      this.transcriptWatcher.close();
      this.transcriptWatcher = null;
    }
    if (!this.activeTranscriptPath) return;

    try {
      const dir = path.dirname(this.activeTranscriptPath);
      if (fs.existsSync(dir)) {
        this.transcriptWatcher = fs.watch(dir, { persistent: false }, () => {
          this.scheduleCompute();
        });
      }
    } catch { /* ignore watcher error */ }
  }

  private scheduleCompute(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.computeContextUsage();
    }, 200);
  }

  private extractWorkspaceUriFromDb(dbPath: string): string | null {
    try {
      const st = fs.statSync(dbPath);
      const cached = this.dbWorkspaceCache.get(dbPath);
      if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) {
        return cached.uri;
      }

      let uri: string | null = null;
      let sqlite: { DatabaseSync: new (p: string, opts?: { readOnly?: boolean; open?: boolean }) => SqliteDb } | null = null;
      try {
        sqlite = require("node:sqlite");
      } catch {
        sqlite = null;
      }

      if (sqlite?.DatabaseSync) {
        try {
          const db = new sqlite.DatabaseSync(dbPath, { readOnly: true, open: true });
          const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id=?").get("main");
          if (typeof db.close === "function") db.close();
          if (row?.data) {
            const text = Buffer.from(row.data).toString("utf-8");
            const m = text.match(/file:\/\/\/[-a-zA-Z0-9_.:~%+/]+/i);
            if (m) uri = normalizePath(m[0]);
          }
        } catch { /* ignore */ }
      }

      if (!uri) {
        try {
          const fd = fs.openSync(dbPath, "r");
          const readLen = Math.min(st.size, 65536);
          const buf = Buffer.alloc(readLen);
          fs.readSync(fd, buf, 0, readLen, 0);
          fs.closeSync(fd);
          const text = buf.toString("utf-8");
          const m = text.match(/file:\/\/\/[-a-zA-Z0-9_.:~%+/]+/i);
          if (m) uri = normalizePath(m[0]);
        } catch { /* ignore */ }
      }

      this.dbWorkspaceCache.set(dbPath, { mtime: st.mtimeMs, size: st.size, uri });
      return uri;
    } catch {
      return null;
    }
  }

  private resolveActiveConversationId(): string | null {
    if (!fs.existsSync(CONV_DIR)) return null;

    try {
      const files = fs.readdirSync(CONV_DIR).filter((f) => f.endsWith(".db"));
      if (files.length === 0) return null;

      const fileStats: Array<{ name: string; fullPath: string; mtime: number }> = [];
      for (const f of files) {
        const fullPath = path.join(CONV_DIR, f);
        try {
          const st = fs.statSync(fullPath);
          fileStats.push({ name: f, fullPath, mtime: st.mtimeMs });
        } catch { /* ignore */ }
      }

      fileStats.sort((a, b) => b.mtime - a.mtime);

      if (this.workspacePaths.length > 0) {
        for (const item of fileStats) {
          const wsUri = this.extractWorkspaceUriFromDb(item.fullPath);
          if (wsUri) {
            const isMatch = this.workspacePaths.some(
              (wp) => wsUri.includes(wp) || wp.includes(wsUri),
            );
            if (isMatch) {
              return item.name.replace(".db", "");
            }
          }
        }
      }

      return fileStats[0]?.name.replace(".db", "") ?? null;
    } catch {
      return null;
    }
  }

  private async computeContextUsage(): Promise<void> {
    if (this.isComputing || !this.activeTranscriptPath || !fs.existsSync(this.activeTranscriptPath)) return;
    this.isComputing = true;

    try {
      const content = await fs.promises.readFile(this.activeTranscriptPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length === 0) return;

      if (this.lastProcessedPath !== this.activeTranscriptPath || lines.length < this.cachedLineTokens.length) {
        this.cachedLineTokens = [];
        this.cachedRunningTokens = BASE_SYSTEM_PROMPT_TOKENS;
        this.cachedInitialPrompt = "";
        this.lastProcessedLineCount = 0;
        this.lastProcessedPath = this.activeTranscriptPath;
      }

      let detectedModel = this.activeModel;
      let initialPrompt = this.cachedInitialPrompt;

      if (!initialPrompt && lines[0]) {
        try {
          const firstObj = JSON.parse(lines[0]) as { content?: string };
          if (firstObj.content) {
            const reqMatch = firstObj.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
            if (reqMatch?.[1]) {
              initialPrompt = reqMatch[1].trim().replace(/[\r\n]+/g, " ").slice(0, 75);
              this.cachedInitialPrompt = initialPrompt;
            }
          }
        } catch { /* ignore */ }
      }

      const convTitle = this.activeConversationId ? extractAntigravityTitle(this.activeConversationId, initialPrompt) : initialPrompt;

      const startIdx = this.cachedLineTokens.length;
      let runningContextTokens = this.cachedRunningTokens;

      for (let i = startIdx; i < lines.length; i++) {
        const line = lines[i];
        if (!line) {
          this.cachedLineTokens.push(0);
          continue;
        }

        try {
          const obj = JSON.parse(line) as {
            type?: string;
            source?: string;
            content?: string;
            thinking?: string;
            tool_calls?: unknown[];
          };

          if (obj.source !== "MODEL" && obj.content) {
            const mMatch = obj.content.match(/`?Model Selection`? from [^`\r\n]+? to ([^\r\n`]+?)(?:\.\s+No need|\.\s*$|$)/i);
            if (mMatch?.[1]) {
              const parsed = formatDynamicModelName(mMatch[1]);
              if (parsed) detectedModel = parsed;
            }
          }

          if (obj.type === "CHECKPOINT" || obj.content?.includes("{{ CHECKPOINT")) {
            const cpTokens = countBpeTokens(obj.content || "");
            runningContextTokens = cpTokens;
            this.cachedLineTokens.push(cpTokens);
          } else {
            let lineTokens = countBpeTokens(obj.content || "");
            if (obj.thinking) lineTokens += countBpeTokens(obj.thinking);
            if (Array.isArray(obj.tool_calls)) lineTokens += countBpeTokens(JSON.stringify(obj.tool_calls));
            runningContextTokens += lineTokens;
            this.cachedLineTokens.push(lineTokens);
          }
        } catch {
          this.cachedLineTokens.push(0);
        }
      }

      this.cachedRunningTokens = runningContextTokens;

      // Record incremental turns for stats
      if (this.statsManager && this.activeConversationId) {
        const statsStartIdx = this.lastProcessedPath === this.activeTranscriptPath ? this.lastProcessedLineCount : 0;
        if (lines.length > statsStartIdx) {
          let activePromptText = initialPrompt;
          let activePromptTime = Date.now();

          // Scan backwards to find the latest active user prompt
          for (let i = lines.length - 1; i >= 0; i--) {
            const l = lines[i];
            if (!l) continue;
            try {
              const obj = JSON.parse(l) as { source?: string; content?: string; created_at?: string };
              if (obj.source === "USER_INPUT" || obj.source === "USER_EXPLICIT") {
                if (obj.created_at) activePromptTime = Date.parse(obj.created_at);
                if (obj.content) {
                  const req = obj.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
                  activePromptText = (req?.[1] || obj.content).trim().replace(/[\r\n]+/g, " ").slice(0, 80);
                }
                break;
              }
            } catch { /* ignore */ }
          }

          let currentOutTurn = 0;
          let currentTurnCount = 0;

          for (let i = statsStartIdx; i < lines.length; i++) {
            const l = lines[i];
            if (!l) continue;
            try {
              const obj = JSON.parse(l) as {
                type?: string;
                source?: string;
                content?: string;
                thinking?: string;
                tool_calls?: unknown[];
              };

              if (obj.type === "PLANNER_RESPONSE" || (!obj.type && obj.source === "MODEL")) {
                currentTurnCount += 1;
                let outTurn = countBpeTokens(obj.content || "");
                if (obj.thinking) outTurn += countBpeTokens(obj.thinking);
                if (Array.isArray(obj.tool_calls)) outTurn += countBpeTokens(JSON.stringify(obj.tool_calls));
                currentOutTurn += outTurn;
              }
            } catch { /* ignore */ }
          }

          if (currentTurnCount > 0) {
            const dateObj = new Date(activePromptTime);
            const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")}`;
            const turnInp = runningContextTokens;
            const turnHit = Math.max(0, turnInp - BASE_SYSTEM_PROMPT_TOKENS);
            const turnMiss = Math.min(turnInp, BASE_SYSTEM_PROMPT_TOKENS);

            this.statsManager.recordTokens(
              dateStr,
              detectedModel,
              this.activeConversationId,
              convTitle,
              "",
              turnInp * currentTurnCount,
              currentOutTurn,
              turnHit * currentTurnCount,
              turnMiss * currentTurnCount,
              activePromptText,
              activePromptTime,
              currentTurnCount,
            );
          }

          this.lastProcessedLineCount = lines.length;
          this.lastProcessedPath = this.activeTranscriptPath;
        }
      }

      this.activeModel = detectedModel;
      const limit = this.getModelContextLimit(this.activeModel);

      this.currentUsage = {
        current: runningContextTokens,
        limit,
        model: this.activeModel,
        percent: limit > 0 ? Math.min(100, Math.round((runningContextTokens / limit) * 100)) : 0,
      };

      this.onContextChangeEmitter.fire(this.currentUsage);
    } catch { /* ignore compute error */ } finally {
      this.isComputing = false;
    }
  }

  public dispose(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.transcriptWatcher) {
      this.transcriptWatcher.close();
      this.transcriptWatcher = null;
    }
    if (this.convDirWatcher) {
      this.convDirWatcher.close();
      this.convDirWatcher = null;
    }
    this.dbWorkspaceCache.clear();
    this.onContextChangeEmitter.dispose();
  }
}
