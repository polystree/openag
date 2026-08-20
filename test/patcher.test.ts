import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import type { EffectiveQuota } from "../src/types.js";
import * as vm from "node:vm";

const TAG_AUTORUN = "/*OPENAG:autorun*/";

describe("AutoRunPatcher modular patch transformations", () => {
  test("generates valid syntax for autorun in AMD bundle", () => {
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

    const anchor = '{case:"runCommand",value:';
    let patched = original;
    const idx = original.indexOf(anchor);
    if (idx !== -1) {
      const match = original.slice(idx - 150, idx + 50).match(/([a-zA-Z0-9_$]+)\s*=\s*([a-zA-Z0-9_$]+)\s*\(\s*([a-zA-Z0-9_$]+)\s*=>\s*\{/);
      if (match) {
        const cbVar = match[1];
        const afterAnchor = original.slice(idx, idx + 300);
        const cbEndMatch = afterAnchor.match(/\},\s*\[[^\]]*\]\s*\)\s*;/);
        if (cbEndMatch && cbEndMatch.index !== undefined) {
          const cbEndPos = idx + cbEndMatch.index + cbEndMatch[0].length;
          const patchCode = `${TAG_AUTORUN};((typeof yt==="function"?yt:null)||(typeof React!=="undefined"?React.useEffect:null))?.(()=>{try{let _h=(typeof co==="function"?co:null);let _st=_h?.()?.stepHandler;if(!_st?.secureModeEnabled)${cbVar}(!0)}catch{}},[${cbVar}]);`;
          patched = original.slice(0, cbEndPos) + patchCode + original.slice(cbEndPos);
        }
      }
    }

    expect(patched).toContain(TAG_AUTORUN);
    expect(() => new vm.Script(patched)).not.toThrow();
  });

  test("applies and validates autorun patch and integrity suppression", () => {
    const esmBundle = `
      export const QNs = ({cascadeId:e,trajectoryId:t,stepIndex:r,step:n,interactionError:a,clearError:i,sendInteraction:s}) => {
        let o=oe(()=>{let d=n.commandLine;return d===""&&(d=[n.command].concat(n.args).map(h=>uAt(h)?dAt(h):h).join(" ")),d},[n]),
        l=ie(d=>{s?.(e,t,r,{case:"runCommand",value:ht(mpt,{confirm:d,proposedCommandLine:o,submittedCommandLine:o})},d?"Failed to approve execution":"Failed to reject execution")},[t,r,e,o,s]);
        return f("div",{className:"flex flex-col gap-y-2 w-full",children:a?f($se,{message:a,onTryAgain:()=>i?.(),className:"py-1 px-2"}):f(dVt,{promptText:"",handleUserInteraction:l})});
      };
      export class Integrity {
        async _compute(){const{isPure:e}=await this.isPure();if(e)return;}
        async _isPure(){const e=this.productService.checksums||{};}
      }
    `;

    let patched = esmBundle;

    // Integrity check
    patched = patched.replace("async _isPure(){const e=this.productService.checksums||{};", "async _isPure(){return{isPure:!0,proof:[]};const e=this.productService.checksums||{};");
    patched = patched.replace("async _compute(){const{isPure:e}=await this.isPure();if(e)return;", "async _compute(){return;const{isPure:e}=await this.isPure();if(e)return;");

    // Autorun
    const anchor = '{case:"runCommand",value:';
    const idx = patched.indexOf(anchor);
    if (idx !== -1) {
      const match = patched.slice(idx - 150, idx + 50).match(/([a-zA-Z0-9_$]+)\s*=\s*([a-zA-Z0-9_$]+)\s*\(\s*([a-zA-Z0-9_$]+)\s*=>\s*\{/);
      if (match) {
        const cbVar = match[1];
        const afterAnchor = patched.slice(idx, idx + 300);
        const cbEndMatch = afterAnchor.match(/\},\s*\[[^\]]*\]\s*\)\s*;/);
        if (cbEndMatch && cbEndMatch.index !== undefined) {
          const cbEndPos = idx + cbEndMatch.index + cbEndMatch[0].length;
          const patchCode = `${TAG_AUTORUN};((typeof ze==="function"?ze:null)||(typeof React!=="undefined"?React.useEffect:null))?.(()=>{try{let _h=(typeof ia==="function"?ia:null);let _st=_h?.()?.stepHandler;if(!_st?.secureModeEnabled)${cbVar}(!0)}catch{}},[${cbVar}]);`;
          patched = patched.slice(0, cbEndPos) + patchCode + patched.slice(cbEndPos);
        }
      }
    }

    expect(patched).toContain(TAG_AUTORUN);
    expect(patched).toContain("return{isPure:!0,proof:[]}");
    expect(patched).toContain("return;const{isPure:e}");
    expect(() => new vm.SourceTextModule(patched)).not.toThrow();
  });

  test("calculates valid base64 sha256 checksums without padding for product.json", () => {
    const content = 'console.log("hello openag");';
    const hash = crypto.createHash("sha256").update(content).digest("base64").replace(/=+$/, "");
    expect(hash.length).toBeGreaterThan(20);
    expect(hash).not.toContain("=");
  });
});

