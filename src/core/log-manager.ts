import * as vscode from "vscode";
import type { LogEntry } from "../types.js";

const MAX_LOGS = 200;

export class LogManager {
  private logs: LogEntry[] = [];
  private readonly onLogEmitter = new vscode.EventEmitter<LogEntry>();
  public readonly onLog = this.onLogEmitter.event;

  public addLog(level: LogEntry["level"], category: LogEntry["category"], message: string, details?: string): LogEntry {
    const entry: LogEntry = { id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, timestamp: Date.now(), level, category, message, details };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOGS) this.logs.shift();
    this.onLogEmitter.fire(entry);
    return entry;
  }

  public getLogs = (): LogEntry[] => [...this.logs];
  public clear = (): void => { this.logs = []; };
  public dispose = (): void => { this.onLogEmitter.dispose(); };
}
