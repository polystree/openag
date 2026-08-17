import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ContextUsage } from "../types.js";

const BRAIN_DIR = path.join(os.homedir(), ".gemini", "antigravity-ide", "brain");

export class UsageTracker {
  private readonly modelContextLimits = new Map<string, number>();
  private activeModel = "gemini";
  private watchTimer: NodeJS.Timeout | null = null;
  private lastTranscriptPath = "";
  private lastTranscriptSize = 0;

  private readonly onContextChangeEmitter = new vscode.EventEmitter<ContextUsage>();
  public readonly onContextChange = this.onContextChangeEmitter.event;

  constructor() {
    void this.pollTranscript();
    this.watchTimer = setInterval(() => void this.pollTranscript(), 2500);
  }

  public registerModelMetadata(models: Record<string, { maxTokens?: number }>): void {
    for (const [id, meta] of Object.entries(models)) {
      if (meta.maxTokens && meta.maxTokens > 0) this.modelContextLimits.set(id.toLowerCase(), meta.maxTokens);
    }
  }

  public getActiveModel = (): string => this.activeModel;

  public getModelContextLimit(modelId?: string): number {
    const key = (modelId || this.activeModel || "").toLowerCase();
    return this.modelContextLimits.get(key) || (key.includes("gemini") ? 1048576 : key.includes("gpt") ? 128000 : 200000);
  }

  public updateContextUsage(model?: string, promptTokens = 0): ContextUsage {
    if (model) this.activeModel = model;
    const limit = this.getModelContextLimit(this.activeModel);
    const current = Math.max(0, promptTokens);
    const cu: ContextUsage = {
      current,
      limit,
      model: this.activeModel,
      percent: limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0,
    };
    this.onContextChangeEmitter.fire(cu);
    return cu;
  }

  private async detectModelFromTranscript(filePath: string): Promise<string> {
    try {
      const handle = await fs.promises.open(filePath, "r");
      const stat = await handle.stat();
      const bufSize = Math.min(stat.size, 8192);
      const buf = Buffer.alloc(bufSize);
      await handle.read(buf, 0, bufSize, 0);
      await handle.close();
      const text = buf.toString("utf-8");
      const match = text.match(/`Model Selection` from [^ ]+ to ([^.]+)\./i) || text.match(/"model":\s*"([^"]+)"/i);
      if (match?.[1]) return match[1].trim().toLowerCase().replace(/\s+/g, "-");
    } catch { /* ignore */ }
    return this.activeModel;
  }

  private async pollTranscript(): Promise<void> {
    try {
      const exists = await fs.promises.stat(BRAIN_DIR).then(() => true, () => false);
      if (!exists) return;
      const dirs = await fs.promises.readdir(BRAIN_DIR);
      let latestFile = "", latestMtime = 0, latestSize = 0;

      for (const d of dirs) {
        const p = path.join(BRAIN_DIR, d, ".system_generated", "logs", "transcript.jsonl");
        try {
          const stat = await fs.promises.stat(p);
          if (stat.mtimeMs > latestMtime) {
            latestMtime = stat.mtimeMs;
            latestFile = p;
            latestSize = stat.size;
          }
        } catch { /* ignore */ }
      }

      if (latestFile && (latestFile !== this.lastTranscriptPath || latestSize !== this.lastTranscriptSize)) {
        this.lastTranscriptPath = latestFile;
        this.lastTranscriptSize = latestSize;
        const model = await this.detectModelFromTranscript(latestFile);
        this.updateContextUsage(model, Math.round(latestSize / 3.8));
      }
    } catch { /* ignore */ }
  }

  public dispose(): void {
    if (this.watchTimer) { clearInterval(this.watchTimer); this.watchTimer = null; }
    this.onContextChangeEmitter.dispose();
  }
}
