import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextUsage } from "../types.js";
import { aggregateBlockTokens, readGenMetadata } from "./gen-metadata-reader.js";
import { BRAIN_DIR, CONV_DIR, loadSqlite } from "./sqlite-utils.js";
import {
  extractAntigravityTitle,
  formatDynamicModelName,
  parseTranscriptLines,
  type StatsManager,
} from "./stats-manager.js";

function normalizePath(p: string): string {
  if (!p) return "";
  try {
    p = decodeURIComponent(p);
  } catch { /* ignore */ }
  return p.replace(/\\/g, "/").toLowerCase().replace(/^file:\/\/\/?/, "").replace(/^\/+/, "").replace(/\/$/, "");
}

function extractUriFromText(text: string): string | null {
  const m = text.match(/file:\/\/\/[-a-zA-Z0-9_.:~%+/]+/i);
  return m ? normalizePath(m[0]) : null;
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
  private lastProcessedGenIdx = 0;
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
      void this.statsManager.backfillFromTranscripts(BRAIN_DIR);
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

  public resetProcessedLines(): void {
    this.lastProcessedLineCount = 0;
    this.lastProcessedPath = null;
    this.scheduleCompute();
  }

  public refresh(): void {
    const convId = this.resolveActiveConversationId();
    if (!convId) return;

    if (convId !== this.activeConversationId) {
      this.activeConversationId = convId;
      this.activeTranscriptPath = path.join(BRAIN_DIR, convId, ".system_generated", "logs", "transcript.jsonl");
      this.lastProcessedLineCount = 0;
      this.lastProcessedPath = null;
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
      const sqlite = loadSqlite();

      if (sqlite) {
        try {
          const db = new sqlite.DatabaseSync(dbPath, { readOnly: true, open: true });
          const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id=?").get<{ data?: Uint8Array | Buffer }>("main");
          db.close();
          if (row?.data) {
            uri = extractUriFromText(Buffer.from(row.data).toString("utf-8"));
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
          uri = extractUriFromText(buf.toString("utf-8"));
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

      const isPathChanged = this.lastProcessedPath !== this.activeTranscriptPath;
      const convTitle = this.activeConversationId ? extractAntigravityTitle(this.activeConversationId) : "";
      const parsed = parseTranscriptLines(lines, "", convTitle);

      if (isPathChanged) {
        this.lastProcessedLineCount = 0;
        this.lastProcessedPath = this.activeTranscriptPath;
        this.lastProcessedGenIdx = 0;
      }

      // Read gen_metadata for exact token counts and context window
      const genMetrics = this.activeConversationId ? readGenMetadata(this.activeConversationId) : null;

      if (genMetrics?.latestModel) {
        const formatted = formatDynamicModelName(genMetrics.latestModel);
        if (formatted) this.activeModel = formatted;
      } else {
        this.activeModel = parsed.detectedModel;
      }

      const limit = this.getModelContextLimit(this.activeModel);
      const contextTokens = genMetrics ? genMetrics.contextTokens : 0;

      this.currentUsage = {
        current: contextTokens,
        limit,
        model: this.activeModel,
        percent: limit > 0 ? Math.min(100, Math.round((contextTokens / limit) * 100)) : 0,
      };

      this.onContextChangeEmitter.fire(this.currentUsage);

      // Record completed request blocks with exact gen_metadata token counts
      if (this.statsManager && this.activeConversationId) {
        const turns = genMetrics?.turns || [];

        for (const block of parsed.completedBlocks) {
          if (block.endLine > this.lastProcessedLineCount && block.turnCount > 0) {
            const dateObj = new Date(block.timestamp);
            const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")}`;

            const agg = aggregateBlockTokens(turns, block.startTurnIdx, block.endTurnIdx);
            const blockModel = agg.model
              ? (formatDynamicModelName(agg.model) || this.activeModel)
              : this.activeModel;
            if (agg.maxGenIdx > this.lastProcessedGenIdx) {
              this.lastProcessedGenIdx = agg.maxGenIdx;
            }

            this.statsManager.recordTokens(
              dateStr,
              blockModel,
              this.activeConversationId,
              convTitle,
              "",
              agg.inputTokens,
              agg.outputTokens,
              agg.cacheHitTokens,
              agg.cacheMissTokens,
              block.promptText,
              block.timestamp,
              block.turnCount,
            );
          }
        }
        this.lastProcessedLineCount = parsed.completedEndLine;
        this.lastProcessedPath = this.activeTranscriptPath;
      }
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
