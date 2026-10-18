import { logger } from "../../../utils/logger.js";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import open from "open";
import type { ApiTier, OAuthConfig, TokenStore, AccountToken } from "../../../types/index.js";
import { tokenRepository } from "../../../auth/token-repository.js";
import {
  currentExecutionSignal,
  fetchWithExecutionContext as fetch,
} from "../../../utils/execution-context.js";

/** Default OAuth config — Thunderbird's registered app ID. */
const DEFAULT_OAUTH: OAuthConfig = {
  clientId: "9e5f94bc-e8a4-4e73-b8be-63364c29d753",
  tenant: "common",
};

/**
 * Redirect URI registered on Thunderbird's app.
 * Microsoft will redirect to this URL with ?code=... in the query string.
 * We use a local HTTP server that intercepts requests to ANY path and
 * extracts the code, then we exchange it using this exact redirect_uri.
 */
/**
 * The ordinary navigable redirect URI (Thunderbird and most public clients
 * register it). Exported because the automatic login path points the webview
 * capture at this same URI, which makes that flow the browser flow minus the
 * manual copy-paste step.
 */
export const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";

// Exported for unit tests (and any future auth path) so endpoint + param
// construction has a single source of truth and can't drift.
export function authEndpoint(oauth: OAuthConfig): string {
  const suffix = oauth.apiVersion === "v1" ? "oauth2/authorize" : "oauth2/v2.0/authorize";
  return `https://login.microsoftonline.com/${oauth.tenant}/${suffix}`;
}

function deviceCodeEndpoint(oauth: OAuthConfig): string {
  const suffix = oauth.apiVersion === "v1" ? "oauth2/devicecode" : "oauth2/v2.0/devicecode";
  return `https://login.microsoftonline.com/${oauth.tenant}/${suffix}`;
}

export function tokenEndpoint(oauth: OAuthConfig): string {
  const suffix = oauth.apiVersion === "v1" ? "oauth2/token" : "oauth2/v2.0/token";
  return `https://login.microsoftonline.com/${oauth.tenant}/${suffix}`;
}

/**
 * The per-tier authorization parameter: v1 identifies the target API by
 * `resource=`, v2 by `scope=`. Single source of truth for every flow
 * (auth-code, refresh, device-code) so they can't diverge.
 */
export function tierAuthParam(oauth: OAuthConfig, tier: ApiTier): Record<string, string> {
  if (oauth.apiVersion === "v1") return { resource: TIER_RESOURCES[tier] };
  // v1 has no per-permission scopes, so extras only apply to v2. Deduplicated so
  // repeating a tier default cannot produce an invalid scope string.
  const scopes = [...TIER_SCOPES[tier].split(" "), ...(oauth.extraScopes ?? [])].filter(Boolean);
  return { scope: [...new Set(scopes)].join(" ") };
}

/** Scope sets per API tier (v2.0 endpoint — `scope=`). */
export const TIER_SCOPES: Record<ApiTier, string> = {
  graph:
    "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Contacts.Read offline_access",
  ews: "https://outlook.office.com/EWS.AccessAsUser.All offline_access",
  imap: "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access",
  google: "", // Google scopes handled in google-auth.ts
};

/**
 * Resource identifiers per API tier (legacy v1 endpoint — `resource=`).
 * v1 has no per-permission scope string; permissions are whatever was
 * consented for the app against this resource as a whole.
 */
export const TIER_RESOURCES: Record<ApiTier, string> = {
  graph: "https://graph.microsoft.com",
  ews: "https://outlook.office.com",
  imap: "https://outlook.office.com",
  google: "", // N/A — Google auth never goes through this module.
};

/** Thrown when CA policy requires interactive re-authentication (e.g. sign-in frequency). */
export class InteractionRequiredError extends Error {
  constructor(public readonly account: string) {
    super(
      `Re-authentication required for ${account} (refresh token expired/revoked or ` +
        `Conditional Access requires a fresh sign-in). Re-run login: ` +
        `\`eule login --device --tier <graph|ews>\` (cross-platform), or the browser/` +
        `webview flow for clients whose redirect URIs are broker-bound.`,
    );
    this.name = "InteractionRequiredError";
  }
}

/** Generate PKCE code verifier + challenge. */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Load token store from disk. Never throws — a corrupt store starts empty. */
export function loadTokens(): TokenStore {
  return tokenRepository.load();
}

