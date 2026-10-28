import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mockVscode, createMockExtensionContext } from "./vscode.js";
import { MockLanguageServer } from "./language-server.js";

mock.module("vscode", () => mockVscode);

describe("Mock Infrastructure", () => {
  let server: MockLanguageServer;

  beforeEach(async () => {
    server = new MockLanguageServer();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("provides functional vscode mock with extension context", async () => {
    const ctx = createMockExtensionContext();
    await ctx.globalState.update("key1", "val1");
    expect(ctx.globalState.get("key1")).toBe("val1");

    await ctx.secrets.store("sec1", "secret-token");
    expect(await ctx.secrets.get("sec1")).toBe("secret-token");

    const item = mockVscode.window.createStatusBarItem(mockVscode.StatusBarAlignment.Right, 100);
    item.text = "Testing";
    item.show();
    expect(item.visible).toBe(true);
    expect(item.text).toBe("Testing");
  });

  it("handles Connect-RPC GetUserStatus, RetrieveUserQuotaSummary, and Restart", async () => {
    const client = server.createClient();

    const status = await client.getUserStatus();
    expect(status?.email).toBe("mock-user@gmail.com");
    expect(server.userStatusCalls).toBe(1);

    const quota = await client.retrieveUserQuotaSummary();
    expect(quota).toBeDefined();
    expect(server.quotaSummaryCalls).toBe(1);

    const restarted = await client.restartServer();
    expect(restarted).toBe(true);
    expect(server.restartCalls).toBe(1);
  });
});
