import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { QuotaMonitor } from "./quota-monitor.js";
import type { TokenManager } from "./token-manager.js";

export const DEFAULT_HOOK_PORT = 27182;

export function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    return code === "EPERM";
  }
}

export interface IpcSessionEntry {
  pid: number;
  port: number;
  authToken: string;
  workspacePath?: string;
  updatedAt: number;
}

export interface IpcDiscoveryData {
  port: number;
  authToken: string;
  pid: number;
  updatedAt: number;
  sessions?: IpcSessionEntry[];
}

export interface HookInvocationPayload {
  conversationId?: string;
  modelName?: string;
  invocationNum?: number;
  workspacePaths?: string[];
}

export class HookServer {
  private server: http.Server | null = null;
  private activePort: number = DEFAULT_HOOK_PORT;
  private authToken: string = "";
  private ipcFilePath: string = "";

  constructor(
    private readonly tokenManager: TokenManager,
    private readonly quotaMonitor: QuotaMonitor,
    private readonly log: (msg: string) => void,
    private readonly workspacePath?: string,
  ) {}

  public start(port = DEFAULT_HOOK_PORT): Promise<number> {
    this.authToken = crypto.randomUUID();
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/pre-invocation") {
          const authHeader = req.headers["x-openag-auth"];
          if (this.authToken && authHeader !== this.authToken) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Unauthorized" }));
            return;
          }

          let body = "";
          req.on("data", (chunk) => {
            body += String(chunk);
            if (body.length > 65536) req.destroy();
          });

