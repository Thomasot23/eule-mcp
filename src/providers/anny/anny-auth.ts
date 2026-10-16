import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import open from "open";
import { currentExecutionSignal } from "../../utils/execution-context.js";
import { logger } from "../../utils/logger.js";
import { assertSecureUrl, fetchWithTimeout } from "../../utils/security.js";
import { ANNY_DEFAULT_URL } from "./anny-connector.js";

/**
 * Fixed loopback redirect for anny's OAuth client. anny registers redirect
 * URIs per client, so this exact value is on the client Eule registers (or,
 * with a `clientId` override, must be on the client anny issued).
 */
export const ANNY_REDIRECT_PORT = 8741;
export const ANNY_REDIRECT_URI = `http://127.0.0.1:${String(ANNY_REDIRECT_PORT)}/callback`;

/** Refresh this long before expiry so a request never starts with a dying token. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Name anny shows on its consent page for the client Eule registers. */
export const ANNY_CLIENT_NAME = "Eule";

/**
 * Scope requested at sign-in. anny's per-resource scopes (`b.bookings:*`,
 * `b.resources:read`, …) do not map onto Eule's tools: `booking_api_get` reads
 * any allowlisted endpoint and a confirmed raw change can address any route.
 * Eule therefore asks for everything anny advertises (`*`) and enforces its
 * own limits instead — role permissions, the read allowlist and confirmed
 * change plans. The token never carries more than the user's own anny
 * account allows, and anny's consent page shows what is granted.
 */
export const ANNY_OAUTH_SCOPE = "*";

/** Token-store keys are `role/connectorId`; this key (no slash) holds registered clients. */
const CLIENTS_KEY = "clients";

export interface AnnyStoredToken {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresAt: number;
  readonly clientId: string;
}

/** OAuth client Eule registered at one anny auth server (RFC 7591). */
export interface AnnyRegisteredClient {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly registeredAt: number;
}

/**
 * anny OAuth tokens, kept apart from tokens.json: those are keyed by account
 * e-mail, and an anny SSO login with the same university address would
 * otherwise overwrite the Microsoft 365 token. Keys are `role/connectorId`.
 * The same file caches the client Eule registered per anny auth origin.
 */
export class AnnyTokenStore {
  constructor(private readonly path = join(homedir(), ".eule", "anny-tokens.json")) {}

  private loadAll(): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
        throw new Error("not an object");
      return parsed as Record<string, unknown>;
    } catch (error) {
      logger.error(
        `anny token store is invalid; starting empty (${error instanceof Error ? error.message : "unknown error"})`,
      );
      return {};
    }
  }

  private saveAll(tokens: Record<string, unknown>): void {
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }

  private static assertTokenKey(key: string): void {
    if (key === CLIENTS_KEY) throw new Error(`"${CLIENTS_KEY}" is not an anny token key`);
  }

  get(key: string): AnnyStoredToken | undefined {
    AnnyTokenStore.assertTokenKey(key);
    return this.loadAll()[key] as AnnyStoredToken | undefined;
  }

  set(key: string, token: AnnyStoredToken): void {
    AnnyTokenStore.assertTokenKey(key);
    // Re-read right before the write so concurrent logins for other keys survive.
    this.saveAll({ ...this.loadAll(), [key]: token });
  }

  remove(key: string): boolean {
    AnnyTokenStore.assertTokenKey(key);
    const all = this.loadAll();
    if (!(key in all)) return false;
    this.saveAll(Object.fromEntries(Object.entries(all).filter(([k]) => k !== key)));
    return true;
  }

  private clients(all = this.loadAll()): Record<string, AnnyRegisteredClient> {
    const clients = all[CLIENTS_KEY];
    return typeof clients === "object" && clients !== null && !Array.isArray(clients)
      ? (clients as Record<string, AnnyRegisteredClient>)
      : {};
  }

  /** Client Eule registered at the anny auth server `origin`, if any. */
  getClient(origin: string): AnnyRegisteredClient | undefined {
    return this.clients()[origin];
  }

  setClient(origin: string, client: AnnyRegisteredClient): void {
    const all = this.loadAll();
    this.saveAll({ ...all, [CLIENTS_KEY]: { ...this.clients(all), [origin]: client } });
  }

  /** Forget a registered client, but only if it is still `clientId` (a newer one stays). */
  removeClient(origin: string, clientId: string): boolean {
    const all = this.loadAll();
    const clients = this.clients(all);
    if (clients[origin]?.clientId !== clientId) return false;
    this.saveAll({
      ...all,
      [CLIENTS_KEY]: Object.fromEntries(Object.entries(clients).filter(([o]) => o !== origin)),
    });
    return true;
  }
}

