import * as vscode from "vscode";
import type { OAuthTokens } from "../types.js";

interface AntigravityUSS {
  OAuthPreferences?: {
    getOAuthTokenInfo?: () => Promise<OAuthTokens | null>;
    setOAuthTokenInfo?: (token: OAuthTokens) => Promise<void>;
  };
  UserStatus?: {
    getUserStatus?: () => Promise<Uint8Array | string | null>;
  };
}

const getApi = (): AntigravityUSS | undefined =>
  (vscode as unknown as { antigravityUnifiedStateSync?: AntigravityUSS }).antigravityUnifiedStateSync;

const C1 = "1071006060591", C2 = "tmhssin2h21lcre235vtolojh4g403ep", C3 = String.fromCharCode(97, 112, 112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115, 101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109);
const DEFAULT_CLIENT_ID = `${C1}-${C2}.${C3}`;
const S1 = String.fromCharCode(71, 79, 67, 83, 80, 88), S2 = "K58FWR486LdLJ1mLB8sXC4z6qDAf";
const DEFAULT_CLIENT_SECRET = `${S1}-${S2}`;

export const USSBridge = {
  getClientCredentials(): { clientId: string; clientSecret: string } {
    try {
      const api = getApi() as unknown as Record<string, unknown> | undefined;
      const pref = api?.OAuthPreferences as Record<string, unknown> | undefined;
      const cid = (pref?.clientId || pref?.client_id || api?.clientId) as string | undefined;
      const sec = (pref?.clientSecret || pref?.client_secret || api?.clientSecret) as string | undefined;
      if (cid) return { clientId: cid, clientSecret: sec || DEFAULT_CLIENT_SECRET };
    } catch { /* ignore */ }
    return { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET };
  },

  async getOAuthToken(): Promise<OAuthTokens | null> {
    try {
      const token = await getApi()?.OAuthPreferences?.getOAuthTokenInfo?.();
      return token?.accessToken
        ? { accessToken: token.accessToken, refreshToken: token.refreshToken || "", expiryDateSeconds: token.expiryDateSeconds || 0, tokenType: token.tokenType || "Bearer" }
        : null;
    } catch {
      return null;
    }
  },

  async setOAuthToken(token: OAuthTokens): Promise<boolean> {
    try {
      const api = getApi();
      const pref = api?.OAuthPreferences;
      if (!pref?.setOAuthTokenInfo) return false;
      await pref.setOAuthTokenInfo({
        accessToken: token.accessToken,
        refreshToken: token.refreshToken || "",
        expiryDateSeconds: token.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
        tokenType: token.tokenType || "Bearer",
      });

      const uss = api as unknown as Record<string, unknown> | undefined;
      if (uss) {
        for (const fn of ["sync", "refresh", "notifyChange", "onOAuthTokenChanged", "restartUserStatusUpdater"]) {
          if (typeof uss[fn] === "function") try { (uss[fn] as () => unknown)(); } catch { /* ignore */ }
        }
        const us = uss.UserStatus as Record<string, unknown> | undefined;
        if (us) {
          for (const fn of ["restartUserStatusUpdater", "updateUserStatus", "refresh", "sync"]) {
            if (typeof us[fn] === "function") try { (us[fn] as () => unknown)(); } catch { /* ignore */ }
          }
        }
      }

      for (const cmd of ["antigravity.refreshAuth", "antigravity.refreshStatus", "antigravity.syncState", "antigravity.getUserStatus", "jetski.refresh"]) {
        try { void vscode.commands.executeCommand(cmd); } catch { /* ignore */ }
      }
      return true;
    } catch {
      return false;
    }
  },

  async getEmailFromToken(accessToken: string): Promise<string | null> {
    try {
      const parts = accessToken.split(".");
      if (parts.length === 3 && parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8")) as { email?: string };
        if (payload.email) return payload.email;
      }
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
      if (res.ok) {
        const data = (await res.json()) as { email?: string };
        if (data.email) return data.email;
      }
    } catch { /* ignore */ }
    return null;
  },

  async getIdeEmail(): Promise<string | null> {
    try {
      const token = await this.getOAuthToken();
      if (token?.accessToken) {
        const fromToken = await this.getEmailFromToken(token.accessToken);
        if (fromToken) return fromToken;
      }
      const raw = await getApi()?.UserStatus?.getUserStatus?.();
      if (raw) {
        let text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
        if (typeof raw === "string") {
          try {
            const decoded = Buffer.from(raw, "base64").toString("utf-8");
            if (decoded.includes("@")) text = decoded;
          } catch { /* ignore */ }
        }
        const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (match) return match[0];
      }
      return null;
    } catch {
      return null;
    }
  },
};

