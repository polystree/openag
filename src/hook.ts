import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_HOOK_PORT = 27182;

interface IpcSessionItem {
  pid: number;
  port: number;
  authToken: string;
  workspacePath?: string;
  updatedAt: number;
}

interface IpcDiscovery {
  port?: number;
  authToken?: string;
  pid?: number;
  updatedAt?: number;
  sessions?: IpcSessionItem[];
}

interface PreInvocationResponse {
  decision?: string;
  rotated?: boolean;
  email?: string;
  percent?: number;
  model?: string;
  activeEmail?: string;
  error?: string;
}

export function readIpcDiscovery(workspacePath?: string): { port: number; authToken: string } {
  let port = process.env.OPENAG_HOOK_PORT ? parseInt(process.env.OPENAG_HOOK_PORT, 10) : 0;
  let authToken = process.env.OPENAG_HOOK_AUTH_TOKEN || "";

  if (!port || !authToken) {
    try {
      const ipcPath = process.env.OPENAG_IPC_PATH || path.join(os.homedir(), ".gemini", "openag", "ipc.json");
      if (fs.existsSync(ipcPath)) {
        const content = fs.readFileSync(ipcPath, "utf-8");
        const data = JSON.parse(content) as IpcDiscovery;
        if (workspacePath && Array.isArray(data.sessions) && data.sessions.length > 0) {
          const normWp = workspacePath.toLowerCase().replace(/\\/g, "/");
          const matched = data.sessions.find(
            (s) => s.workspacePath && normWp.includes(s.workspacePath.toLowerCase().replace(/\\/g, "/")),
          );
          if (matched && matched.port) {
            return { port: matched.port, authToken: matched.authToken || "" };
          }
        }
        if (!port && typeof data.port === "number" && data.port > 0) {
          port = data.port;
        }
        if (!authToken && typeof data.authToken === "string") {
          authToken = data.authToken;
        }
      }
    } catch {
      // Ignore discovery reading error, fallback below
    }
  }

  return {
    port: port || DEFAULT_HOOK_PORT,
    authToken,
  };
}

export async function readStdinWithTimeout(timeoutMs = 15): Promise<string> {
  if (process.stdin.isTTY || process.stdin.readableEnded) return "";
  return new Promise((resolve) => {
    let data = "";
    let done = false;

    const finish = () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        process.stdin.removeListener("data", onData);
        process.stdin.removeListener("end", onEnd);
        process.stdin.removeListener("error", onError);
        resolve(data);
      }
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    const onData = (chunk: string | Buffer) => {
      data += String(chunk);
    };
    const onEnd = finish;
    const onError = finish;

    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });
}

export async function runHook(): Promise<void> {
  let rawInput = "";
  try {
    rawInput = await readStdinWithTimeout(15);
  } catch { /* ignore empty stdin */ }

  let wp: string | undefined;
  if (rawInput.trim()) {
    try {
      const payload = JSON.parse(rawInput.trim()) as { workspacePaths?: string[] };
      wp = payload.workspacePaths?.[0];
    } catch { /* ignore */ }
  }

  const { port, authToken } = readIpcDiscovery(wp);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (authToken) {
      headers["x-openag-auth"] = authToken;
    }

    const res = await fetch(`http://127.0.0.1:${port}/pre-invocation`, {
      method: "POST",
      headers,
      body: rawInput || "{}",
      signal: AbortSignal.timeout(1500),
    });

    if (res.ok) {
      // SAFETY: JSON response from local OpenAG extension HookServer
      const data = (await res.json()) as PreInvocationResponse;
      if (data.rotated && data.email) {
        const modelInfo = data.model ? ` for ${data.model}` : "";
        const quotaInfo = typeof data.percent === "number" ? ` (${data.percent}% remaining${modelInfo})` : "";
        const msg = `[OpenAG] Auto-rotated active account to ${data.email}${quotaInfo}`;

        const output = {
          decision: "allow",
          injectSteps: [
            {
              ephemeralMessage: msg,
            },
          ],
        };
        process.stdout.write(`${JSON.stringify(output)}\n`);
        return;
      }
    }
  } catch {
    // Graceful fallback: extension is offline or unreachable in < 45ms
  }

  process.stdout.write(`${JSON.stringify({ decision: "allow" })}\n`);
}

const isMainScript =
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("hook.js") || process.argv[1].endsWith("hook.ts"));

if (isMainScript && process.env.NODE_ENV !== "test") {
  runHook().catch(() => {
    try {
      process.stdout.write(`${JSON.stringify({ decision: "allow" })}\n`);
    } catch {
      // ignore
    }
  });
}
