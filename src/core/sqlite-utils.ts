import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const NON_IDE_ROOT = path.join(os.homedir(), ".gemini", "antigravity");
export const IDE_ROOT = path.join(os.homedir(), ".gemini", "antigravity-ide");

export const NON_IDE_BRAIN_DIR = path.join(NON_IDE_ROOT, "brain");
export const NON_IDE_CONV_DIR = path.join(NON_IDE_ROOT, "conversations");

export const IDE_BRAIN_DIR = path.join(IDE_ROOT, "brain");
export const IDE_CONV_DIR = path.join(IDE_ROOT, "conversations");

// The VS Code based IDE runs `agy --hub --app_data_dir=antigravity`, so its data lives in ~/.gemini/antigravity.
export const BRAIN_DIR = fs.existsSync(NON_IDE_BRAIN_DIR) ? NON_IDE_BRAIN_DIR : IDE_BRAIN_DIR;
export const CONV_DIR = fs.existsSync(NON_IDE_CONV_DIR) ? NON_IDE_CONV_DIR : IDE_CONV_DIR;

function getWslDirs(): { brain: string[]; conv: string[] } {
  const brain: string[] = [];
  const conv: string[] = [];
  if (process.platform === "linux" && fs.existsSync("/mnt/c/Users")) {
    try {
      const users = fs.readdirSync("/mnt/c/Users", { withFileTypes: true });
      for (const u of users) {
        if (u.isDirectory() && u.name !== "Public" && u.name !== "Default" && !u.name.startsWith(".")) {
          const ideB = path.join("/mnt/c/Users", u.name, ".gemini", "antigravity-ide", "brain");
          const ideC = path.join("/mnt/c/Users", u.name, ".gemini", "antigravity-ide", "conversations");
          const nonIdeB = path.join("/mnt/c/Users", u.name, ".gemini", "antigravity", "brain");
          const nonIdeC = path.join("/mnt/c/Users", u.name, ".gemini", "antigravity", "conversations");
          if (fs.existsSync(ideB)) brain.push(ideB);
          if (fs.existsSync(ideC)) conv.push(ideC);
          if (fs.existsSync(nonIdeB)) brain.push(nonIdeB);
          if (fs.existsSync(nonIdeC)) conv.push(nonIdeC);
        }
      }
    } catch { /* ignore */ }
  }
  return { brain, conv };
}

export function getBrainDirs(): string[] {
  const dirs: string[] = [];
  if (fs.existsSync(NON_IDE_BRAIN_DIR)) dirs.push(NON_IDE_BRAIN_DIR);
  if (fs.existsSync(IDE_BRAIN_DIR)) dirs.push(IDE_BRAIN_DIR);
  const wsl = getWslDirs();
  for (const b of wsl.brain) {
    if (!dirs.includes(b)) dirs.push(b);
  }
  return dirs.length > 0 ? dirs : [NON_IDE_BRAIN_DIR, IDE_BRAIN_DIR];
}

export function getConvDirs(): string[] {
  const dirs: string[] = [];
  if (fs.existsSync(NON_IDE_CONV_DIR)) dirs.push(NON_IDE_CONV_DIR);
  if (fs.existsSync(IDE_CONV_DIR)) dirs.push(IDE_CONV_DIR);
  const wsl = getWslDirs();
  for (const c of wsl.conv) {
    if (!dirs.includes(c)) dirs.push(c);
  }
  return dirs.length > 0 ? dirs : [NON_IDE_CONV_DIR, IDE_CONV_DIR];
}

export function resolveConversationDb(convId: string): string | null {
  const cleanId = convId.endsWith(".db") ? convId.slice(0, -3) : convId;
  for (const dir of getConvDirs()) {
    const candidate = path.join(dir, `${cleanId}.db`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveTranscriptPath(convId: string): string | null {
  for (const dir of getBrainDirs()) {
    const candidate = path.join(dir, convId, ".system_generated", "logs", "transcript.jsonl");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export type SqliteParam = string | number | bigint | null | undefined;
export type SqliteValue = string | number | bigint | Uint8Array | Buffer | null | undefined;

export interface SqliteStatement {
  all: <T = Record<string, SqliteValue>>(param?: SqliteParam) => T[];
  get: <T = Record<string, SqliteValue>>(param?: SqliteParam) => T | undefined;
}

export interface SqliteDb {
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
}

export interface SqliteModule {
  DatabaseSync: new (p: string, opts?: { readOnly?: boolean; open?: boolean }) => SqliteDb;
}

let cachedSqlite: SqliteModule | null | undefined;

export function loadSqlite(): SqliteModule | null {
  if (cachedSqlite !== undefined) return cachedSqlite;
  try {
    // SAFETY: node:sqlite built-in DatabaseSync matches SqliteModule contract
    cachedSqlite = require("node:sqlite") as SqliteModule;
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite;
}

export function withSqliteDb<T>(dbPath: string, fn: (db: SqliteDb) => T): T | null {
  const sqlite = loadSqlite();
  if (!sqlite) return null;

  let db: SqliteDb | null = null;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true, open: true });
    return fn(db);
  } catch {
    return null;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // Suppress closing error if already closed or invalid
      }
    }
  }
}