/** Save token store to disk with owner-only (0600) permissions. */
export function saveTokens(store: TokenStore): void {
  tokenRepository.save(store);
}

/** Validates an OAuth token-endpoint response, rejecting malformed payloads. */
export function parseTokenResponse(data: unknown): {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
} {
  if (typeof data !== "object" || data === null) {
    throw new Error("Malformed token response (not an object)");
  }
  const d = data as Record<string, unknown>;
  if (typeof d.access_token !== "string" || d.access_token.length === 0) {
    throw new Error("Token response missing access_token");
  }
  return {
    access_token: d.access_token,
    refresh_token: typeof d.refresh_token === "string" ? d.refresh_token : undefined,
    // Default to 1h rather than trusting a missing/NaN value (which would make
    // expiresAt NaN and break the refresh-timing comparison).
    expires_in:
      typeof d.expires_in === "number" && Number.isFinite(d.expires_in) ? d.expires_in : 3600,
  };
}

/** Refresh an expired access token using the refresh token. */
export async function refreshAccessToken(
  account: string,
  oauth: OAuthConfig = DEFAULT_OAUTH,
): Promise<AccountToken | null> {
  const token = loadTokens().accounts[account];
  if (!token?.refreshToken) return null;

  // The v1-vs-v2 endpoint generation is a property of the issuing CLIENT, not of
  // global config: Thunderbird/Apple public clients are v1-only. Reuse what the
  // token was minted with (falling back to global config for pre-migration
  // tokens) so a mixed v1+v2 store, or a changed global default, can't silently
  // rebuild the wrong request and fail refresh.
  const clientId = token.clientId ?? oauth.clientId;
  const apiVersion = token.apiVersion ?? oauth.apiVersion;
  const endpointOauth: OAuthConfig = { ...oauth, clientId, apiVersion };
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    ...tierAuthParam(endpointOauth, token.tier),
  });

  const res = await fetch(tokenEndpoint(endpointOauth), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errBody = await res.text();
    // Treat both interactive-required (CA sign-in frequency / MFA) AND a
    // dead refresh token (expired, revoked, rotated-away, consent withdrawn)
    // as "must re-authenticate" — otherwise these surface as a silent null
    // that a connector reports as "no data", indistinguishable from an empty
    // mailbox. AADSTS700082=RT expired, 700084/50173=revoked/pw-change,
    // 65001=consent revoked; invalid_grant is the umbrella error class.
    if (
      /interaction_required|invalid_grant|AADSTS(50076|50078|700082|700084|50173|65001)/.test(
        errBody,
      )
    ) {
      throw new InteractionRequiredError(account);
    }
    return null;
  }

  const data = parseTokenResponse(await res.json());

  // Re-read the store immediately before writing (rather than reusing the
  // snapshot from the top of this function): v1 refresh ROTATES the refresh
  // token every call, and concurrent refreshes of sibling accounts (e.g.
  // BriefingService's Promise.all over calendar+mail) would otherwise let the
  // last writer clobber a sibling's freshly-rotated refresh token, killing its
  // auth. Read-modify-write of only this account's key keeps siblings intact.
  const store = loadTokens();
  const prior = store.accounts[account] ?? token;
  const updated: AccountToken = {
    ...prior,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? prior.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    clientId,
    apiVersion,
  };

  store.accounts[account] = updated;
  saveTokens(store);
  return updated;
}

/** Get a valid access token for an account, refreshing if needed. */
export async function getAccessToken(
  account: string,
  oauth: OAuthConfig = DEFAULT_OAUTH,
): Promise<string | null> {
  const store = loadTokens();
  const token = store.accounts[account];
  if (!token) return null;

  if (token.expiresAt - Date.now() < 5 * 60 * 1000) {
    const refreshed = await refreshAccessToken(account, oauth);
    return refreshed?.accessToken ?? null;
  }

  return token.accessToken;
}

/** Access tokens minted for a tier other than the one an account signed in with. */
const tierTokenCache = new Map<string, { accessToken: string; expiresAt: number }>();
const tierTokenInFlight = new Map<string, Promise<string | null>>();

