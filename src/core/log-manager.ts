import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { LogEntry } from "../types.js";

const MAX_LOGS = 200;
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
const KEY_LOGS = "openag.logs.v1";

export class LogManager {
  private logs: LogEntry[] = [];
  private readonly onLogEmitter = new vscode.EventEmitter<LogEntry>();
  public readonly onLog = this.onLogEmitter.event;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(private readonly context?: vscode.ExtensionContext) {
    if (this.context) {
      const saved = this.context.globalState.get<LogEntry[]>(KEY_LOGS, []);
      if (Array.isArray(saved)) {
        this.logs = saved;
      }
    }
    this.cleanupLogs();
    this.cleanupTimer = setInterval(() => this.cleanupLogs(), 3600000);
  }

  public addLog(level: LogEntry["level"], category: LogEntry["category"], message: string, details?: string): LogEntry {
    const entry: LogEntry = {
      id: `log_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
      timestamp: Date.now(),
      level,
      category,
      message,
      details,
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) {
      this.logs.splice(0, this.logs.length - MAX_LOGS);
    }
    this.schedulePersist();
    this.onLogEmitter.fire(entry);
    return entry;
  }

  public getLogs(): LogEntry[] {
    return [...this.logs];
  }

  public clear(): void {
    this.logs = [];
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.context) {
      void this.context.globalState.update(KEY_LOGS, []);
    }
  }

  public cleanupLogs(): void {
    const cutoff = Date.now() - TWENTY_FOUR_HOURS;
    this.logs = this.logs.filter((l) => l.timestamp >= cutoff);
    if (this.logs.length > MAX_LOGS) {
      this.logs = this.logs.slice(this.logs.length - MAX_LOGS);
    }
    this.persist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 1000);
  }

  private persist(): void {
    if (this.context) {
      void this.context.globalState.update(KEY_LOGS, this.logs);
    }
  }

  public dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
      this.persist();
    }
    this.onLogEmitter.dispose();
  }
}