export const annyTokenStore = new AnnyTokenStore();

/** anny's auth service sits next to the API host: b.anny.co → auth.anny.co. */
export function annyAuthOrigin(baseUrl = ANNY_DEFAULT_URL): string {
  const url = new URL(assertSecureUrl(baseUrl, "anny URL"));
  const host = url.hostname.startsWith("b.") ? `auth.${url.hostname.slice(2)}` : "auth.anny.co";
  return `https://${host}`;
}

/** The endpoints Eule uses from anny's OAuth server metadata (RFC 8414). */
export interface AnnyAuthServerMetadata {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint?: string;
}

/** An endpoint from the metadata, held to the auth origin so codes and tokens never leave it. */
function sameOriginEndpoint(origin: string, value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`anny OAuth metadata lacks ${name}`);
  const url = new URL(assertSecureUrl(value, `anny ${name}`));
  if (url.origin !== origin)
    throw new Error(`anny OAuth metadata points ${name} away from ${origin}: ${url.origin}`);
  return url.href;
}

/** Read anny's OAuth authorization server metadata from `origin`. */
export async function discoverAnnyAuthServer(origin: string): Promise<AnnyAuthServerMetadata> {
  const res = await fetchWithTimeout(`${origin}/.well-known/oauth-authorization-server`, {
    headers: { Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`anny OAuth discovery failed: ${String(res.status)} ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as Record<string, unknown>;
  if (data.issuer !== origin)
    throw new Error(
      `anny OAuth metadata names issuer ${JSON.stringify(data.issuer)}, expected ${origin}`,
    );
  const methods = data.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256"))
    throw new Error("anny OAuth server does not support PKCE with S256");
  return {
    authorizationEndpoint: sameOriginEndpoint(
      origin,
      data.authorization_endpoint,
      "authorization_endpoint",
    ),
    tokenEndpoint: sameOriginEndpoint(origin, data.token_endpoint, "token_endpoint"),
    ...(data.registration_endpoint !== undefined
      ? {
          registrationEndpoint: sameOriginEndpoint(
            origin,
            data.registration_endpoint,
            "registration_endpoint",
          ),
        }
      : {}),
  };
}

/**
 * Register Eule as a public client (PKCE, no secret) at anny's registration
 * endpoint (RFC 7591) and return the issued client ID.
 */
export async function registerAnnyClient(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetchWithTimeout(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_name: ANNY_CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`anny client registration failed: ${String(res.status)} ${text.slice(0, 300)}`);
  const data = JSON.parse(text) as Record<string, unknown>;
  if (typeof data.client_id !== "string" || data.client_id.length === 0)
    throw new Error("anny client registration returned no client_id");
  // Eule keeps no client secret; a confidential client could not use the token endpoint.
  const method = data.token_endpoint_auth_method;
  if (method !== undefined && method !== "none")
    throw new Error(
      `anny registered a confidential client (${JSON.stringify(method)}); Eule needs "none"`,
    );
  return data.client_id;
}

/** The client registered for `origin` and `redirectUri`, registering one if none is cached. */
async function registeredClientId(
  origin: string,
  metadata: AnnyAuthServerMetadata,
  redirectUri: string,
  store: AnnyTokenStore,
): Promise<string> {
  const cached = store.getClient(origin);
  if (cached?.redirectUri === redirectUri) return cached.clientId;
  if (!metadata.registrationEndpoint)
    throw new Error(
      `anny at ${origin} offers no client registration; set "clientId" on the anny-oauth connector`,
    );
  const clientId = await registerAnnyClient(metadata.registrationEndpoint, redirectUri);
  store.setClient(origin, { clientId, redirectUri, registeredAt: Date.now() });
  logger.info(`Registered Eule as OAuth client ${clientId} at ${origin}`);
  return clientId;
}

/**
 * Normalize anny's token response. The documented sample carries `expiresAt`
 * (ISO) and `expiresIn` (1440, read as minutes); standard OAuth servers send
 * `expires_in` in seconds. Prefer the absolute time when present.
 */
export function parseAnnyTokenResponse(
  raw: unknown,
  clientId: string,
  now = Date.now(),
): AnnyStoredToken {
  if (typeof raw !== "object" || raw === null) throw new Error("Malformed anny token response");
  const data = raw as Record<string, unknown>;
  if (typeof data.access_token !== "string" || data.access_token.length === 0)
    throw new Error("anny token response missing access_token");
  const absolute = typeof data.expiresAt === "string" ? Date.parse(data.expiresAt) : NaN;
  const expiresAt = Number.isFinite(absolute)
    ? absolute
    : typeof data.expires_in === "number"
      ? now + data.expires_in * 1000
      : typeof data.expiresIn === "number"
        ? now + data.expiresIn * 60 * 1000
        : now + 60 * 60 * 1000;
  return {
    accessToken: data.access_token,
    ...(typeof data.refresh_token === "string" ? { refreshToken: data.refresh_token } : {}),
    expiresAt,
    clientId,
  };
}

/** A refused token request; `clientRejected` marks an unknown or revoked client. */
export class AnnyTokenError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly clientRejected: boolean,
  ) {
    super(message);
    this.name = "AnnyTokenError";
  }
}

/** OAuth error codes that mean the client itself is unknown or not allowed. */
const CLIENT_ERRORS = new Set(["invalid_client", "unauthorized_client"]);

function oauthErrorCode(text: string): string | undefined {
  try {
    const data = JSON.parse(text) as { error?: unknown };
    return typeof data.error === "string" ? data.error : undefined;
  } catch {
    return undefined;
  }
}

async function postToken(url: string, body: Record<string, string>): Promise<unknown> {
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = oauthErrorCode(text);
    throw new AnnyTokenError(
      `anny token request failed: ${String(res.status)} ${text.slice(0, 300)}`,
      res.status,
      code !== undefined ? CLIENT_ERRORS.has(code) : res.status === 401,
    );
  }
  return JSON.parse(text) as unknown;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface AnnyLoginOptions {
  /** Client ID anny issued; without it Eule registers (and caches) its own client. */
  readonly clientId?: string;
  readonly baseUrl?: string;
  /** Opens the authorization URL; the default launches the system browser. */
  readonly openUrl?: (url: string) => Promise<unknown>;
  readonly port?: number;
  /** Where a registered client is cached; defaults to ~/.eule/anny-tokens.json. */
  readonly store?: AnnyTokenStore;
}

/**
 * Authorization Code flow with PKCE (public client, no secret). The user signs
 * in on anny's own page, which hands over to the organization's SSO as usual,
 * so the identity provider needs no change. Without a configured client ID,
 * Eule registers itself at anny once per auth origin (RFC 7591) and reuses
 * that client; a client anny rejects is forgotten and registered anew on the
 * next sign-in.
 */
export async function authenticateAnny(options: AnnyLoginOptions): Promise<AnnyStoredToken> {
  const origin = annyAuthOrigin(options.baseUrl);
  const store = options.store ?? annyTokenStore;
  const port = options.port ?? ANNY_REDIRECT_PORT;
  const redirectUri = `http://127.0.0.1:${String(port)}/callback`;
  const metadata = await discoverAnnyAuthServer(origin);
  const clientId =
    options.clientId ?? (await registeredClientId(origin, metadata, redirectUri, store));
  /** Drop a registered client anny refused, so the next sign-in registers a new one. */
  const forgetRejected = (reason: string): string => {
    if (options.clientId !== undefined || !store.removeClient(origin, clientId)) return reason;
    return `${reason} (anny no longer accepts client ${clientId}; run booking_login again to register a new one)`;
  };
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  const authUrl = `${metadata.authorizationEndpoint}?${new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
    scope: ANNY_OAUTH_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString()}`;

  const code = await new Promise<string>((resolve, reject) => {
    const signal = currentExecutionSignal();
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const returned = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (url.searchParams.get("state") !== state || !returned) {
        res.end("<h1>❌ anny sign-in failed</h1><p>You can close this tab.</p>");
        if (error) {
          done();
          const reason = `anny sign-in failed: ${error}`;
          // Only anny's own redirect (matching state) may drop the cached client.
          const fromAnny = url.searchParams.get("state") === state;
          reject(new Error(fromAnny && CLIENT_ERRORS.has(error) ? forgetRejected(reason) : reason));
        }
        return;
      }
      res.end("<h1>✅ Signed in to anny</h1><p>You can close this tab.</p>");
      done();
      resolve(returned);
    });
    const abort = (): void => {
      done();
      reject(new Error("anny sign-in cancelled"));
    };
    function done(): void {
      signal?.removeEventListener("abort", abort);
      server.close();
    }
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    server.on("error", (err) => {
      signal?.removeEventListener("abort", abort);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
    server.listen(port, "127.0.0.1", () => {
      logger.info(`Open this URL to sign in to anny:\n${authUrl}`);
      void (options.openUrl ?? open)(authUrl);
    });
  });

  let response: unknown;
  try {
    response = await postToken(metadata.tokenEndpoint, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
  } catch (error) {
    if (error instanceof AnnyTokenError && error.clientRejected)
      throw new AnnyTokenError(forgetRejected(error.message), error.status, true);
    throw error;
  }
  return parseAnnyTokenResponse(response, clientId);
}

export async function refreshAnnyToken(
  token: AnnyStoredToken,
  baseUrl?: string,
  store: AnnyTokenStore = annyTokenStore,
): Promise<AnnyStoredToken> {
  if (!token.refreshToken)
    throw new Error("anny session expired; sign in again with booking_login");
  const origin = annyAuthOrigin(baseUrl);
  const { tokenEndpoint } = await discoverAnnyAuthServer(origin);
  let response: unknown;
  try {
    response = await postToken(tokenEndpoint, {
      grant_type: "refresh_token",
      client_id: token.clientId,
      refresh_token: token.refreshToken,
    });
  } catch (error) {
    // A revoked registered client must not be reused by the next sign-in.
    if (error instanceof AnnyTokenError && error.clientRejected)
      store.removeClient(origin, token.clientId);
    throw error;
  }
  const refreshed = parseAnnyTokenResponse(response, token.clientId);
  // Servers that do not rotate refresh tokens omit them on refresh.
  return refreshed.refreshToken ? refreshed : { ...refreshed, refreshToken: token.refreshToken };
}

/** Token source for an "anny-oauth" connector: stored token, refreshed when due. */
export function annyOAuthTokenSource(
  key: string,
  baseUrl: string | undefined,
  store: AnnyTokenStore = annyTokenStore,
): () => Promise<string | null> {
  let pending: Promise<string | null> | undefined;
  return () => {
    pending ??= (async () => {
      const token = store.get(key);
      if (!token) return null;
      if (token.expiresAt - Date.now() > REFRESH_MARGIN_MS) return token.accessToken;
      try {
        const refreshed = await refreshAnnyToken(token, baseUrl, store);
        store.set(key, refreshed);
        return refreshed.accessToken;
      } catch (error) {
        logger.warn(
          `anny token refresh failed for ${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
