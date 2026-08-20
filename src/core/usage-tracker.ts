import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextUsage } from "../types.js";

const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity-ide", "brain");
const CONV_DIR = path.join(os.homedir(), ".gemini", "antigravity-ide", "conversations");

const BPE_PATTERN = /'(?:[sdmt]|ll|ve|re)| ?[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const BASE_SYSTEM_PROMPT_CHARS = 16000;

interface SqliteDb {
  prepare: (sql: string) => { get: (param?: unknown) => { data?: Uint8Array | Buffer } | undefined };
  close?: () => void;
}

export function countBpeTokens(text: string): number {
  if (!text) return 0;
  let total = 0;
  for (const m of text.matchAll(BPE_PATTERN)) {
    const s = m[0];
    total += s.length <= 8 ? 1 : Math.ceil(s.length / 4);
  }
  return total;
}

export class UsageTracker {
  private activeModel = "gemini";
  private readonly modelContextLimits = new Map<string, number>();
  private currentUsage: ContextUsage = {
    current: 0,
    limit: 1048576,
    model: "gemini",
    percent: 0,
  };

  private activeConversationId: string | null = null;
  private activeTranscriptPath: string | null = null;
  private workspacePaths: string[] = [];

  private transcriptWatcher: fs.FSWatcher | null = null;
  private convDirWatcher: fs.FSWatcher | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  private readonly onContextChangeEmitter = new vscode.EventEmitter<ContextUsage>();
  public readonly onContextChange = this.onContextChangeEmitter.event;

  constructor() {
    this.initWatchers();
    this.refresh();
    this.pollInterval = setInterval(() => this.refresh(), 10000);
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
    this.workspacePaths = paths.map((p) => p.replace(/\\/g, "/").toLowerCase().replace(/^file:\/\/\//, ""));
    this.refresh();
  }

  public getActiveModel = (): string => this.activeModel;
  public getCurrentUsage = (): ContextUsage => ({ ...this.currentUsage });

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
    }, 120);
  }

  private extractWorkspaceUriFromDb(dbPath: string): string | null {
    try {
      let sqlite: { DatabaseSync: new (p: string, opts?: { readOnly?: boolean; open?: boolean }) => SqliteDb } | null = null;
      try {
        sqlite = require("node:sqlite");
      } catch {
        sqlite = null;
      }

      if (sqlite?.DatabaseSync) {
        const db = new sqlite.DatabaseSync(dbPath, { readOnly: true, open: true });
        const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id=?").get("main");
        if (typeof db.close === "function") db.close();
        if (row?.data) {
          const text = Buffer.from(row.data).toString("utf-8");
          const m = text.match(/file:\/\/\/[-a-zA-Z0-9_.:~%+/]+/i);
          if (m) return m[0].toLowerCase();
        }
      }
    } catch { /* ignore */ }

    try {
      const st = fs.statSync(dbPath);
      const fd = fs.openSync(dbPath, "r");
      const readLen = Math.min(st.size, 32768);
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, 0);
      fs.closeSync(fd);
      const text = buf.toString("utf-8");
      const m = text.match(/file:\/\/\/[-a-zA-Z0-9_.:~%+/]+/i);
      if (m) return m[0].toLowerCase();
    } catch { /* ignore */ }

    return null;
  }

  private resolveActiveConversationId(): string | null {
    if (!fs.existsSync(CONV_DIR)) return null;

    try {
      const files = fs.readdirSync(CONV_DIR).filter((f) => f.endsWith(".db"));
      let bestId: string | null = null;
      let bestMtime = 0;

      for (const f of files) {
        const dbPath = path.join(CONV_DIR, f);
        try {
          const st = fs.statSync(dbPath);
          const wsUri = this.extractWorkspaceUriFromDb(dbPath);

          if (wsUri && this.workspacePaths.length > 0) {
            const normUri = wsUri.replace(/^file:\/\/\//, "");
            const isMatch = this.workspacePaths.some(
              (wp) => normUri.includes(wp) || wp.includes(normUri),
            );
            if (isMatch && st.mtimeMs > bestMtime) {
              bestMtime = st.mtimeMs;
              bestId = f.replace(".db", "");
            }
          }
        } catch { /* ignore */ }
      }

      if (bestId) return bestId;

      let globalMtime = 0;
      for (const f of files) {
        try {
          const st = fs.statSync(path.join(CONV_DIR, f));
          if (st.mtimeMs > globalMtime) {
            globalMtime = st.mtimeMs;
            bestId = f.replace(".db", "");
          }
        } catch { /* ignore */ }
      }

      return bestId;
    } catch {
      return null;
    }
  }

  private async computeContextUsage(): Promise<void> {
    if (!this.activeTranscriptPath || !fs.existsSync(this.activeTranscriptPath)) return;

    try {
      const content = await fs.promises.readFile(this.activeTranscriptPath, "utf8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length === 0) return;

      let lastCheckpointIdx = -1;
      let detectedModel = this.activeModel;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        if (line.includes("CHECKPOINT") || line.includes("The earlier parts of this conversation have been truncated")) {
          try {
            const obj = JSON.parse(line) as { type?: string; content?: string };
            if (obj.type === "CHECKPOINT" || (obj.content && obj.content.includes("CHECKPOINT"))) {
              lastCheckpointIdx = i;
            }
          } catch { /* ignore */ }
        }

        const mMatch = line.match(/`Model Selection` from [^`\r\n]+? to ([^\r\n`]+)/i);
        if (mMatch?.[1]) {
          detectedModel = mMatch[1].trim().replace(/\.\s+No need to comment.*$/i, "").replace(/\.+$/, "").trim();
        } else {
          const mMatch2 = line.match(/"model":\s*"([^"]+)"/i);
          if (mMatch2?.[1]) detectedModel = mMatch2[1].trim();
        }
      }

      const activeLines = lastCheckpointIdx >= 0 ? lines.slice(lastCheckpointIdx) : lines;
      let payloadText = "";

      for (const line of activeLines) {
        try {
          const obj = JSON.parse(line) as {
            content?: string;
            thinking?: string;
            tool_calls?: Array<{ name?: string; arguments?: unknown }>;
          };
          if (typeof obj.content === "string") payloadText += `${obj.content}\n`;
          if (typeof obj.thinking === "string") payloadText += `${obj.thinking}\n`;
          if (Array.isArray(obj.tool_calls)) {
            for (const tc of obj.tool_calls) {
              payloadText += `${tc.name || ""}: ${JSON.stringify(tc.arguments || {})}\n`;
            }
          }
        } catch {
          payloadText += `${line}\n`;
        }
      }

      this.activeModel = detectedModel;
      const baseSystemTokens = Math.round(BASE_SYSTEM_PROMPT_CHARS / 3.8);
      const activePayloadTokens = countBpeTokens(payloadText);
      const totalTokens = activePayloadTokens + baseSystemTokens;
      const limit = this.getModelContextLimit(this.activeModel);

      this.currentUsage = {
        current: totalTokens,
        limit,
        model: this.activeModel,
        percent: limit > 0 ? Math.min(100, Math.round((totalTokens / limit) * 100)) : 0,
      };

      this.onContextChangeEmitter.fire(this.currentUsage);
    } catch { /* ignore compute error */ }
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
    this.onContextChangeEmitter.dispose();
  }
}
