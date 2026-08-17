import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const PATCH_TAG = "/*OPENAG:autorun*/";

export interface PatcherStatus {
  isPatched: boolean;
  supported: boolean;
  appRoot: string | null;
  version: string;
  error?: string;
}

export class AutoRunPatcher {
  private static cachedAppRoot: string | null = null;

  public static getAppRoot(): string | null {
    if (this.cachedAppRoot && fs.existsSync(this.cachedAppRoot)) return this.cachedAppRoot;
    const candidates: string[] = [];

    if (process.platform === "win32") {
      const localApp = process.env.LOCALAPPDATA || "";
      if (localApp) {
        candidates.push(
          path.join(localApp, "Programs", "Antigravity IDE", "resources", "app"),
          path.join(localApp, "Programs", "Antigravity", "resources", "app"),
        );
      }
      const progFiles = process.env["ProgramFiles"] || "";
      if (progFiles) {
        candidates.push(
          path.join(progFiles, "Antigravity IDE", "resources", "app"),
          path.join(progFiles, "Antigravity", "resources", "app"),
        );
      }
    } else if (process.platform === "darwin") {
      candidates.push(
        "/Applications/Antigravity IDE.app/Contents/Resources/app",
        "/Applications/Antigravity.app/Contents/Resources/app",
      );
    } else {
      const home = process.env.HOME || "";
      candidates.push(
        "/opt/Antigravity/resources/app",
        "/usr/share/antigravity/resources/app",
        path.join(home, ".local", "share", "Antigravity", "resources", "app"),
      );
    }

    for (const cand of candidates) {
      if (fs.existsSync(path.join(cand, "out", "vs", "workbench", "workbench.desktop.main.js"))) {
        this.cachedAppRoot = cand;
        return cand;
      }
    }
    return null;
  }

  public static getStatus(): PatcherStatus {
    const appRoot = this.getAppRoot();
    if (!appRoot) {
      return { isPatched: false, supported: false, appRoot: null, version: "unknown", error: "Antigravity install directory not found" };
    }

    let version = "unknown";
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")) as { version?: string };
      version = pkg.version || "unknown";
    } catch { /* ignore */ }

    const target = path.join(appRoot, "out", "jetskiAgent", "main.js");
    if (!fs.existsSync(target)) {
      return { isPatched: false, supported: false, appRoot, version, error: "jetskiAgent/main.js missing" };
    }

    try {
      const content = fs.readFileSync(target, "utf8");
      const isPatched = content.includes(PATCH_TAG);
      return { isPatched, supported: true, appRoot, version };
    } catch (err) {
      return { isPatched: false, supported: false, appRoot, version, error: String(err) };
    }
  }

  public static apply(): { success: boolean; message: string } {
    const appRoot = this.getAppRoot();
    if (!appRoot) return { success: false, message: "Could not locate Antigravity installation path." };

    const targets = [
      { rel: path.join("out", "vs", "workbench", "workbench.desktop.main.js"), hookId: "co", effectId: "yt" },
      { rel: path.join("out", "jetskiAgent", "main.js"), hookId: "ia", effectId: "ze" },
    ];

    try {
      const productPath = path.join(appRoot, "product.json");
      let productJson: { checksums?: Record<string, string> } = {};
      if (fs.existsSync(productPath)) {
        if (!fs.existsSync(`${productPath}.openag-backup`)) {
          fs.copyFileSync(productPath, `${productPath}.openag-backup`);
        }
        productJson = JSON.parse(fs.readFileSync(productPath, "utf8")) as { checksums?: Record<string, string> };
        if (!productJson.checksums) productJson.checksums = {};
      }

      for (const { rel, hookId, effectId } of targets) {
        const fullPath = path.join(appRoot, rel);
        if (!fs.existsSync(fullPath)) continue;

        const backupPath = `${fullPath}.openag-backup`;
        let content = fs.existsSync(backupPath) ? fs.readFileSync(backupPath, "utf8") : fs.readFileSync(fullPath, "utf8");
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(fullPath, backupPath);
        }

        const anchor = '{case:"runCommand",value:';
        let patched = false;
        for (let idx = content.indexOf(anchor); idx !== -1; idx = content.indexOf(anchor, idx + anchor.length)) {
          const winStart = Math.max(0, idx - 150);
          const winEnd = Math.min(content.length, idx + 50);
          const winStr = content.slice(winStart, winEnd);
          const match = winStr.match(/([a-zA-Z0-9_$]+)\s*=\s*([a-zA-Z0-9_$]+)\s*\(\s*([a-zA-Z0-9_$]+)\s*=>\s*\{/);
          if (match) {
            const cbVar = match[1];
            const afterAnchor = content.slice(idx, idx + 300);
            const cbEndMatch = afterAnchor.match(/\},\s*\[[^\]]*\]\s*\)\s*;/);
            if (cbEndMatch && cbEndMatch.index !== undefined) {
              const cbEndPos = idx + cbEndMatch.index + cbEndMatch[0].length;
              const patchCode = `${PATCH_TAG};((typeof ${effectId}==="function"?${effectId}:null)||(typeof React!=="undefined"?React.useEffect:null))?.(()=>{try{let _h=(typeof ${hookId}==="function"?${hookId}:null);let _st=_h?.()?.stepHandler;if((_st?.terminalAutoExecutionPolicy===3||_st?.terminalAutoExecutionPolicy==="EAGER")&&!_st?.secureModeEnabled)${cbVar}(!0)}catch{}},[${cbVar}]);`;
              content = content.slice(0, cbEndPos) + patchCode + content.slice(cbEndPos);
              patched = true;
              break;
            }
          }
        }

        if (patched) {
          fs.writeFileSync(fullPath, content, "utf8");
          const normRel = rel.replace(/^out[\\/]/, "").replace(/\\/g, "/");
          if (productJson.checksums) {
            productJson.checksums[normRel] = crypto.createHash("sha256").update(content).digest("base64").replace(/=+$/, "");
          }
        }
      }

      if (fs.existsSync(productPath)) {
        fs.writeFileSync(productPath, JSON.stringify(productJson, null, "\t"), "utf8");
      }

      return { success: true, message: "Auto-Run fix applied successfully! Restart or reload Antigravity to take effect." };
    } catch (err) {
      return { success: false, message: `Failed to apply Auto-Run fix: ${String(err)}` };
    }
  }

  public static revert(): { success: boolean; message: string } {
    const appRoot = this.getAppRoot();
    if (!appRoot) return { success: false, message: "Could not locate Antigravity installation path." };

    const targets = [
      path.join("out", "vs", "workbench", "workbench.desktop.main.js"),
      path.join("out", "jetskiAgent", "main.js"),
    ];

    try {
      const productPath = path.join(appRoot, "product.json");
      if (fs.existsSync(`${productPath}.openag-backup`)) {
        fs.copyFileSync(`${productPath}.openag-backup`, productPath);
        fs.unlinkSync(`${productPath}.openag-backup`);
      }

      for (const rel of targets) {
        const fullPath = path.join(appRoot, rel);
        const backupPath = `${fullPath}.openag-backup`;
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, fullPath);
          fs.unlinkSync(backupPath);
        }
      }

      return { success: true, message: "Auto-Run fix reverted successfully. Original files restored." };
    } catch (err) {
      return { success: false, message: `Failed to revert Auto-Run fix: ${String(err)}` };
    }
  }
}