/**
 * An access token for `tier`, for an account that signed in with another tier.
 *
 * The refresh token of the sign-in is redeemed for the other API. That is how
 * Thunderbird gets by with a single sign-in per account: a Graph sign-in with
 * its registration can read and write mail, but only the Exchange Online
 * resource (IMAP and SMTP.Send) lets it send. The access token is kept in
 * memory only; the stored token of the account stays as it was, except for the
 * rotated refresh token, which has to be saved or the next refresh fails.
 */
export async function getAccessTokenForTier(
  account: string,
  tier: ApiTier,
  oauth: OAuthConfig = DEFAULT_OAUTH,
): Promise<string | null> {
  const stored = loadTokens().accounts[account];
  if (!stored) return null;
  if (stored.tier === tier) return getAccessToken(account, oauth);

  const key = `${account}|${tier}`;
  const cached = tierTokenCache.get(key);
  if (cached && cached.expiresAt - Date.now() >= 5 * 60 * 1000) return cached.accessToken;

  // Two callers at once would each rotate the refresh token, and the second
  // would redeem one that is already spent.
  const pending = tierTokenInFlight.get(key);
  if (pending) return pending;

  const run = redeemForTier(account, tier, oauth, key).finally(() => tierTokenInFlight.delete(key));
  tierTokenInFlight.set(key, run);
  return run;
}

