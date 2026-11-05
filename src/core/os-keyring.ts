import { spawn } from "node:child_process";
import type { OAuthTokens } from "../types.js";

export interface KeyringTokenPayload {
  auth_method: string;
  id_token_email: string;
  token: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    expiry: string;
  };
}

export class OSKeyring {
  private static writeLock: Promise<void> = Promise.resolve();

  public static async writeCredential(email: string, token: OAuthTokens): Promise<boolean> {
    if (!email || !token.accessToken) return false;

    const prevLock = this.writeLock;
    let resolveLock!: () => void;
    this.writeLock = new Promise<void>((r) => {
      resolveLock = r;
    });

    try {
      await prevLock.catch(() => {});
      return await this.executeWrite(email, token);
    } finally {
      resolveLock();
    }
  }

  private static async executeWrite(email: string, token: OAuthTokens): Promise<boolean> {
    const expiresIn = Math.max(0, (token.expiryDateSeconds || (Math.floor(Date.now() / 1000) + 3600)) - Math.floor(Date.now() / 1000));
    const expiryIso = new Date((token.expiryDateSeconds || (Math.floor(Date.now() / 1000) + 3600)) * 1000).toISOString();

    const payload: KeyringTokenPayload = {
      auth_method: "consumer",
      id_token_email: email,
      token: {
        access_token: token.accessToken,
        refresh_token: token.refreshToken || "",
        token_type: token.tokenType || "Bearer",
        expires_in: expiresIn,
        expiry: expiryIso,
      },
    };

    const jsonStr = JSON.stringify(payload);

    if (process.platform === "win32") {
      return this.writeWindowsCredential(jsonStr);
    } else if (process.platform === "darwin") {
      return this.writeMacCredential(jsonStr);
    } else if (process.platform === "linux") {
      return this.writeLinuxCredential(jsonStr);
    }
    return false;
  }

  private static async writeWindowsCredential(jsonStr: string): Promise<boolean> {
    return new Promise((resolve) => {
      const psScript = `
$inputString = [Console]::In.ReadToEnd()
if (-not $inputString) { exit 1 }

Add-Type -MemberDefinition @"
[DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredWrite([In] ref CREDENTIAL userCredential, [In] uint flags);

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public long LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
}
"@ -Name "CredWriter" -Namespace "OpenAG"

$bytes = [System.Text.Encoding]::UTF8.GetBytes($inputString)
$blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blobPtr, $bytes.Length)

$cred = New-Object OpenAG.CredWriter+CREDENTIAL
$cred.Flags = 0
$cred.Type = 1
$cred.TargetName = "gemini:antigravity"
$cred.Comment = ""
$cred.CredentialBlobSize = $bytes.Length
$cred.CredentialBlob = $blobPtr
$cred.Persist = 2
$cred.AttributeCount = 0
$cred.Attributes = [IntPtr]::Zero
$cred.TargetAlias = ""
$cred.UserName = "antigravity"

$success = [OpenAG.CredWriter]::CredWrite([ref]$cred, 0)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)

if ($success) { exit 0 } else { exit 2 }
`;

      const child = spawn("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        psScript,
      ], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });

      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));

      child.stdin.on("error", () => {});
      child.stdin.write(jsonStr);
      child.stdin.end();
    });
  }

  private static async writeMacCredential(jsonStr: string): Promise<boolean> {
    return new Promise((resolve) => {
      // Pipe commands via stdin to security interactive mode (-i) to prevent
      // credential tokens from appearing in process command-line arguments.
      const child = spawn("security", ["-i"], {
        stdio: ["pipe", "ignore", "ignore"],
      });

      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));

      child.stdin.on("error", () => {});
      const escaped = jsonStr.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      child.stdin.write(`add-generic-password -s "gemini:antigravity" -a "antigravity" -w "${escaped}" -U\nquit\n`);
      child.stdin.end();
    });
  }

  private static async writeLinuxCredential(jsonStr: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("secret-tool", [
        "store",
        "--label=gemini:antigravity",
        "service",
        "gemini:antigravity",
        "username",
        "antigravity",
      ], {
        stdio: ["pipe", "ignore", "ignore"],
      });

      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));

      child.stdin.on("error", () => {});
      child.stdin.write(jsonStr);
      child.stdin.end();
    });
  }
}

