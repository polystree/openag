import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextUsage } from "../types.js";
import { aggregateBlockTokens, readGenMetadata } from "./gen-metadata-reader.js";
import { BRAIN_DIR, getConvDirs, resolveTranscriptPath, withSqliteDb } from "./sqlite-utils.js";
import {
  extractAntigravityTitle,
  formatDynamicModelName,
  parseTranscriptLines,
  type StatsManager,
} from "./stats-manager.js";

export function normalizePath(p: string): string {
  if (!p) return "";
  try {
    p = decodeURIComponent(p);
  } catch {
    // Retain un-decoded string if malformed URI component
  }

  let norm = p.replace(/\\/g, "/").toLowerCase().trim();

  norm = norm.replace(/^(?:vscode-remote|file):\/\//, "");

  // Strip WSL or remote authorities (e.g. wsl+ubuntu/, wsl%2bubuntu/, wsl$/, wsl.localhost/, ssh-remote+.../)
  norm = norm.replace(/^(?:wsl\+|wsl%2b|ssh-remote\+|dev-container\+)[^/]+\//, "");
  norm = norm.replace(/^(?:wsl\$|wsl\.localhost)\/[^/]+\//, "");

  norm = norm.replace(/^\/+/, "").replace(/\/+$/, "");

  return norm;
}

export function extractUriFromText(text: string): string | null {
  const m = text.match(/(?:file|vscode-remote):\/\/[a-zA-Z0-9_.:~%+/$-]+/i);
  return m ? normalizePath(m[0]) : null;
}

export class UsageTracker {
  private activeModel = "";
  private readonly modelContextLimits = new Map<string, number>();
  private currentUsage: ContextUsage = {
    current: 0,
    limit: 1048576,
    model: "",
    percent: 0,
  };

  private activeConversationId: string | null = null;
  private activeTranscriptPath: string | null = null;
  private workspacePaths: string[] = [];
  private lastProcessedLineCount = 0;
  private lastProcessedPath: string | null = null;
  private lastProcessedGenIdx = 0;
  private lastByteOffset = 0;
  private cachedLines: string[] = [];
  private trailingRemainder = "";
  private lastReportedRateLimitLine = -1;
  private lastRateLimitTime = 0;
  private isComputing = false;

  private readonly dbWorkspaceCache = new Map<string, { mtime: number; size: number; uri: string | null }>();

  private transcriptWatcher: fs.FSWatcher | null = null;
  private convDirWatchers: fs.FSWatcher[] = [];
  private pollInterval: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;

  private readonly onContextChangeEmitter = new vscode.EventEmitter<ContextUsage>();
  public readonly onContextChange = this.onContextChangeEmitter.event;

  private readonly onRateLimitEmitter = new vscode.EventEmitter<{ model: string; error: string }>();
  public readonly onRateLimit = this.onRateLimitEmitter.event;

  constructor(
    private readonly statsManager?: StatsManager,
    private readonly logger?: (msg: string) => void,
  ) {
    this.initWatchers();
    this.refresh();
    this.pollInterval = setInterval(() => this.refresh(), 10000);
    if (this.statsManager) {
      void this.statsManager.backfillFromTranscripts();
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
    this.lastByteOffset = 0;
    this.cachedLines = [];
    this.trailingRemainder = "";
    this.scheduleCompute();
  }

  public refresh(): void {
    const convId = this.resolveActiveConversationId();
    if (!convId) return;

    if (convId !== this.activeConversationId) {
      this.activeConversationId = convId;
      this.activeTranscriptPath =
        resolveTranscriptPath(convId) ||
        path.join(BRAIN_DIR, convId, ".system_generated", "logs", "transcript.jsonl");
      this.lastProcessedLineCount = 0;
      this.lastProcessedPath = null;
      this.lastByteOffset = 0;
      this.cachedLines = [];
      this.trailingRemainder = "";
      this.attachTranscriptWatcher();
    }

    this.scheduleCompute();
  }

  private initWatchers(): void {
    for (const dir of getConvDirs()) {
      try {
        if (fs.existsSync(dir)) {
          const watcher = fs.watch(dir, { persistent: false }, () => {
            this.scheduleCompute();
          });
          this.convDirWatchers.push(watcher);
        }
      } catch (e: unknown) {
        this.logger?.(`[UsageTracker] Watcher setup failed for dir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
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
    } catch (e: unknown) {
      this.logger?.(`[UsageTracker] Transcript watcher setup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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

      let uri = withSqliteDb(dbPath, (db) => {
        const row = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id=?").get<{ data?: Uint8Array | Buffer }>("main");
        return row?.data ? extractUriFromText(Buffer.from(row.data).toString("utf-8")) : null;
      });

      if (!uri) {
        let fd: number | null = null;
        try {
          fd = fs.openSync(dbPath, "r");
          const readLen = Math.min(st.size, 65536);
          const buf = Buffer.alloc(readLen);
          fs.readSync(fd, buf, 0, readLen, 0);
          uri = extractUriFromText(buf.toString("utf-8"));
        } catch (e: unknown) {
          this.logger?.(`[UsageTracker] Binary scan error for ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          if (fd !== null) {
            try {
              fs.closeSync(fd);
            } catch (e: unknown) {
              this.logger?.(`[UsageTracker] Failed to close fd for ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }
      }

      this.dbWorkspaceCache.set(dbPath, { mtime: st.mtimeMs, size: st.size, uri });
      return uri;
    } catch (e: unknown) {
      this.logger?.(`[UsageTracker] extractWorkspaceUriFromDb error for ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  private resolveActiveConversationId(): string | null {
    const convDirs = getConvDirs();
    const fileStats: Array<{ name: string; fullPath: string; mtime: number }> = [];

    for (const dir of convDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith(".db"));
        for (const f of files) {
          const fullPath = path.join(dir, f);
          try {
            const st = fs.statSync(fullPath);
            fileStats.push({ name: f, fullPath, mtime: st.mtimeMs });
          } catch (e: unknown) {
            this.logger?.(`[UsageTracker] Stat failed for ${fullPath}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e: unknown) {
        this.logger?.(`[UsageTracker] Readdir failed for ${dir}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (fileStats.length === 0) return null;
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
  }

  private async computeContextUsage(): Promise<void> {
    if (this.isComputing || !this.activeTranscriptPath || !fs.existsSync(this.activeTranscriptPath)) return;
    this.isComputing = true;

    try {
      const isPathChanged = this.lastProcessedPath !== this.activeTranscriptPath;
      if (isPathChanged) {
        this.lastProcessedLineCount = 0;
        this.lastProcessedPath = this.activeTranscriptPath;
        this.lastProcessedGenIdx = 0;
        this.lastByteOffset = 0;
        this.cachedLines = [];
        this.trailingRemainder = "";
      }

      const st = await fs.promises.stat(this.activeTranscriptPath);
      if (st.size < this.lastByteOffset) {
        this.lastByteOffset = 0;
        this.cachedLines = [];
        this.trailingRemainder = "";
        this.lastProcessedLineCount = 0;
        this.lastProcessedGenIdx = 0;
      }

      if (st.size > this.lastByteOffset) {
        const bytesToRead = st.size - this.lastByteOffset;
        const handle = await fs.promises.open(this.activeTranscriptPath, "r");
        try {
          const buf = Buffer.alloc(bytesToRead);
          const { bytesRead } = await handle.read(buf, 0, bytesToRead, this.lastByteOffset);
          this.lastByteOffset += bytesRead;
          const chunk = this.trailingRemainder + buf.toString("utf8", 0, bytesRead);
          const split = chunk.split("\n");
          if (chunk.endsWith("\n")) {
            this.trailingRemainder = "";
          } else {
            this.trailingRemainder = split.pop() ?? "";
          }
          for (const l of split) {
            const trimmed = l.trim();
            if (trimmed) this.cachedLines.push(trimmed);
          }
        } finally {
          await handle.close();
        }
      }

      const lines = this.cachedLines;
      if (lines.length === 0) return;

      const convTitle = this.activeConversationId ? extractAntigravityTitle(this.activeConversationId) : "";
      const parsed = parseTranscriptLines(lines, "", convTitle);

      // Read gen_metadata for exact token counts and context window
      const genMetrics = this.activeConversationId ? readGenMetadata(this.activeConversationId) : null;

      if (genMetrics?.latestModel) {
        const formatted = formatDynamicModelName(genMetrics.latestModel);
        if (formatted) this.activeModel = formatted;
      } else if (parsed.detectedModel) {
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

      if (
        parsed.rateLimitErrorLine >= 0 &&
        parsed.rateLimitErrorLine > this.lastReportedRateLimitLine &&
        parsed.rateLimitErrorLine >= lines.length - 3 &&
        Date.now() - this.lastRateLimitTime > 5000
      ) {
        this.lastReportedRateLimitLine = parsed.rateLimitErrorLine;
        this.lastRateLimitTime = Date.now();
        this.onRateLimitEmitter.fire({
          model: this.activeModel,
          error: parsed.rateLimitErrorDetail || "RESOURCE_EXHAUSTED",
        });
      }

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
              agg.thinkingTokens,
              agg.contentTokens,
            );
          }
        }
        this.lastProcessedLineCount = parsed.completedEndLine;
        this.lastProcessedPath = this.activeTranscriptPath;
      }
    } catch (e: unknown) {
      this.logger?.(`[UsageTracker] computeContextUsage failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
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
    for (const watcher of this.convDirWatchers) {
      try {
        watcher.close();
      } catch (e: unknown) {
        this.logger?.(`[UsageTracker] Watcher close failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.convDirWatchers = [];
    this.dbWorkspaceCache.clear();
    this.onContextChangeEmitter.dispose();
    this.onRateLimitEmitter.dispose();
  }
}