async function redeemForTier(
  account: string,
  tier: ApiTier,
  oauth: OAuthConfig,
  cacheKey: string,
): Promise<string | null> {
  const token = loadTokens().accounts[account];
  if (!token?.refreshToken) return null;

  const clientId = token.clientId ?? oauth.clientId;
  const apiVersion = token.apiVersion ?? oauth.apiVersion;
  const endpointOauth: OAuthConfig = { ...oauth, clientId, apiVersion };
  const res = await fetch(tokenEndpoint(endpointOauth), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: token.refreshToken,
      ...tierAuthParam(endpointOauth, tier),
    }).toString(),
  });

  if (!res.ok) {
    const errBody = await res.text();
    // A dead refresh token needs a new sign-in. A refusal for the other
    // resource (consent not given, resource unknown) does not: signing in
    // again would not help, so it says what Microsoft said.
    if (
      /interaction_required|invalid_grant|AADSTS(50076|50078|700082|700084|50173)/.test(errBody)
    ) {
      throw new InteractionRequiredError(account);
    }
    throw new Error(
      `Microsoft refused to issue a token for the ${tier} tier of ${account} (${String(res.status)}): ${errBody.slice(0, 300)}`,
    );
  }

  const data = parseTokenResponse(await res.json());

  // Only the refresh token is written back; see getAccessTokenForTier.
  if (data.refresh_token) {
    const store = loadTokens();
    const prior = store.accounts[account] ?? token;
    store.accounts[account] = { ...prior, refreshToken: data.refresh_token };
    saveTokens(store);
  }

  tierTokenCache.set(cacheKey, {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  return data.access_token;
}

/**
 * Exchange an authorization code for tokens.
 */
async function exchangeCode(
  code: string,
  verifier: string,
  tier: ApiTier,
  oauth: OAuthConfig,
): Promise<AccountToken> {
  const body = new URLSearchParams({
    client_id: oauth.clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
    ...tierAuthParam(oauth, tier),
  });

  const res = await fetch(tokenEndpoint(oauth), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Token exchange failed: ${errText}`);
  }

  const data = parseTokenResponse(await res.json());

  const account = extractEmail(data.access_token) ?? "unknown";
  return {
    account,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? "",
    expiresAt: Date.now() + data.expires_in * 1000,
    tier: "graph", // Will be set by caller
  };
}

/**
 * Run the interactive browser-based OAuth2 authorization code flow with PKCE.
 *
 * Uses the nativeclient redirect URI registered on Thunderbird's app.
 * After login, Microsoft redirects to the nativeclient URL with ?code=...
 * We start a local server that shows a page asking the user to paste the
 * full redirect URL, OR we try to intercept it automatically.
 */
export async function authenticateAccount(
  tier: ApiTier,
  accountHint?: string,
  oauth: OAuthConfig = DEFAULT_OAUTH,
): Promise<AccountToken> {
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: oauth.clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    response_mode: "query",
    ...tierAuthParam(oauth, tier),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "select_account",
  });

  if (accountHint) {
    params.set("login_hint", accountHint);
  }

  const authUrl = `${authEndpoint(oauth)}?${params.toString()}`;

  return new Promise<AccountToken>((resolve, reject) => {
    const signal = currentExecutionSignal();
    // Start a local server that serves a page to capture the redirect URL.
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");

      // Check if this is a POST with the pasted URL.
      if (req.method === "POST" && url.pathname === "/submit") {
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const formData = new URLSearchParams(body);
          const pastedUrl = formData.get("url") ?? "";

          let code: string | null = null;
          try {
            const parsed = new URL(pastedUrl);
            code = parsed.searchParams.get("code");
            const returnedState = parsed.searchParams.get("state");
            if (returnedState !== state) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end("<h1>❌ State mismatch</h1><p>Try again.</p>");
              return;
            }
          } catch {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(
              "<h1>❌ Invalid URL</h1><p>Paste the full URL from the browser address bar.</p>",
            );
            return;
          }

          if (!code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<h1>❌ No code found</h1><p>Paste the full URL including ?code=...</p>");
            return;
          }

          void (async () => {
            try {
              const tokenData = await exchangeCode(code, verifier, tier, oauth);
              const result: AccountToken = {
                ...tokenData,
                tier,
                clientId: oauth.clientId,
                apiVersion: oauth.apiVersion,
              };

              const store = loadTokens();
              store.accounts[result.account] = result;
              saveTokens(store);

              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(
                `<h1>✅ Authenticated!</h1><p>Account: ${result.account}</p><p>Tier: ${tier}</p><p>You can close this window.</p>`,
              );
              server.close();
              finish();
              resolve(result);
            } catch (err) {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(
                `<h1>❌ Error</h1><pre>${err instanceof Error ? err.message : String(err)}</pre>`,
              );
              server.close();
              finish();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        });
        return;
      }

      // Serve the capture page.
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html>
<html><head><title>Eule MCP — OAuth Callback</title>
<style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px}
input[type=text]{width:100%;padding:8px;font-size:14px;margin:8px 0}
button{padding:10px 20px;font-size:16px;cursor:pointer;background:#0078d4;color:white;border:none;border-radius:4px}</style>
</head><body>
<h1>🦉 Eule MCP — Authentication</h1>
<p>After logging in, Microsoft will redirect you to a blank page or an error page. This is expected.</p>
<p><strong>Copy the full URL from your browser's address bar</strong> and paste it below:</p>
<form method="POST" action="/submit">
<input type="text" name="url" placeholder="https://login.microsoftonline.com/common/oauth2/nativeclient?code=..." autofocus>
<br><button type="submit">Submit</button>
</form>
<p><small>The URL should start with <code>https://login.microsoftonline.com/common/oauth2/nativeclient?code=</code></small></p>
</body></html>`);
    });

    const abort = (): void => {
      server.close();
      finish();
      reject(new Error("Authentication cancelled"));
    };
    const finish = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const timeout = setTimeout(
      () => {
        server.close();
        finish();
        reject(new Error("Authentication timed out (5 minutes)"));
      },
      5 * 60 * 1000,
    );

    // Without this, a listen failure (e.g. EADDRINUSE) is emitted as an
    // unhandled 'error' event and crashes the whole process.
    server.on("error", (err) => {
      finish();
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;

      logger.info(`\nOpening browser for authentication...`);
      logger.info(`After login, paste the redirect URL at: http://localhost:${String(port)}\n`);
      logger.info(`If the browser doesn't open, visit:\n${authUrl}\n`);
      void open(authUrl);

      // Also open the capture page.
      setTimeout(() => {
        if (!signal?.aborted) void open(`http://localhost:${String(port)}`);
      }, 1000);
    });
  });
}

/** Prompt shown to the user to complete a device-code login. */
export interface DeviceCodePrompt {
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly message: string;
  readonly expiresInSeconds: number;
}

/**
 * Device-code OAuth flow (cross-platform: pure HTTP, no redirect URI, no
 * webview, works over SSH). The user opens a URL on ANY device and types the
 * code; we poll the token endpoint until they finish.
 *
 * This is the portable alternative to authenticateAccount's browser-paste
 * flow, which cannot work with clients whose only redirect URIs are broker-
 * bound (e.g. Apple Internet Accounts). NOTE: a tenant Conditional Access
 * policy can block the device-code *authentication flow* entirely (a common
 * anti-phishing control) — the initiation still returns a user_code but the
 * poll ends in access_denied/authorization_declined; fall back to the webview
 * capture in that case.
 *
 * The token is stamped with `clientId` and `apiVersion` (so refresh reuses the
 * exact app + endpoint that issued it) and merged into the token store.
 */
