import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface LanguageServerInfo {
  port: number;
  csrfToken: string;
  workspaceDir?: string;
}

export interface LanguageServerStatus {
  email?: string;
  name?: string;
  tier?: string;
}

export class LanguageServerClient {
  private cachedInfo: LanguageServerInfo | null = null;
  private cachedAt = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    private readonly workspacePath?: string,
    private readonly log?: (msg: string) => void,
  ) {}

  public async detect(): Promise<LanguageServerInfo | null> {
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
      };
    } catch (err) {
      this.log?.(`Language server discovery error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