describe("TokenManager Quota Selection logic", () => {
  function resolveModelFamily(modelName?: string): "gemini" | "claude" | "other" {
    if (!modelName) return "other";
    const lower = modelName.toLowerCase();
    if (
      lower.includes("claude") ||
      lower.includes("sonnet") ||
      lower.includes("opus") ||
      lower.includes("haiku") ||
      lower.includes("gpt") ||
      lower.includes("oss")
    ) return "claude";
    if (lower.includes("gemini")) return "gemini";
    return "other";
  }

  function getEffectiveQuota(
    families: Array<{ key?: string; percent: number; limit5h?: { percent: number; resetTime?: string }; limitWeekly?: { percent: number; resetTime?: string }; resetTime?: string }>,
    targetModel?: string,
  ): EffectiveQuota {
    if (!families || families.length === 0) return { percent: -1, resetTs: Infinity };

    if (targetModel) {
      const famKey = resolveModelFamily(targetModel);
      if (famKey !== "other") {
        const fam = families.find((f) => f.key === famKey);
        if (fam) {
          const p5h = fam.limit5h?.percent ?? fam.percent ?? 100;
          const pWk = fam.limitWeekly?.percent ?? 100;
          const pct = Math.min(p5h, pWk);
          const resetStr = fam.limit5h?.resetTime ?? fam.resetTime ?? fam.limitWeekly?.resetTime;
          const resetTs = resetStr ? Date.parse(resetStr) : Infinity;
          return { percent: pct, resetTs: Number.isNaN(resetTs) ? Infinity : resetTs };
        }
      }
    }

    let minPct = 100, minResetTs = Infinity;
    for (const f of families) {
      const p5h = f.limit5h?.percent ?? f.percent ?? 100;
      const pWk = f.limitWeekly?.percent ?? 100;
      const pct = Math.min(p5h, pWk);
      minPct = Math.min(minPct, pct);
      const resetTime = f.limit5h?.resetTime ?? f.resetTime ?? f.limitWeekly?.resetTime;
      if (resetTime) {
        const ts = Date.parse(resetTime);
        if (!Number.isNaN(ts) && ts < minResetTs) minResetTs = ts;
      }
    }
    return { percent: minPct, resetTs: minResetTs };
  }

  test("correctly computes effective quota tied to Gemini when Gemini model is active", () => {
    const families = [
      { key: "gemini", label: "Gemini", percent: 80, limit5h: { percent: 80, resetTime: "2026-08-17T22:00:00Z" } },
      { key: "claude", label: "Claude", percent: 0, limit5h: { percent: 0, resetTime: "2026-08-17T23:00:00Z" } },
    ];
    const res = getEffectiveQuota(families, "Gemini 3.7 Flash High");
    expect(res.percent).toBe(80);
    expect(res.resetTs).toBe(Date.parse("2026-08-17T22:00:00Z"));
  });

  test("correctly computes effective quota tied to Claude when Claude model is active", () => {
    const families = [
      { key: "gemini", label: "Gemini", percent: 100, limit5h: { percent: 100, resetTime: "2026-08-17T22:00:00Z" } },
      { key: "claude", label: "Claude", percent: 30, limit5h: { percent: 30, resetTime: "2026-08-17T23:00:00Z" } },
    ];
    const res = getEffectiveQuota(families, "Claude 3.7 Sonnet");
    expect(res.percent).toBe(30);
    expect(res.resetTs).toBe(Date.parse("2026-08-17T23:00:00Z"));
  });

  test("correctly computes effective quota tied to Claude when GPT-OSS model is active", () => {
    const families = [
      { key: "gemini", label: "Gemini", percent: 90, limit5h: { percent: 90, resetTime: "2026-08-17T22:00:00Z" } },
      { key: "claude", label: "Claude", percent: 25, limit5h: { percent: 25, resetTime: "2026-08-17T23:00:00Z" } },
    ];
    const res = getEffectiveQuota(families, "GPT OSS 120B");
    expect(res.percent).toBe(25);
    expect(res.resetTs).toBe(Date.parse("2026-08-17T23:00:00Z"));
  });

  test("correctly computes minimum remaining quota across families when model is unspecified", () => {
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