export async function authenticateAccountDeviceCode(
  tier: ApiTier,
  oauth: OAuthConfig = DEFAULT_OAUTH,
  onPrompt?: (p: DeviceCodePrompt) => void,
): Promise<AccountToken> {
  const isV1 = oauth.apiVersion === "v1";

  // 1. Request a device + user code.
  const initBody = new URLSearchParams({
    client_id: oauth.clientId,
    ...tierAuthParam(oauth, tier),
  });
  const initRes = await fetch(deviceCodeEndpoint(oauth), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: initBody.toString(),
  });
  if (!initRes.ok) {
    throw new Error(`Device-code initiation failed: ${await initRes.text()}`);
  }
  const init = (await initRes.json()) as {
    device_code: string;
    user_code: string;
    verification_url?: string;
    verification_uri?: string;
    expires_in: number;
    interval: number;
    message?: string;
  };
  const verificationUrl =
    init.verification_uri ?? init.verification_url ?? "https://microsoft.com/devicelogin";
  const prompt: DeviceCodePrompt = {
    userCode: init.user_code,
    verificationUrl,
    message: init.message ?? `Open ${verificationUrl} and enter code ${init.user_code}`,
    expiresInSeconds: init.expires_in || 900,
  };
  if (onPrompt) onPrompt(prompt);
  else logger.info(`\n${prompt.message}\n`);

  // 2. Poll the token endpoint until the user completes (or it fails/expires).
  const deadline = Date.now() + prompt.expiresInSeconds * 1000;
  let intervalMs = (init.interval || 5) * 1000;
  const grantType = isV1 ? "device_code" : "urn:ietf:params:oauth:grant-type:device_code";

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const pollBody = new URLSearchParams({
      client_id: oauth.clientId,
      grant_type: grantType,
      // v1 names the field `code`; v2 names it `device_code`.
      ...(isV1 ? { code: init.device_code } : { device_code: init.device_code }),
      ...(isV1 ? { resource: TIER_RESOURCES[tier] } : {}),
    });
    const res = await fetch(tokenEndpoint(oauth), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: pollBody.toString(),
    });
    if (res.ok) {
      const raw = (await res.json()) as { access_token: string };
      const data = parseTokenResponse(raw);
      const account = extractEmail(data.access_token) ?? "unknown";
      const token: AccountToken = {
        account,
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? "",
        expiresAt: Date.now() + data.expires_in * 1000,
        tier,
        clientId: oauth.clientId,
        apiVersion: oauth.apiVersion,
      };
      const store = loadTokens();
      store.accounts[account] = token;
      saveTokens(store);
      return token;
    }
    const err = (await res.json()) as { error?: string; error_description?: string };
    if (err.error === "authorization_pending") continue;
    if (err.error === "slow_down") {
      intervalMs += 5000;
      continue;
    }
    // authorization_declined / access_denied / expired_token / bad_verification_code,
    // or a Conditional Access block on the device-code flow.
    const desc = (err.error_description ?? "").split("\n")[0] ?? "";
    // `access_denied` here is usually a tenant Conditional Access policy that
    // disables the device-code flow outright (a common anti-phishing control),
    // not a user who clicked "No". Either way the actionable next step is the
    // webview, so say so instead of leaving the operator with a raw AADSTS code.
    const hint =
      err.error === "access_denied" || err.error === "authorization_declined"
        ? ` If the tenant blocks the device-code flow, sign in with the native window instead: eule-mcp login --capture --tier ${tier}.`
        : "";
    throw new Error(`Device-code login failed: ${err.error ?? "unknown"}. ${desc}${hint}`);
  }
  throw new Error("Device-code login timed out.");
}

/** Extract email (upn) from a JWT access token without verification. */
function extractEmail(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1];
  if (!payload) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    return (decoded.upn ?? decoded.preferred_username ?? decoded.email ?? null) as string | null;
  } catch {
    return null;
  }
}
