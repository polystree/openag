import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { OSKeyring } from "../../src/core/os-keyring.js";
import { LanguageServerClient } from "../../src/core/language-server-client.js";
import { MockLanguageServer } from "../mocks/language-server.js";
import type { OAuthTokens } from "../../src/types.js";

describe("F7 & F10: OS Keyring Integration & Secret Safety", () => {
  let mockServer: MockLanguageServer;

  beforeEach(async () => {
    mockServer = new MockLanguageServer();
    await mockServer.start();
  });

  afterEach(async () => {
    await mockServer.stop();
  });

  describe("Tier 1: Credential Payload Formatting & Stdin Piping", () => {
    it("T1.1: rejects credential write when email or accessToken is missing", async () => {
      const res1 = await OSKeyring.writeCredential("", {
        accessToken: "valid-tok",
        refreshToken: "valid-ref",
        expiryDateSeconds: 123456,
      });
      expect(res1).toBe(false);

      const res2 = await OSKeyring.writeCredential("test@gmail.com", {
        accessToken: "",
        refreshToken: "valid-ref",
        expiryDateSeconds: 123456,
      });
      expect(res2).toBe(false);
    });

    it("T1.2: formats KeyringTokenPayload with consumer auth_method, token structure, and ISO expiry", async () => {
      let capturedStdin = "";

      // Mock spawn to inspect stdin and cli args
      const spawnSpy = spyOn(childProcess, "spawn").mockImplementation((_cmd: any, args: any) => {
        // Assert that accessToken never appears in process CLI arguments!
        for (const arg of args as string[]) {
          expect(arg).not.toContain("super-secret-access-token-999");
          expect(arg).not.toContain("super-secret-refresh-token-888");
        }

        const mockChild: any = {
          stdin: {
            on: () => {},
            write: (chunk: string) => {
              capturedStdin += chunk;
            },
            end: () => {
              mockChild.emit("close", 0);
            },
          },
          on: (event: string, cb: any) => {
            if (event === "close") {
              setTimeout(() => cb(0), 10);
            }
          },
          emit: () => {},
        };
        return mockChild;
      });

      try {
        const tokens: OAuthTokens = {
          accessToken: "super-secret-access-token-999",
          refreshToken: "super-secret-refresh-token-888",
          expiryDateSeconds: Math.floor(Date.now() / 1000) + 3600,
          tokenType: "Bearer",
        };

        const ok = await OSKeyring.writeCredential("secure-user@gmail.com", tokens);
        expect(ok).toBe(true);
        expect(capturedStdin.length).toBeGreaterThan(0);

        const parsed = JSON.parse(capturedStdin);
        expect(parsed.auth_method).toBe("consumer");
        expect(parsed.id_token_email).toBe("secure-user@gmail.com");
        expect(parsed.token.access_token).toBe("super-secret-access-token-999");
        expect(parsed.token.refresh_token).toBe("super-secret-refresh-token-888");
        expect(parsed.token.token_type).toBe("Bearer");
        expect(parsed.token.expires_in).toBeGreaterThan(0);
        expect(parsed.token.expiry).toBeDefined();
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it("T1.3: macOS writeMacCredential pipes commands to security -i without CLI token leaks", async () => {
      let capturedArgs: string[] = [];
      let capturedStdin = "";

      const spawnSpy = spyOn(childProcess, "spawn").mockImplementation((cmd: any, args: any) => {
        capturedArgs = args as string[];
        const mockChild: any = {
          stdin: {
            on: () => {},
            write: (chunk: string) => {
              capturedStdin += chunk;
            },
            end: () => {},
          },
          on: (event: string, cb: any) => {
            if (event === "close") setTimeout(() => cb(0), 10);
          },
        };
        return mockChild;
      });

      try {
        await (OSKeyring as any).writeMacCredential(JSON.stringify({ secret: "token-abc" }));
        expect(capturedArgs).toEqual(["-i"]);
        // Command line args MUST NOT contain token
        expect(capturedArgs.join(" ")).not.toContain("token-abc");
        // Stdin MUST contain the piped security command
        expect(capturedStdin).toContain("token-abc");
        expect(capturedStdin).toContain("add-generic-password");
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it("T1.4: LanguageServerClient restartServer signals /Restart Connect-RPC endpoint", async () => {
      const client = mockServer.createClient();

      const success = await client.restartServer();
      expect(success).toBe(true);
      expect(mockServer.restartCalls).toBe(1);
    });

    it("T1.5: restartServer invalidates cached process info on completion", async () => {
      const client = mockServer.createClient();
      expect((client as any).cachedInfo).not.toBeNull();

      await client.restartServer();
      expect((client as any).cachedInfo).toBeNull();
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: Keyring child process error cleanly resolves to false without throwing", async () => {
      const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
        const mockChild: any = {
          stdin: { on: () => {}, write: () => {}, end: () => {} },
          on: (event: string, cb: any) => {
            if (event === "error") setTimeout(() => cb(new Error("Process spawn failure")), 10);
          },
        };
        return mockChild;
      });

      try {
        const ok = await OSKeyring.writeCredential("err@gmail.com", {
          accessToken: "tok",
          refreshToken: "ref",
          expiryDateSeconds: 12345,
        });
        expect(ok).toBe(false);
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it("T2.2: Non-zero child process exit code resolves to false", async () => {
      const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
        const mockChild: any = {
          stdin: { on: () => {}, write: () => {}, end: () => {} },
          on: (event: string, cb: any) => {
            if (event === "close") setTimeout(() => cb(2), 10); // exit code 2
          },
        };
        return mockChild;
      });

      try {
        const ok = await OSKeyring.writeCredential("err2@gmail.com", {
          accessToken: "tok",
          refreshToken: "ref",
          expiryDateSeconds: 12345,
        });
        expect(ok).toBe(false);
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it("T2.3: LanguageServerClient restartServer handles 500 error gracefully", async () => {
      mockServer.restartSuccess = false;
      const client = mockServer.createClient();

      const result = await client.restartServer();
      // Connect-RPC catch handler handles server error
      expect(typeof result).toBe("boolean");
    });

    it("T2.4: LanguageServerClient isLiveRestartGuarded prevents accidental restart against live agy.exe", () => {
      const liveInfo = {
        port: 12345,
        csrfToken: "live-csrf",
        workspaceDir: "c:\\users\\live\\workspace",
        isLiveProcess: true,
      };
      // In test mode, guard must return true for live process
      const guarded = LanguageServerClient.isLiveRestartGuarded(liveInfo);
      expect(guarded).toBe(true);
    });

    it("T2.5: Complex Unicode and special characters in refresh token are preserved in payload", async () => {
      let capturedStdin = "";
      const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
        const mockChild: any = {
          stdin: {
            on: () => {},
            write: (chunk: string) => {
              capturedStdin += chunk;
            },
            end: () => {},
          },
          on: (event: string, cb: any) => {
            if (event === "close") setTimeout(() => cb(0), 10);
          },
        };
        return mockChild;
      });

      try {
        const complexToken = "1//04_special+chars/with=slashes&symbols$and#unicode🚀";
        await OSKeyring.writeCredential("user@gmail.com", {
          accessToken: "tok",
          refreshToken: complexToken,
          expiryDateSeconds: 1000,
        });

        const parsed = JSON.parse(capturedStdin);
        expect(parsed.token.refresh_token).toBe(complexToken);
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it("T2.6: Linux writeLinuxCredential pipes credentials via stdin to secret-tool", async () => {
      let capturedStdin = "";
      let capturedArgs: string[] = [];

      const spawnSpy = spyOn(childProcess, "spawn").mockImplementation((cmd: any, args: any) => {
        capturedArgs = args as string[];
        const mockChild: any = {
          stdin: {
            on: () => {},
            write: (chunk: string) => {
              capturedStdin += chunk;
            },
            end: () => {},
          },
          on: (event: string, cb: any) => {
            if (event === "close") setTimeout(() => cb(0), 10);
          },
        };
        return mockChild;
      });

      try {
        await (OSKeyring as any).writeLinuxCredential(JSON.stringify({ testSecret: "secret-xyz" }));
        expect(capturedArgs).toContain("store");
        expect(capturedArgs).toContain("service");
        expect(capturedArgs.join(" ")).not.toContain("secret-xyz");
        expect(capturedStdin).toContain("secret-xyz");
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it("T2.7: missing tokenType defaults to Bearer in formatted payload", async () => {
      let capturedStdin = "";
      const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
        const mockChild: any = {
          stdin: {
            on: () => {},
            write: (chunk: string) => {
              capturedStdin += chunk;
            },
            end: () => {},
          },
          on: (event: string, cb: any) => {
            if (event === "close") setTimeout(() => cb(0), 10);
          },
        };
        return mockChild;
      });

      try {
        await OSKeyring.writeCredential("user@gmail.com", {
          accessToken: "tok-1",
          refreshToken: "ref-1",
          expiryDateSeconds: 1000,
          tokenType: undefined,
        });

        const parsed = JSON.parse(capturedStdin);
        expect(parsed.token.token_type).toBe("Bearer");
      } finally {
        spawnSpy.mockRestore();
      }
    });

    it("T2.4: serializes concurrent writeCredential calls through writeLock without overlapping process execution", async () => {
      let activeWrites = 0;
      let maxConcurrent = 0;
      const spawnSpy = spyOn(childProcess, "spawn").mockImplementation(() => {
        activeWrites++;
        if (activeWrites > maxConcurrent) maxConcurrent = activeWrites;
        const mockChild: any = {
          stdin: {
            on: () => {},
            write: () => {},
            end: () => {},
          },
          on: (event: string, cb: any) => {
            if (event === "close") {
              setTimeout(() => {
                activeWrites--;
                cb(0);
              }, 20);
            }
          },
        };
        return mockChild;
      });

      try {
        const p1 = OSKeyring.writeCredential("user1@gmail.com", {
          accessToken: "tok-1",
          refreshToken: "ref-1",
          expiryDateSeconds: 1000,
        });
        const p2 = OSKeyring.writeCredential("user2@gmail.com", {
          accessToken: "tok-2",
          refreshToken: "ref-2",
          expiryDateSeconds: 1000,
        });
        const p3 = OSKeyring.writeCredential("user3@gmail.com", {
          accessToken: "tok-3",
          refreshToken: "ref-3",
          expiryDateSeconds: 1000,
        });

        const results = await Promise.all([p1, p2, p3]);
        expect(results).toEqual([true, true, true]);
        expect(maxConcurrent).toBe(1);
      } finally {
        spawnSpy.mockRestore();
      }
    });
  });
});
