import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LanguageServerInfo {
  port: number;
  csrfToken: string;
  workspaceDir?: string;
  isLiveProcess?: boolean;
}

export interface LanguageServerStatus {
  email?: string;
  name?: string;
  tier?: string;
}

export class LanguageServerClient {
  public static preventLiveRestart = false;
  private cachedInfo: LanguageServerInfo | null = null;
  private cachedAt = 0;
  private isMocked = false;
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly workspacePath?: string,
    private readonly log?: (msg: string) => void,
  ) {}

  public setMockInfo(info: LanguageServerInfo | null): void {
    this.cachedInfo = info;
    this.cachedAt = Date.now();
    this.isMocked = true;
  }

  public static isTestEnvironment(): boolean {
    return (
      process.env.NODE_ENV === "test" ||
      process.env.OPENAG_TEST === "1" ||
      process.env.OPENAG_TEST === "true" ||
      Boolean(process.env.BUN_TEST) ||
      Boolean(process.env.VITEST) ||
      Boolean(process.env.JEST_WORKER_ID)
    );
  }

  public static isLiveRestartGuarded(info: LanguageServerInfo | null): boolean {
    if (LanguageServerClient.preventLiveRestart) {
      return true;
    }
    if (LanguageServerClient.isTestEnvironment()) {
      // In test environments, never restart live processes discovered from the OS process table.
      // Mocked clients (where isLiveProcess is not true) are permitted to hit the mock server.
      if (!info || info.isLiveProcess) {
        return true;
      }
    }
    return false;
  }

  public get isUsingMock(): boolean {
    return this.isMocked;
  }

  public async detect(): Promise<LanguageServerInfo | null> {
    if (this.isMocked && this.cachedInfo) {
      return this.cachedInfo;
    }
    const now = Date.now();
    if (this.cachedInfo && now - this.cachedAt < LanguageServerClient.CACHE_TTL_MS) {
      return this.cachedInfo;
    }
    const info = await this.discoverProcess();
    this.cachedInfo = info;
    this.cachedAt = now;
    return info;
  }

  public invalidate(): void {
    this.cachedInfo = null;
    this.cachedAt = 0;
  }

  public async getUserStatus(): Promise<LanguageServerStatus | null> {
    const info = await this.detect();
    if (!info) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/exa.language_server_pb.LanguageServerService/GetUserStatus`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": info.csrfToken,
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) this.invalidate();
        return null;
      }
      const data = (await res.json()) as { userStatus?: { email?: string; name?: string; userTier?: { id?: string } } };
      const userStatus = data?.userStatus;
      return {
        email: userStatus?.email,
        name: userStatus?.name,
        tier: userStatus?.userTier?.id,
      };
    } catch {
      this.invalidate();
      return null;
    }
  }

  public async retrieveUserQuotaSummary(): Promise<any | null> {
    const info = await this.detect();
    if (!info) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": info.csrfToken,
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) this.invalidate();
        return null;
      }
      const data = (await res.json()) as { response?: unknown };
      return data?.response ?? data;
    } catch {
      this.invalidate();
      return null;
    }
  }

  public async restartServer(): Promise<boolean> {
    const info = await this.detect();
    if (!info) return false;

    if (LanguageServerClient.isLiveRestartGuarded(info)) {
      this.log?.("[LanguageServerClient] Live restart skipped: safety guard active in test environment");
      this.invalidate();
      return true;
    }

    try {
      await fetch(`http://127.0.0.1:${info.port}/exa.language_server_pb.LanguageServerService/Restart`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-codeium-csrf-token": info.csrfToken,
          "Connect-Protocol-Version": "1",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      this.invalidate();
      return true;
    } catch {
      this.invalidate();
      return false;
    }
  }

  private async discoverProcess(): Promise<LanguageServerInfo | null> {
    try {
      let output = "";
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_Process -Filter \"name='agy.exe'\" | Select-Object -ExpandProperty CommandLine",
        ], { timeout: 3000 });
        output = stdout;
      } else {
        const { stdout } = await execFileAsync("ps", ["-eo", "args"], { timeout: 3000 });
        output = stdout;
      }

      const lines = output.split(/\r?\n/).filter((l) => l.includes("--hub-port"));
      if (lines.length === 0) return null;

      let targetLine = lines[0] ?? "";
      if (this.workspacePath && lines.length > 1) {
        const normalizedWp = this.workspacePath.toLowerCase().replace(/\\/g, "/");
        const matched = lines.find((l) => l.toLowerCase().replace(/\\/g, "/").includes(normalizedWp));
        if (matched) targetLine = matched;
      }
      if (!targetLine) return null;

      const portMatch = targetLine.match(/--hub-port=(\d+)/);
      const csrfMatch = targetLine.match(/--csrf_token=([a-zA-Z0-9_-]+)/);
      const dirMatch = targetLine.match(/--add-dir=([^\s]+)/);

      const portStr = portMatch?.[1];
      const csrfToken = csrfMatch?.[1];
      if (!portStr || !csrfToken) return null;

      return {
        port: Number.parseInt(portStr, 10),
        csrfToken,
        workspaceDir: dirMatch?.[1],
        isLiveProcess: true,
      };
    } catch (err) {
      this.log?.(`Language server discovery error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
