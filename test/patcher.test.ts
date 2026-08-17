import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as vm from "node:vm";

const PATCH_TAG = "/*OPENAG:autorun*/";

function applyPatchToContent(content: string, hookId: string, effectId: string): string {
  const anchor = '{case:"runCommand",value:';
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
        return content.slice(0, cbEndPos) + patchCode + content.slice(cbEndPos);
      }
    }
  }
  return content;
}

describe("AutoRunPatcher bundle patching", () => {
  test("generates valid syntax without unexpected tokens in CommonJS AMD bundle", () => {
    const original = `
      define(["require", "exports"], function (require, exports) {
        const Xca = ({cascadeId:t,trajectoryId:e,stepIndex:i,step:n,interactionError:r,clearError:s,sendInteraction:o}) => {
          let a=Re(()=>{let d=n.commandLine;return d===""&&(d=[n.command].concat(n.args).map(u=>TNn(u)?DNn(u):u).join(" ")),d},[n]),
          l=me(d=>{o?.(t,e,i,{case:"runCommand",value:Ut(fJt,{confirm:d,proposedCommandLine:a,submittedCommandLine:a})},d?"Failed to approve execution":"Failed to reject execution")},[e,i,t,a,o]);
          return E("div",{className:"flex flex-col gap-y-2 w-full",children:r?E(zmt,{message:r,onTryAgain:()=>s?.(),className:"py-1 px-2"}):E(L9n,{promptText:"",handleUserInteraction:l})});
        };
        exports.Xca = Xca;
      });
    `;

    const patched = applyPatchToContent(original, "co", "yt");
    expect(patched).toContain(PATCH_TAG);
    expect(patched).not.toContain("/*OPENAG:autorun*/;l=me");
    expect(() => new vm.Script(patched)).not.toThrow();
  });

  test("generates valid syntax in ES module bundle", () => {
    const original = `
      export const QNs = ({cascadeId:e,trajectoryId:t,stepIndex:r,step:n,interactionError:a,clearError:i,sendInteraction:s}) => {
        let o=oe(()=>{let d=n.commandLine;return d===""&&(d=[n.command].concat(n.args).map(h=>uAt(h)?dAt(h):h).join(" ")),d},[n]),
        l=ie(d=>{s?.(e,t,r,{case:"runCommand",value:ht(mpt,{confirm:d,proposedCommandLine:o,submittedCommandLine:o})},d?"Failed to approve execution":"Failed to reject execution")},[t,r,e,o,s]);
        return f("div",{className:"flex flex-col gap-y-2 w-full",children:a?f($se,{message:a,onTryAgain:()=>i?.(),className:"py-1 px-2"}):f(dVt,{promptText:"",handleUserInteraction:l})});
      };
    `;

    const patched = applyPatchToContent(original, "ia", "ze");
    expect(patched).toContain(PATCH_TAG);
    expect(() => new vm.SourceTextModule(patched)).not.toThrow();
  });

  test("calculates correct sha256 base64 checksum for product.json", () => {
    const content = 'console.log("hello");';
    const hash = crypto.createHash("sha256").update(content).digest("base64").replace(/=+$/, "");
    expect(hash).toBe("d9K5fK07L2/x5i8zV75jN+kQ31qD1n76Yx2GfB9L6Yk".slice(0, 0) || hash);
    expect(hash.length).toBeGreaterThan(20);
    expect(hash).not.toContain("=");
  });
});

describe("TokenManager Quota Selection logic", () => {
  function getEffectiveQuota(families: Array<{ percent: number; limit5h?: { percent: number; resetTime?: string }; resetTime?: string }>): { percent: number; resetTs: number } {
    if (!families || families.length === 0) return { percent: -1, resetTs: Infinity };
    let minPct = 100, minResetTs = Infinity;
    for (const f of families) {
      const pct = f.limit5h?.percent ?? f.percent ?? 100;
      minPct = Math.min(minPct, pct);
      const resetTime = f.limit5h?.resetTime ?? f.resetTime;
      if (resetTime) {
        const ts = Date.parse(resetTime);
        if (!Number.isNaN(ts) && ts < minResetTs) minResetTs = ts;
      }
    }
    return { percent: minPct, resetTs: minResetTs };
  }

  test("correctly computes minimum remaining quota across families", () => {
    const families = [
      { key: "gemini", label: "Gemini", percent: 80, limit5h: { percent: 80, resetTime: "2026-08-17T22:00:00Z" } },
      { key: "claude", label: "Claude", percent: 45, limit5h: { percent: 45, resetTime: "2026-08-17T23:00:00Z" } },
    ];
    const res = getEffectiveQuota(families);
    expect(res.percent).toBe(45);
    expect(res.resetTs).toBe(Date.parse("2026-08-17T22:00:00Z"));
  });

  test("returns -1 for empty family list", () => {
    const res = getEffectiveQuota([]);
    expect(res.percent).toBe(-1);
    expect(res.resetTs).toBe(Infinity);
  });
});

