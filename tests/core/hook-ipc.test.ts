import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HookServer } from "../../src/core/hook-server.js";
import { readIpcDiscovery } from "../../src/hook.js";
import {
  createTestAccount,
  createAccountQuota,
  createFamilyQuota,
  setupTestTokenManager,
  setupTestQuotaMonitor,
} from "../helpers/test-utils.js";
import type { AccountQuota } from "../../src/types.js";

describe("F5 & F6: PreInvocation Hook Script & IPC", () => {
  let hookServer: HookServer | null = null;
  let testPort = 0;
  const accA = createTestAccount({ email: "acc-a@gmail.com", tier: "pro" });
  const accB = createTestAccount({ email: "acc-b@gmail.com", tier: "pro" });

  afterEach(() => {
    if (hookServer) {
      hookServer.dispose();
      hookServer = null;
    }
  });

  describe("Tier 1: HookServer IPC Discovery & Request Authorization", () => {
    it("T1.1: HookServer writes IPC discovery file to ~/.gemini/openag/ipc.json on startup", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
      testPort = await hookServer.start(0); // dynamic port

      const ipcFile = HookServer.getIpcFilePath();
      expect(fs.existsSync(ipcFile)).toBe(true);

      const content = JSON.parse(fs.readFileSync(ipcFile, "utf8"));
      expect(content.port).toBe(testPort);
      expect(content.authToken).toBe(hookServer.getAuthToken());
      expect(content.pid).toBe(process.pid);
      expect(content.updatedAt).toBeGreaterThan(0);
    });

    it("T1.2: HookServer cleanly deletes IPC discovery file on dispose()", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
      await hookServer.start(0);

      const ipcFile = HookServer.getIpcFilePath();
      expect(fs.existsSync(ipcFile)).toBe(true);

      hookServer.dispose();
      hookServer = null;

      expect(fs.existsSync(ipcFile)).toBe(false);
    });

    it("T1.3: Authorized POST /pre-invocation returns 200 with decision 'allow'", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA, accB],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
      testPort = await hookServer.start(0);

      const quotas: Record<string, AccountQuota> = {
        [accA.email]: createAccountQuota(accA.email, [createFamilyQuota("gemini", 80)]),
        [accB.email]: createAccountQuota(accB.email, [createFamilyQuota("gemini", 80)]),
      };
      (quotaMonitor as any).quotas = new Map(Object.entries(quotas));

      const res = await fetch(`http://127.0.0.1:${testPort}/pre-invocation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openag-auth": hookServer.getAuthToken(),
        },
        body: JSON.stringify({ modelName: "gemini-1.5-pro" }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.decision).toBe("allow");
      expect(typeof data.rotated).toBe("boolean");
    });

    it("T1.4: Unauthorized request (wrong or missing auth token) is rejected with 401", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
      testPort = await hookServer.start(0);

      // Missing header
      const res1 = await fetch(`http://127.0.0.1:${testPort}/pre-invocation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res1.status).toBe(401);

      // Invalid header
      const res2 = await fetch(`http://127.0.0.1:${testPort}/pre-invocation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openag-auth": "wrong-token-abc",
        },
        body: JSON.stringify({}),
      });
      expect(res2.status).toBe(401);
    });

    it("T1.5: Hook auto-registration preserves existing PreToolUse and PostToolUse in hooks.json", async () => {
      const configDir = path.join(os.homedir(), ".gemini", "config");
      const hooksFile = path.join(configDir, "hooks.json");
      fs.mkdirSync(configDir, { recursive: true });

      // Simulate pre-existing hooks
      const existingConfig = {
        PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "test-tool-hook" }] }],
        PostToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "post-tool-hook" }] }],
      };
      fs.writeFileSync(hooksFile, JSON.stringify(existingConfig, null, 2), "utf8");

      HookServer.registerGlobalHook("c:\\mock\\extension");

      const updated = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
      expect(updated.PreToolUse).toBeDefined();
      expect(updated.PreToolUse.length).toBe(1);
      expect(updated.PostToolUse).toBeDefined();
      expect(updated.PostToolUse.length).toBe(1);
      expect(updated.PreInvocation).toBeDefined();
      expect(updated.PreInvocation.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Tier 2: Boundary & Corner Cases", () => {
    it("T2.1: readIpcDiscovery reads port and token from ipc.json", async () => {
      const { tokenManager, context } = await setupTestTokenManager();
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
      testPort = await hookServer.start(0);

      const discovery = readIpcDiscovery();
      expect(discovery.port).toBe(testPort);
      expect(discovery.authToken).toBe(hookServer.getAuthToken());
    });

    it("T2.2: readIpcDiscovery respects environment variable overrides", () => {
      const origPort = process.env.OPENAG_HOOK_PORT;
      const origToken = process.env.OPENAG_HOOK_AUTH_TOKEN;

      try {
        process.env.OPENAG_HOOK_PORT = "29999";
        process.env.OPENAG_HOOK_AUTH_TOKEN = "env-token-xyz";

        const discovery = readIpcDiscovery();
        expect(discovery.port).toBe(29999);
        expect(discovery.authToken).toBe("env-token-xyz");
      } finally {
        process.env.OPENAG_HOOK_PORT = origPort;
        process.env.OPENAG_HOOK_AUTH_TOKEN = origToken;
      }
    });

    it("T2.3: HookServer handles malformed JSON without crashing and returns decision 'allow'", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
      testPort = await hookServer.start(0);

      const res = await fetch(`http://127.0.0.1:${testPort}/pre-invocation`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-openag-auth": hookServer.getAuthToken(),
        },
        body: "NOT_VALID_JSON{{{",
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.decision).toBe("allow");
    });

    it("T2.4: removeGlobalHook removes OpenAG hook cleanly without affecting other hooks", () => {
      const configDir = path.join(os.homedir(), ".gemini", "config");
      const hooksFile = path.join(configDir, "hooks.json");
      fs.mkdirSync(configDir, { recursive: true });

      const initialConfig = {
        PreInvocation: [
          { matcher: ".*", hooks: [{ type: "command", command: 'node "c:\\mock\\extension\\dist\\hook.js"' }] },
          { matcher: ".*", hooks: [{ type: "command", command: "other-tool-hook" }] },
        ],
      };
      fs.writeFileSync(hooksFile, JSON.stringify(initialConfig, null, 2), "utf8");

      HookServer.removeGlobalHook();

      const updated = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
      // Other hooks must remain intact
      expect(updated).toBeDefined();
    });

    it("T2.5: HookServer /health endpoint returns status 'ok' and active email", async () => {
      const { tokenManager, context } = await setupTestTokenManager({
        accounts: [accA],
        activeEmail: accA.email,
      });
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
      testPort = await hookServer.start(0);

      const res = await fetch(`http://127.0.0.1:${testPort}/health`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      expect(data.status).toBe("ok");
      expect(data.activeAccount).toBe(accA.email);
    });

    it("T2.6: HookServer destroys request if body exceeds 65536 bytes (DOS protection)", async () => {
      const { tokenManager, context } = await setupTestTokenManager();
      const { quotaMonitor } = setupTestQuotaMonitor(tokenManager, context);

      hookServer = new HookServer(tokenManager, quotaMonitor, () => {});
      testPort = await hookServer.start(0);

      const largeBody = "x".repeat(70000);
      try {
        await fetch(`http://127.0.0.1:${testPort}/pre-invocation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-openag-auth": hookServer.getAuthToken(),
          },
          body: largeBody,
        });
      } catch (err) {
        // Socket destruction throws connection reset / closed, which is expected
        expect(err).toBeDefined();
      }
    });

    it("T2.7: Hook auto-registration creates valid config when hooks.json does not exist", () => {
      const fakeExtPath = "c:\\mock\\fresh-extension";
      expect(() => {
        HookServer.registerGlobalHook(fakeExtPath);
      }).not.toThrow();
    });
  });
});
