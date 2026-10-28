/**
 * Mock Connect-RPC LanguageServerService for Bun Tests.
 * Simulates local Connect-RPC server (GetUserStatus, RetrieveUserQuotaSummary, Restart)
 * without ever executing or terminating live agy.exe.
 */

import * as http from "node:http";
import { LanguageServerClient, type LanguageServerInfo } from "../../src/core/language-server-client.js";

export interface MockUserStatusData {
  email?: string;
  name?: string;
  tier?: string;
}

export class MockLanguageServer {
  private server: http.Server | null = null;
  public port = 0;
  public csrfToken = "mock-csrf-token-xyz-12345";
  public userStatus: MockUserStatusData = {
    email: "mock-user@gmail.com",
    name: "Mock User",
    tier: "pro",
  };
  public quotaSummary: any = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          {
            displayName: "Gemini 1.5 Pro (5h)",
            window: "5h",
            remainingFraction: 0.85,
            resetTime: new Date(Date.now() + 3600000).toISOString(),
          },
          {
            displayName: "Gemini 1.5 Pro (7d)",
            window: "7d",
            remainingFraction: 0.95,
            resetTime: new Date(Date.now() + 86400000).toISOString(),
          },
        ],
      },
    ],
  };

  public restartSuccess = true;
  public simulateAuthError = false;

  public userStatusCalls = 0;
  public quotaSummaryCalls = 0;
  public restartCalls = 0;

  public async start(): Promise<{ port: number; csrfToken: string }> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const url = req.url || "";
        const token = req.headers["x-codeium-csrf-token"];

        if (this.simulateAuthError || token !== this.csrfToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        if (req.method === "POST" && url.endsWith("/GetUserStatus")) {
          this.userStatusCalls++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              userStatus: {
                email: this.userStatus.email,
                name: this.userStatus.name,
                userTier: {
                  id: this.userStatus.tier,
                },
              },
            }),
          );
        } else if (req.method === "POST" && url.endsWith("/RetrieveUserQuotaSummary")) {
          this.quotaSummaryCalls++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ response: this.quotaSummary }));
        } else if (req.method === "POST" && url.endsWith("/Restart")) {
          this.restartCalls++;
          if (this.restartSuccess) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Restart failed" }));
          }
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server?.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve({ port: this.port, csrfToken: this.csrfToken });
        } else {
          reject(new Error("Failed to get port from mock language server"));
        }
      });
    });
  }

  public async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server?.close(() => resolve());
      });
      this.server = null;
    }
  }

  public reset(): void {
    this.userStatusCalls = 0;
    this.quotaSummaryCalls = 0;
    this.restartCalls = 0;
    this.simulateAuthError = false;
    this.restartSuccess = true;
  }

  public createClient(): LanguageServerClient {
    const client = new LanguageServerClient("c:\\mock\\workspace");
    // Inject pre-cached mock info into client to prevent live process discovery
    const info: LanguageServerInfo = {
      port: this.port,
      csrfToken: this.csrfToken,
      workspaceDir: "c:\\mock\\workspace",
    };
    (client as any).cachedInfo = info;
    (client as any).cachedAt = Date.now();
    return client;
  }
}
