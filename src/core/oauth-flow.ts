import * as crypto from "node:crypto";
import * as http from "node:http";
import * as vscode from "vscode";
import type { OAuthTokens } from "../types.js";
import { USSBridge } from "./uss-bridge.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cloud-platform",
].join(" ");

export interface OAuthFlowResult {
  email: string;
  tokens: OAuthTokens;
}

async function requestToken(params: URLSearchParams): Promise<OAuthTokens> {
  const creds = USSBridge.getClientCredentials();
  params.set("client_id", creds.clientId);
  if (creds.clientSecret) params.set("client_secret", creds.clientSecret);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Token request failed HTTP ${res.status}: ${await res.text()}`);
  // SAFETY: Google OAuth token endpoint response payload
  const data = (await res.json()) as { access_token: string; expires_in?: number; refresh_token?: string; token_type?: string };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || params.get("refresh_token") || "",
    expiryDateSeconds: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    tokenType: data.token_type || "Bearer",
  };
}

async function fetchUserEmail(accessToken: string): Promise<string> {
  const res = await fetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Failed to fetch user email (HTTP ${res.status})`);
  // SAFETY: Google userinfo endpoint returns profile with email string
  const data = (await res.json()) as { email?: string };
  if (!data.email) throw new Error("No email found in profile");
  return data.email;
}

export const OAuthFlow = {
  startLogin(): Promise<OAuthFlowResult> {
    return new Promise((resolve, reject) => {
      let server: http.Server | null = null;
      let timeout: NodeJS.Timeout | null = null;
      const expectedState = crypto.randomBytes(16).toString("hex");

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        server?.close();
      };

      server = http.createServer(async (req, res) => {
        try {
          const reqUrl = new URL(req.url || "/", "http://127.0.0.1");
          if (reqUrl.pathname !== "/oauth2callback") {
            res.writeHead(404).end("Not Found");
            return;
          }
          const code = reqUrl.searchParams.get("code");
          const state = reqUrl.searchParams.get("state");
          const error = reqUrl.searchParams.get("error");
          if (error || !code || state !== expectedState) {
            const errDetail = error || (state !== expectedState ? "Invalid OAuth state" : "Missing code");
            res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(`<h3>Login Failed</h3><p>${errDetail}</p>`);
            cleanup();
            reject(new Error(error ? `OAuth error: ${error}` : errDetail));
            return;
          }

          // SAFETY: HTTP server address on TCP socket returns AddressInfo object with port
          const addr = server?.address() as { port: number } | null;
          const redirectUri = `http://127.0.0.1:${addr?.port || 0}/oauth2callback`;
          const tokens = await requestToken(new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }));
          const email = await fetchUserEmail(tokens.accessToken);

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
            `<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="background:#161b22;padding:2rem;border-radius:8px;border:1px solid #30363d;text-align:center;"><h2 style="color:#58a6ff;margin:0 0 8px;">Authorized</h2><p><strong>${email}</strong> added to OpenAG. You may close this tab.</p></div></body></html>`
          );
          cleanup();
          resolve({ email, tokens });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(500, { "Content-Type": "text/plain" }).end(`Auth Error: ${msg}`);
          cleanup();
          reject(err);
        }
      });

      server.listen(0, "127.0.0.1", () => {
        // SAFETY: HTTP server address on TCP socket returns AddressInfo object with port
        const addr = server?.address() as { port: number } | null;
        const port = addr?.port || 0;
        const redirectUri = `http://127.0.0.1:${port}/oauth2callback`;
        const creds = USSBridge.getClientCredentials();
        const authParams = new URLSearchParams({
          client_id: creds.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent",
          state: expectedState,
        });

        const authUrl = `${GOOGLE_AUTH_URL}?${authParams.toString()}`;
        void vscode.env.openExternal(vscode.Uri.parse(authUrl)).then(
          (opened) => { if (!opened) void vscode.env.clipboard.writeText(authUrl); },
          () => void vscode.env.clipboard.writeText(authUrl),
        );
        timeout = setTimeout(() => { cleanup(); reject(new Error("Login timed out after 3 minutes")); }, 180000);
      });

      server.on("error", (err) => { cleanup(); reject(err); });
    });
  },
};

