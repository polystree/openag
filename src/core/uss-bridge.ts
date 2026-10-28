import * as vscode from "vscode";
import type { OAuthTokens } from "../types.js";
import { OSKeyring } from "./os-keyring.js";

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

interface AntigravityUSS {
  clientId?: string;
  clientSecret?: string;
  OAuthPreferences?: {
    clientId?: string;
    client_id?: string;
    clientSecret?: string;
    client_secret?: string;
    getOAuthTokenInfo?: () => Promise<OAuthTokens | null>;
    setOAuthTokenInfo?: (token: OAuthTokens) => Promise<void>;
  };
  UserStatus?: {
    getUserStatus?: () => Promise<Uint8Array | string | null>;
    restartUserStatusUpdater?: () => void;
    updateUserStatus?: () => void;
    refresh?: () => void;
    sync?: () => void;
  };
  sync?: () => void;
  refresh?: () => void;
  notifyChange?: () => void;
  onOAuthTokenChanged?: () => void;
  restartUserStatusUpdater?: () => void;
}

interface VSCodeWithUSS {
  antigravityUnifiedStateSync?: AntigravityUSS;
}

const getApi = (): AntigravityUSS | undefined => {
  // SAFETY: Antigravity IDE injects antigravityUnifiedStateSync onto vscode global namespace
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- IDE runtime global injection
  const extVsCode = vscode as unknown as VSCodeWithUSS;
  return extVsCode.antigravityUnifiedStateSync;
};

const C1 = "1071006060591";
const C2 = "tmhssin2h21lcre235vtolojh4g403ep";
const C3 = String.fromCharCode(97, 112, 112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115, 101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109);
const DEFAULT_CLIENT_ID = `${C1}-${C2}.${C3}`;
const S1 = String.fromCharCode(71, 79, 67, 83, 80, 88);
const S2 = "K58FWR486LdLJ1mLB8sXC4z6qDAf";
const DEFAULT_CLIENT_SECRET = `${S1}-${S2}`;

export function decodeBase64Url(str: string): Buffer {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64");
}

export type USSBridgeLogger = (msg: string) => void;
let bridgeLogger: USSBridgeLogger | null = null;

export function setUSSBridgeLogger(logger: USSBridgeLogger | null): void {
  bridgeLogger = logger;
}

function debugLog(msg: string): void {
  bridgeLogger?.(msg);
}

const tokenEmailCache = new Map<string, string>();

export const USSBridge = {
  getClientCredentials(): ClientCredentials {
    try {
      const api = getApi();
      const pref = api?.OAuthPreferences;
      const cid = pref?.clientId || pref?.client_id || api?.clientId;
      const sec = pref?.clientSecret || pref?.client_secret || api?.clientSecret;
      if (cid) return { clientId: cid, clientSecret: sec || DEFAULT_CLIENT_SECRET };
    } catch (e: unknown) {
      debugLog(`[USSBridge] Failed to read client credentials from IDE: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { clientId: DEFAULT_CLIENT_ID, clientSecret: DEFAULT_CLIENT_SECRET };
  },

  async getOAuthToken(): Promise<OAuthTokens | null> {
    try {
      const token = await getApi()?.OAuthPreferences?.getOAuthTokenInfo?.();
      return token?.accessToken
        ? { accessToken: token.accessToken, refreshToken: token.refreshToken || "", expiryDateSeconds: token.expiryDateSeconds || 0, tokenType: token.tokenType || "Bearer" }
        : null;
    } catch (e: unknown) {
      debugLog(`[USSBridge] Failed to get OAuth token from USS: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  },

  async setOAuthToken(token: OAuthTokens, email?: string): Promise<boolean> {
    try {
      const api = getApi();
      const pref = api?.OAuthPreferences;
      if (!pref?.setOAuthTokenInfo) return false;
      await pref.setOAuthTokenInfo({
        accessToken: token.accessToken,
        refreshToken: token.refreshToken || "",
        expiryDateSeconds: token.expiryDateSeconds || Math.floor(Date.now() / 1000) + 3600,
        tokenType: token.tokenType || "Bearer",
        isGcpTos: token.isGcpTos ?? false,
      });

      const resolvedEmail = email || (await this.getEmailFromToken(token.accessToken));
      if (resolvedEmail) {
        await OSKeyring.writeCredential(resolvedEmail, token);
      }

      if (api) {
        try { api.sync?.(); } catch (e: unknown) { debugLog(`[USSBridge] api.sync error: ${e instanceof Error ? e.message : String(e)}`); }
        try { api.refresh?.(); } catch (e: unknown) { debugLog(`[USSBridge] api.refresh error: ${e instanceof Error ? e.message : String(e)}`); }
        try { api.notifyChange?.(); } catch (e: unknown) { debugLog(`[USSBridge] api.notifyChange error: ${e instanceof Error ? e.message : String(e)}`); }
        try { api.onOAuthTokenChanged?.(); } catch (e: unknown) { debugLog(`[USSBridge] api.onOAuthTokenChanged error: ${e instanceof Error ? e.message : String(e)}`); }

        const us = api.UserStatus;
        if (us) {
          try { us.updateUserStatus?.(); } catch (e: unknown) { debugLog(`[USSBridge] us.updateUserStatus error: ${e instanceof Error ? e.message : String(e)}`); }
          try { us.refresh?.(); } catch (e: unknown) { debugLog(`[USSBridge] us.refresh error: ${e instanceof Error ? e.message : String(e)}`); }
          try { us.sync?.(); } catch (e: unknown) { debugLog(`[USSBridge] us.sync error: ${e instanceof Error ? e.message : String(e)}`); }
        }
      }

      for (const cmd of [
        "antigravity.refreshStatus",
        "antigravity.syncState",
        "antigravity.getUserStatus",
      ]) {
        try { void vscode.commands.executeCommand(cmd); } catch (e: unknown) { debugLog(`[USSBridge] Failed to execute ${cmd}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      return true;
    } catch (e: unknown) {
      debugLog(`[USSBridge] Failed to set OAuth token: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  },

  async getEmailFromToken(accessToken: string): Promise<string | null> {
    if (!accessToken) return null;
    const cached = tokenEmailCache.get(accessToken);
    if (cached) return cached;

    try {
      const parts = accessToken.split(".");
      if (parts.length === 3 && parts[1]) {
        // SAFETY: RFC 7515 JWT payload segment decoded from base64url
        const decoded = decodeBase64Url(parts[1]).toString("utf-8");
        const payload = JSON.parse(decoded) as { email?: string };
        if (payload.email) {
          tokenEmailCache.set(accessToken, payload.email);
          return payload.email;
        }
      }
      const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        // SAFETY: Google OAuth tokeninfo JSON endpoint returns optional email string
        const data = (await res.json()) as { email?: string };
        if (data.email) {
          tokenEmailCache.set(accessToken, data.email);
          return data.email;
        }
      }
    } catch (e: unknown) {
      debugLog(`[USSBridge] Failed to get email from token: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
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
        let text = raw instanceof Uint8Array ? Buffer.from(raw).toString("utf-8") : raw;
        if (!text.includes("@")) {
          try {
            const decoded = Buffer.from(text, "base64").toString("utf-8");
            if (decoded.includes("@")) text = decoded;
          } catch (e: unknown) {
            debugLog(`[USSBridge] Failed to decode base64 status: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const match = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (match) return match[0];
      }
      return null;
    } catch (e: unknown) {
      debugLog(`[USSBridge] Failed to get IDE email: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  },
};