          req.on("end", async () => {
            try {
              let payload: HookInvocationPayload = {};
              if (body.trim()) {
                // SAFETY: parse JSON hook input payload
                payload = JSON.parse(body.trim()) as HookInvocationPayload;
              }

              this.quotaMonitor.notifyActivity?.();

              const targetModel = payload.modelName || "";
              const rotated = await this.tokenManager.autoSelectHighestQuota(
                this.quotaMonitor.getAllQuotas(),
                "PreInvocation Hook",
                targetModel,
              );

              const activeEmail = this.tokenManager.getActiveEmail();
              if (rotated) {
                const eff = this.tokenManager.getEffectiveQuota(
                  rotated.email,
                  this.quotaMonitor.getAllQuotas(),
                  targetModel,
                );
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    decision: "allow",
                    rotated: true,
                    email: rotated.email,
                    percent: eff.percent,
                    model: targetModel,
                    activeEmail,
                  }),
                );
              } else {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ decision: "allow", rotated: false, activeEmail }));
              }
            } catch (err: unknown) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ decision: "allow", rotated: false, error: err instanceof Error ? err.message : String(err) }));
            }
          });
        } else if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", activeAccount: this.tokenManager.getActiveEmail() }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.log(`[HookServer] Port ${port} in use, retrying on dynamic port`);
          this.server?.listen(0, "127.0.0.1");
        } else {
          this.log(`[HookServer] Failed to start: ${err.message}`);
          resolve(0);
        }
      });

      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.activePort = addr.port;
          this.writeIpcDiscovery(this.activePort, this.authToken);
          this.log(`[HookServer] Listening on http://127.0.0.1:${this.activePort}`);
          resolve(this.activePort);
        } else {
          resolve(port);
        }
      });
    });
  }

  public getPort(): number {
    return this.activePort;
  }

  public getAuthToken(): string {
    return this.authToken;
  }

  public static getIpcFilePath(): string {
    return process.env.OPENAG_IPC_PATH || path.join(os.homedir(), ".gemini", "openag", "ipc.json");
  }

  private writeIpcDiscovery(port: number, authToken: string): void {
    try {
      const ipcFile = HookServer.getIpcFilePath();
      this.ipcFilePath = ipcFile;
      const dir = path.dirname(ipcFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let sessions: IpcSessionEntry[] = [];
      if (fs.existsSync(ipcFile)) {
        try {
          const raw = fs.readFileSync(ipcFile, "utf8");
          const existing = JSON.parse(raw) as IpcDiscoveryData;
          if (Array.isArray(existing.sessions)) {
            sessions = existing.sessions.filter(
              (s) => s.pid !== process.pid && isPidAlive(s.pid) && Date.now() - (s.updatedAt || 0) < 86400000,
            );
          } else if (existing.pid && existing.pid !== process.pid && isPidAlive(existing.pid)) {
            sessions.push({
              pid: existing.pid,
              port: existing.port,
              authToken: existing.authToken,
              updatedAt: existing.updatedAt || Date.now(),
            });
          }
        } catch { /* ignore corrupted file */ }
      }

      const myEntry: IpcSessionEntry = {
        pid: process.pid,
        port,
        authToken,
        workspacePath: this.workspacePath,
        updatedAt: Date.now(),
      };
      sessions.unshift(myEntry);

      const descriptor: IpcDiscoveryData = {
        port,
        authToken,
        pid: process.pid,
        updatedAt: Date.now(),
        sessions,
      };
      fs.writeFileSync(ipcFile, JSON.stringify(descriptor, null, 2), "utf8");
      this.log(`[HookServer] Wrote IPC discovery descriptor to ${ipcFile} (active sessions: ${sessions.length})`);
    } catch (err: unknown) {
      this.log(`[HookServer] Failed to write IPC discovery descriptor: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private removeIpcDiscovery(): void {
    try {
      const ipcFile = this.ipcFilePath || HookServer.getIpcFilePath();
      if (!fs.existsSync(ipcFile)) return;
      let sessions: IpcSessionEntry[] = [];
      try {
        const raw = fs.readFileSync(ipcFile, "utf8");
        const existing = JSON.parse(raw) as IpcDiscoveryData;
        if (Array.isArray(existing.sessions)) {
          sessions = existing.sessions.filter((s) => s.pid !== process.pid && isPidAlive(s.pid));
        }
      } catch {
        sessions = [];
      }

      if (sessions.length === 0) {
        fs.unlinkSync(ipcFile);
        this.log(`[HookServer] Removed IPC discovery descriptor at ${ipcFile}`);
      } else {
        const primary = sessions[0]!;
        const updatedDescriptor: IpcDiscoveryData = {
          port: primary.port,
          authToken: primary.authToken,
          pid: primary.pid,
          updatedAt: primary.updatedAt,
          sessions,
        };
        fs.writeFileSync(ipcFile, JSON.stringify(updatedDescriptor, null, 2), "utf8");
        this.log(`[HookServer] De-registered session PID ${process.pid}; active sessions remaining: ${sessions.length}`);
      }
    } catch (err: unknown) {
      this.log(`[HookServer] Error cleaning up IPC file: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public dispose(): void {
    this.removeIpcDiscovery();
    if (this.server) {
      try {
        this.server.close();
      } catch { /* ignore */ }
      this.server = null;
    }
  }

  public static registerGlobalHook(extensionPath: string, customConfigDir?: string): void {
    const configDir = customConfigDir || path.join(os.homedir(), ".gemini", "config");
    const hooksConfigFile = path.join(configDir, "hooks.json");
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    let hooksConfig: Record<string, unknown> = {};
    if (fs.existsSync(hooksConfigFile)) {
      try {
        hooksConfig = JSON.parse(fs.readFileSync(hooksConfigFile, "utf8")) as Record<string, unknown>;
      } catch {
        hooksConfig = {};
      }
    }

    const hookScriptPath = path.join(extensionPath, "dist", "hook.js");
    const commandStr = `node "${hookScriptPath}"`;

    const targetHook = {
      type: "command",
      command: commandStr,
      timeout: 5,
    };

    let preInvocation = hooksConfig.PreInvocation;
    if (!Array.isArray(preInvocation)) {
      preInvocation = [];
      hooksConfig.PreInvocation = preInvocation;
    }

    interface HookItem {
      type?: string;
      command?: string;
      timeout?: number;
      [key: string]: unknown;
    }
    interface MatcherEntry {
      matcher?: string;
      hooks?: HookItem[];
      [key: string]: unknown;
    }

    const matchers = preInvocation as MatcherEntry[];
    let found = false;
    for (const matcherEntry of matchers) {
      if (Array.isArray(matcherEntry.hooks)) {
        for (let i = 0; i < matcherEntry.hooks.length; i++) {
          const h = matcherEntry.hooks[i];
          if (typeof h?.command === "string" && h.command.includes("hook.js")) {
            matcherEntry.hooks[i] = targetHook;
            found = true;
            break;
          }
        }
      }
      if (found) break;
    }

    if (!found) {
      const allMatcher = matchers.find((m) => m && m.matcher === ".*");
      if (allMatcher && Array.isArray(allMatcher.hooks)) {
        allMatcher.hooks.push(targetHook);
      } else {
        matchers.push({
          matcher: ".*",
          hooks: [targetHook],
        });
      }
    }

    fs.writeFileSync(hooksConfigFile, JSON.stringify(hooksConfig, null, 2) + "\n", "utf8");
  }

  public static removeGlobalHook(customConfigDir?: string): void {
    const configDir = customConfigDir || path.join(os.homedir(), ".gemini", "config");
    const hooksConfigFile = path.join(configDir, "hooks.json");
    if (!fs.existsSync(hooksConfigFile)) return;

    try {
      const hooksConfig = JSON.parse(fs.readFileSync(hooksConfigFile, "utf8")) as Record<string, unknown>;
      if (Array.isArray(hooksConfig.PreInvocation)) {
        interface HookItem {
          type?: string;
          command?: string;
          timeout?: number;
          [key: string]: unknown;
        }
        interface MatcherEntry {
          matcher?: string;
          hooks?: HookItem[];
          [key: string]: unknown;
        }

        const matchers = hooksConfig.PreInvocation as MatcherEntry[];
        const filtered = matchers
          .map((m) => {
            if (!Array.isArray(m.hooks)) return m;
            return {
              ...m,
              hooks: m.hooks.filter((h) => typeof h?.command !== "string" || !h.command.includes("hook.js")),
            };
          })
          .filter((m) => Array.isArray(m.hooks) && m.hooks.length > 0);

        if (filtered.length === 0) {
          delete hooksConfig.PreInvocation;
        } else {
          hooksConfig.PreInvocation = filtered;
        }

        fs.writeFileSync(hooksConfigFile, JSON.stringify(hooksConfig, null, 2) + "\n", "utf8");
      }
    } catch {
      /* ignore */
    }
  }
}
