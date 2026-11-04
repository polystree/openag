import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Bridge to the `agy --hub` backend used by the VS Code based Antigravity IDE.
 *
 * In the new IDE the chat agent and the model picker are served by `agy.exe --hub`.
 * The hub does not read the token that OpenAG pushes through `antigravityUnifiedStateSync`;
 * it loads its own stored token from the OS keyring (`gemini:antigravity`) and re-syncs it
 * while running. So to switch the account the chat uses, OpenAG writes the active account
 * into that keyring entry and then checks each running hub until it reports the new email.
 */

export interface HubInfo {
  pid: number;
  httpPort: number;
  csrfToken: string;
}

export interface HubTokenInput {
  email: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds */
  expiresAt: number;
}

export interface HubSwitchResult {
  keyringWritten: boolean;
  hubCount: number;
}

const KEYRING_SERVICE = "gemini";
const KEYRING_USER = "antigravity";
const LS_SERVICE = "exa.language_server_pb.LanguageServerService";

function daemonDirs(): string[] {
  const home = os.homedir();
  return [path.join(home, ".gemini", "antigravity", "daemon"), path.join(home, ".gemini", "antigravity-ide", "daemon")];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    // EPERM means the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function findHubs(): HubInfo[] {
  const hubs: HubInfo[] = [];
  for (const dir of daemonDirs()) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => /^hub_\d+\.json$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        // SAFETY: agy hub writes {pid, httpPort, httpsPort, csrfToken} into this file
        const info = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Partial<HubInfo>;
        if (typeof info.pid === "number" && typeof info.httpPort === "number" && typeof info.csrfToken === "string" && isAlive(info.pid)) {
          if (!hubs.some((h) => h.httpPort === info.httpPort)) hubs.push(info as HubInfo);
        }
      } catch { /* stale or partial file */ }
    }
  }
  return hubs;
}

