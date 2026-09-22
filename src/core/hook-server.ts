import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { QuotaMonitor } from "./quota-monitor.js";
import type { TokenManager } from "./token-manager.js";

export const DEFAULT_HOOK_PORT = 27182;

export interface HookInvocationPayload {
  conversationId?: string;
  modelName?: string;
  invocationNum?: number;
  workspacePaths?: string[];
}

export class HookServer {
  private server: http.Server | null = null;
  private activePort: number = DEFAULT_HOOK_PORT;

  constructor(
    private readonly tokenManager: TokenManager,
    private readonly quotaMonitor: QuotaMonitor,
    private readonly log: (msg: string) => void,
  ) {}

  public start(port = DEFAULT_HOOK_PORT): Promise<number> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.method === "POST" && req.url === "/pre-invocation") {
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
                    rotated: true,
                    email: rotated.email,
                    percent: eff.percent,
                    model: targetModel,
                    activeEmail,
                  }),
                );
              } else {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ rotated: false, activeEmail }));
              }
            } catch (err: unknown) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
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

  public dispose(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch { /* ignore */ }
      this.server = null;
    }
  }

  public static registerGlobalHook(extensionPath: string): void {
    const configDir = path.join(os.homedir(), ".gemini", "config");
    const hooksConfigFile = path.join(configDir, "hooks.json");
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    let hooks: Record<string, unknown> = {};
    if (fs.existsSync(hooksConfigFile)) {
      try {
        hooks = JSON.parse(fs.readFileSync(hooksConfigFile, "utf8")) as Record<string, unknown>;
      } catch { /* ignore parse error */ }
    }

    const hookScriptPath = path.join(extensionPath, "dist", "hook.js");
    hooks["openag-auto-rotate"] = {
      enabled: true,
      PreInvocation: [{ type: "command", command: `node "${hookScriptPath}"`, timeout: 5 }],
    };

    fs.writeFileSync(hooksConfigFile, JSON.stringify(hooks, null, 2), "utf8");
  }

  public static removeGlobalHook(): void {
    const hooksConfigFile = path.join(os.homedir(), ".gemini", "config", "hooks.json");
    if (fs.existsSync(hooksConfigFile)) {
      try {
        const hooks = JSON.parse(fs.readFileSync(hooksConfigFile, "utf8")) as Record<string, unknown>;
        delete hooks["openag-auto-rotate"];
        fs.writeFileSync(hooksConfigFile, JSON.stringify(hooks, null, 2), "utf8");
      } catch { /* ignore */ }
    }
  }
}