async function hubRpc<T>(hub: HubInfo, method: string, body: unknown = {}, timeoutMs = 3000): Promise<T | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${hub.httpPort}/${LS_SERVICE}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": hub.csrfToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trimStart().startsWith("{")) return null;
    // SAFETY: Connect JSON response from the local agy hub
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function getHubEmail(hub: HubInfo): Promise<string | null> {
  const res = await hubRpc<{ userStatus?: { email?: string } }>(hub, "GetUserStatus");
  return res?.userStatus?.email ?? null;
}

/** One entry of the chat model picker, as the hub serves it for its current account. */
export interface HubModelConfig {
  label: string;
  /** e.g. "MODEL_PLACEHOLDER_M418"; this is what the IDE stores as the selected model */
  modelKey: string;
  remainingFraction?: number;
  resetTime?: string;
}

interface HubUserStatus {
  userStatus?: {
    email?: string;
    cascadeModelConfigData?: {
      clientModelConfigs?: { label?: string; modelOrAlias?: { model?: string }; quotaInfo?: { remainingFraction?: number; resetTime?: string } }[];
    };
  };
}

/** Reads the hub account and its real chat model list (includes trial models such as Argon). */
export async function getHubModelConfigs(hub: HubInfo): Promise<{ email: string; models: HubModelConfig[] } | null> {
  const res = await hubRpc<HubUserStatus>(hub, "GetUserStatus");
  const email = res?.userStatus?.email;
  if (!email) return null;
  const models: HubModelConfig[] = [];
  for (const c of res.userStatus?.cascadeModelConfigData?.clientModelConfigs || []) {
    const modelKey = c.modelOrAlias?.model;
    if (!c.label || !modelKey) continue;
    models.push({ label: c.label, modelKey, remainingFraction: c.quotaInfo?.remainingFraction, resetTime: c.quotaInfo?.resetTime });
  }
  return { email, models };
}

type HubAccountListener = (email: string, models: HubModelConfig[]) => void;
const hubAccountListeners: HubAccountListener[] = [];
const hubAccountListener = {
  call(email: string, models: HubModelConfig[]) {
    for (const l of hubAccountListeners) {
      try { l(email, models); } catch { /* listener errors must not break the bridge */ }
    }
  },
};

/** Called whenever a hub is seen on an account, with that account's model list. */
export function onHubAccountObserved(listener: HubAccountListener): void {
  hubAccountListeners.push(listener);
}

/** Reads every running hub and reports its account/models to the listener. */
export async function observeHubs(): Promise<void> {
  for (const hub of findHubs()) {
    const info = await getHubModelConfigs(hub);
    if (info) hubAccountListener.call(info.email, info.models);
  }
}

const CRED_WRITE_PS = `
$ErrorActionPreference = 'Stop'
$in = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -Namespace OpenAG -Name Cred -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
'@
$bytes = [Text.Encoding]::UTF8.GetBytes([string]$in.blob)
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
try {
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
  $c = New-Object OpenAG.Cred+CREDENTIAL
  $c.Type = 1; $c.TargetName = [string]$in.target; $c.UserName = [string]$in.user; $c.Persist = 2
  $c.CredentialBlobSize = $bytes.Length; $c.CredentialBlob = $ptr
  if (-not [OpenAG.Cred]::CredWriteW([ref]$c, 0)) { throw "CredWrite failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  'ok'
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($ptr) }
`;

function buildStoredToken(t: HubTokenInput): string {
  const expiry = t.expiresAt > 0 ? new Date(t.expiresAt * 1000) : new Date(Date.now() + 3600_000);
  // Same shape agy itself stores (codeassistclient.StoredToken).
  return JSON.stringify({
    token: {
      access_token: t.accessToken,
      token_type: "Bearer",
      refresh_token: t.refreshToken,
      expiry: expiry.toISOString(),
      expires_in: Math.max(0, Math.round((expiry.getTime() - Date.now()) / 1000)),
    },
    auth_method: "consumer",
    id_token_email: t.email,
    writer_id: "openag",
  });
}

/** Writes the token into the keyring entry the agy hub loads (Windows Credential Manager). */
export function writeHubKeyring(t: HubTokenInput, timeoutMs = 8000): Promise<void> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error(`keyring sync is only implemented for Windows (platform: ${process.platform})`));
  }
  const payload = JSON.stringify({ target: `${KEYRING_SERVICE}:${KEYRING_USER}`, user: KEYRING_USER, blob: buildStoredToken(t) });
  return new Promise((resolve, reject) => {
    // Script goes through -EncodedCommand and secrets through stdin, so neither shows up in the process list.
    const encoded = Buffer.from(CRED_WRITE_PS, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("keyring write timed out"));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.includes("ok")) resolve();
      else reject(new Error(`keyring write failed (exit ${code}): ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(payload);
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Bumped on every switch so an older background check stops when a newer switch starts. */
let switchGeneration = 0;

/**
 * Points every running agy hub at the given account.
 * Writes the keyring (awaited, ~0.5 s), then checks each hub in the background and logs when it
 * picked up the new account. The hub re-reads its stored token on its own about every 5 minutes.
 */
export async function switchHubAccount(t: HubTokenInput, log: (m: string) => void, waitMs = 330_000): Promise<HubSwitchResult> {
  const result: HubSwitchResult = { keyringWritten: false, hubCount: 0 };
  const generation = ++switchGeneration;
  try {
    await writeHubKeyring(t);
    result.keyringWritten = true;
  } catch (e: unknown) {
    log(`[AgyHub] Keyring write failed: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  // Skip hub files whose pid was reused by an unrelated process (they do not answer).
  const answering = async () => {
    const candidates = findHubs();
    const emails = await Promise.all(candidates.map((h) => getHubEmail(h)));
    return candidates.map((hub, i) => ({ hub, email: emails[i] ?? null })).filter((x) => x.email !== null);
  };
  let hubs = await answering();
  result.hubCount = hubs.length;
  const target = t.email.toLowerCase();

  void (async () => {
    if (hubs.length === 0) {
      // At IDE start the hub may still be booting (and may have read an older keyring entry). Wait for it.
      log(`[AgyHub] Keyring set to ${t.email}; waiting for the agy hub to start...`);
      const waitStart = Date.now();
      while (hubs.length === 0 && Date.now() - waitStart < 90_000 && generation === switchGeneration) {
        await sleep(2000);
        hubs = await answering();
      }
      if (hubs.length === 0) {
        if (generation === switchGeneration) log("[AgyHub] No agy hub answered within 90 s; it will load this account when it starts.");
        return;
      }
    }
    await Promise.all(hubs.map(({ hub, email: firstEmail }, idx) => verifyHub(hub, firstEmail, idx)));
  })();

  async function verifyHub(hub: HubInfo, firstEmail: string | null, idx: number): Promise<void> {
    const start = Date.now();
    let email = firstEmail;
    if ((email || "").toLowerCase() === target) {
      const info = await getHubModelConfigs(hub);
      if (info) hubAccountListener.call(info.email, info.models);
      return;
    }
    log(`[AgyHub] Keyring set to ${t.email}; hub :${hub.httpPort} currently uses ${email}. Waiting for it to re-read its token...`);
    const before = await getHubModelConfigs(hub);
    if (before) hubAccountListener.call(before.email, before.models);
    // Ask the hub to refresh its Code Assist state once; harmless if it does not re-read the token.
    await hubRpc(hub, "GetLoadCodeAssist", { forceRefresh: true }, 10000);
    while ((email || "").toLowerCase() !== target && Date.now() - start < waitMs && generation === switchGeneration) {
      await sleep(idx === 0 ? 2000 : 2500);
      await hubRpc(hub, "GetAuthStatus");
      email = await getHubEmail(hub);
    }
    if (generation !== switchGeneration) return;
    const secs = Math.round((Date.now() - start) / 1000);
    if ((email || "").toLowerCase() === target) {
      const info = await getHubModelConfigs(hub);
      if (info) hubAccountListener.call(info.email, info.models);
    }
    log((email || "").toLowerCase() === target
      ? `[AgyHub] Hub :${hub.httpPort} switched to ${email} after ${secs} s`
      : `[AgyHub] Hub :${hub.httpPort} still reports ${email ?? "unknown"} after ${secs} s (target ${t.email})`);
  }
  return result;
}
