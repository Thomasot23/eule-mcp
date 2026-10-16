import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANNY_OAUTH_SCOPE,
  AnnyTokenStore,
  annyAuthOrigin,
  annyOAuthTokenSource,
  authenticateAnny,
  discoverAnnyAuthServer,
  parseAnnyTokenResponse,
  refreshAnnyToken,
  registerAnnyClient,
} from "../src/providers/anny/anny-auth.js";
import { type RecordedCall, type Responder, stubFetch } from "./anny-fixtures.js";

let dir: string;
let store: AnnyTokenStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "anny-auth-"));
  store = new AnnyTokenStore(join(dir, "anny-tokens.json"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** anny's RFC 8414 metadata, trimmed to what Eule reads. */
const metadata = (origin = "https://auth.anny.co") => ({
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  registration_endpoint: `${origin}/oauth/register`,
  code_challenge_methods_supported: ["S256"],
});

/** Answer discovery with `metadata()` and everything else through `rest`. */
const withDiscovery =
  (rest: Responder): Responder =>
  (call: RecordedCall) =>
    call.url.pathname === "/.well-known/oauth-authorization-server"
      ? { body: metadata(call.url.origin) }
      : rest(call);

/** Hit the loopback callback the way a browser redirect would. */
const callback = (url: string) =>
  new Promise<number>((resolve, reject) => {
    request(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    })
      .on("error", reject)
      .end();
  });

describe("annyAuthOrigin", () => {
  it("derives the auth host from the API host", () => {
    expect(annyAuthOrigin()).toBe("https://auth.anny.co");
    expect(annyAuthOrigin("https://b.anny.eu")).toBe("https://auth.anny.eu");
    expect(annyAuthOrigin("https://b.staging.anny.co")).toBe("https://auth.staging.anny.co");
    expect(() => annyAuthOrigin("http://b.anny.co")).toThrow(/https/);
  });
});

describe("parseAnnyTokenResponse", () => {
  const now = Date.parse("2026-10-16T10:00:00Z");
  it("prefers the absolute expiry", () => {
    const token = parseAnnyTokenResponse(
      { access_token: "a", refresh_token: "r", expiresIn: 1440, expiresAt: "2026-10-17T10:00:00Z" },
      "client",
      now,
    );
    expect(token).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: Date.parse("2026-10-17T10:00:00Z"),
      clientId: "client",
    });
  });
  it("reads expires_in as seconds and expiresIn as minutes", () => {
    expect(parseAnnyTokenResponse({ access_token: "a", expires_in: 60 }, "c", now).expiresAt).toBe(
      now + 60_000,
    );
    expect(parseAnnyTokenResponse({ access_token: "a", expiresIn: 2 }, "c", now).expiresAt).toBe(
      now + 120_000,
    );
  });
  it("rejects responses without an access token", () => {
    expect(() => parseAnnyTokenResponse({}, "c")).toThrow(/access_token/);
    expect(() => parseAnnyTokenResponse(null, "c")).toThrow();
  });
});

describe("AnnyTokenStore", () => {
  it("stores tokens per key with owner-only permissions", () => {
    const token = { accessToken: "a", expiresAt: 1, clientId: "c" };
    store.set("work/anny", token);
    store.set("personal/anny", { ...token, accessToken: "b" });
    expect(store.get("work/anny")).toEqual(token);
    expect(statSync(join(dir, "anny-tokens.json")).mode & 0o777).toBe(0o600);
    expect(store.remove("work/anny")).toBe(true);
    expect(store.remove("work/anny")).toBe(false);
    expect(store.get("personal/anny")?.accessToken).toBe("b");
  });
});

describe("authenticateAnny", () => {
  it("runs the PKCE authorization-code flow through the loopback redirect", async () => {
    const calls = stubFetch(
      withDiscovery(() => ({
        body: { access_token: "access", refresh_token: "refresh", expires_in: 3600 },
      })),
    );
    let authUrl: URL | undefined;
    const token = await authenticateAnny({
      clientId: "eule-client",
      baseUrl: "https://b.anny.eu",
      port: 18741,
      store,
      openUrl: async (url) => {
        authUrl = new URL(url);
        const state = authUrl.searchParams.get("state") ?? "";
        const redirect = authUrl.searchParams.get("redirect_uri") ?? "";
        // A forged callback with the wrong state is ignored, not accepted.
        await callback(`${redirect}?code=evil&state=wrong`);
        await callback(`${redirect}?code=the-code&state=${state}`);
      },
    });

    expect(authUrl?.origin + (authUrl?.pathname ?? "")).toBe(
      "https://auth.anny.eu/oauth/authorize",
    );
    expect(authUrl?.searchParams.get("client_id")).toBe("eule-client");
    expect(authUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl?.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:18741/callback");
    expect(authUrl?.searchParams.get("scope")).toBe(ANNY_OAUTH_SCOPE);

    // A configured client ID skips registration entirely.
    expect(calls.map((c) => `${c.method} ${c.url.href}`)).toEqual([
      "GET https://auth.anny.eu/.well-known/oauth-authorization-server",
      "POST https://auth.anny.eu/oauth/token",
    ]);
    expect(store.getClient("https://auth.anny.eu")).toBeUndefined();
    expect(calls[1]?.body).toMatchObject({
      grant_type: "authorization_code",
      client_id: "eule-client",
      code: "the-code",
      redirect_uri: "http://127.0.0.1:18741/callback",
    });
    const verifier = (calls[1]?.body as { code_verifier: string }).code_verifier;
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
      authUrl?.searchParams.get("code_challenge"),
    );
    expect(token).toMatchObject({ accessToken: "access", refreshToken: "refresh" });
  });

  it("fails when anny reports an error", async () => {
    stubFetch(withDiscovery(() => ({})));
    await expect(
      authenticateAnny({
        clientId: "c",
        port: 18742,
        store,
        openUrl: async (url) => {
          const u = new URL(url);
          const state = u.searchParams.get("state") ?? "";
          await callback(
            `${u.searchParams.get("redirect_uri") ?? ""}?error=access_denied&state=${state}`,
          );
        },
      }),
    ).rejects.toThrow(/access_denied/);
  });
});

describe("refresh", () => {
  it("refreshes and keeps the old refresh token when none is returned", async () => {
    const calls = stubFetch(
      withDiscovery(() => ({ body: { access_token: "new", expires_in: 3600 } })),
    );
    const refreshed = await refreshAnnyToken(
      { accessToken: "old", refreshToken: "r1", expiresAt: 0, clientId: "c" },
      undefined,
      store,
    );
    // Refresh goes to the discovered token endpoint, as RFC 6749 §6 prescribes.
    expect(calls[1]?.url.href).toBe("https://auth.anny.co/oauth/token");
    expect(calls[1]?.body).toEqual({
      grant_type: "refresh_token",
      client_id: "c",
      refresh_token: "r1",
    });
    expect(refreshed).toMatchObject({ accessToken: "new", refreshToken: "r1" });
  });

  it("token source returns a fresh token, refreshes a stale one and gives up without one", async () => {
    const calls = stubFetch(
      withDiscovery(() => ({ body: { access_token: "renewed", expires_in: 3600 } })),
    );
    store.set("work/fresh", {
      accessToken: "fresh",
      expiresAt: Date.now() + 3_600_000,
      clientId: "c",
    });
    store.set("work/stale", {
      accessToken: "stale",
      refreshToken: "r",
      expiresAt: 0,
      clientId: "c",
    });
    expect(await annyOAuthTokenSource("work/fresh", undefined, store)()).toBe("fresh");
    expect(await annyOAuthTokenSource("work/stale", undefined, store)()).toBe("renewed");
    expect(store.get("work/stale")?.accessToken).toBe("renewed");
    expect(await annyOAuthTokenSource("work/none", undefined, store)()).toBeNull();
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/.well-known/oauth-authorization-server",
      "/oauth/token",
    ]);
  });

  it("token source returns null when the refresh fails", async () => {
    stubFetch(withDiscovery(() => ({ status: 400, body: { error: "invalid_grant" } })));
    store.set("work/x", { accessToken: "x", refreshToken: "r", expiresAt: 0, clientId: "c" });
    expect(await annyOAuthTokenSource("work/x", undefined, store)()).toBeNull();
  });
});

describe("discoverAnnyAuthServer", () => {
  it("reads the endpoints from anny's metadata", async () => {
    const calls = stubFetch(() => ({ body: metadata("https://auth.anny.eu") }));
    expect(await discoverAnnyAuthServer("https://auth.anny.eu")).toEqual({
      authorizationEndpoint: "https://auth.anny.eu/oauth/authorize",
      tokenEndpoint: "https://auth.anny.eu/oauth/token",
      registrationEndpoint: "https://auth.anny.eu/oauth/register",
    });
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.href).toBe("https://auth.anny.eu/.well-known/oauth-authorization-server");
  });

  it("works without a registration endpoint", async () => {
    const { registration_endpoint: _, ...rest } = metadata();
    stubFetch(() => ({ body: rest }));
    expect(
      (await discoverAnnyAuthServer("https://auth.anny.co")).registrationEndpoint,
    ).toBeUndefined();
  });

  it.each([
    [{ issuer: "https://evil.example" }, /issuer/],
    [{ token_endpoint: "https://evil.example/oauth/token" }, /away from/],
    [{ authorization_endpoint: "http://auth.anny.co/oauth/authorize" }, /https/],
    [{ registration_endpoint: "https://evil.example/register" }, /away from/],
    [{ token_endpoint: undefined }, /lacks token_endpoint/],
    [{ code_challenge_methods_supported: ["plain"] }, /S256/],
  ])("rejects metadata %o", async (patch, message) => {
    stubFetch(() => ({ body: { ...metadata(), ...patch } }));
    await expect(discoverAnnyAuthServer("https://auth.anny.co")).rejects.toThrow(message);
  });

  it("reports a failed discovery", async () => {
    stubFetch(() => ({ status: 404, body: "not found" }));
    await expect(discoverAnnyAuthServer("https://auth.anny.co")).rejects.toThrow(/404/);
  });
});

describe("registerAnnyClient", () => {
  it("registers Eule as a public PKCE client for the loopback redirect", async () => {
    const calls = stubFetch(() => ({
      status: 201,
      body: { client_id: "dyn-1", token_endpoint_auth_method: "none" },
    }));
    expect(
      await registerAnnyClient(
        "https://auth.anny.co/oauth/register",
        "http://127.0.0.1:8741/callback",
      ),
    ).toBe("dyn-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.href).toBe("https://auth.anny.co/oauth/register");
    expect(calls[0]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.body).toEqual({
      client_name: "Eule",
      redirect_uris: ["http://127.0.0.1:8741/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "none",
    });
  });

  it.each([
    [{ status: 400, body: { error: "invalid_redirect_uri" } }, /400 .*invalid_redirect_uri/],
    [{ status: 201, body: {} }, /no client_id/],
    [
      { status: 201, body: { client_id: "x", token_endpoint_auth_method: "client_secret_basic" } },
      /confidential client/,
    ],
  ])("rejects registration response %o", async (response, message) => {
    stubFetch(() => response);
    await expect(
      registerAnnyClient("https://auth.anny.co/oauth/register", "http://127.0.0.1:8741/callback"),
    ).rejects.toThrow(message);
  });
});

describe("AnnyTokenStore registered clients", () => {
  it("keeps clients per auth origin next to the tokens", () => {
    const client = {
      clientId: "dyn",
      redirectUri: "http://127.0.0.1:8741/callback",
      registeredAt: 1,
    };
    store.set("work/anny", { accessToken: "a", expiresAt: 1, clientId: "dyn" });
    store.setClient("https://auth.anny.co", client);
    store.setClient("https://auth.anny.eu", { ...client, clientId: "gov" });
    expect(store.getClient("https://auth.anny.co")).toEqual(client);
    expect(store.get("work/anny")?.accessToken).toBe("a");
    expect(statSync(join(dir, "anny-tokens.json")).mode & 0o777).toBe(0o600);
    // Only the client that was rejected is dropped, never a newer registration.
    expect(store.removeClient("https://auth.anny.co", "older")).toBe(false);
    expect(store.removeClient("https://auth.anny.co", "dyn")).toBe(true);
    expect(store.getClient("https://auth.anny.co")).toBeUndefined();
    expect(store.getClient("https://auth.anny.eu")?.clientId).toBe("gov");
    expect(() => store.get("clients")).toThrow(/not an anny token key/);
  });
});

describe("authenticateAnny without a configured client ID", () => {
  /** Complete the browser leg with the code anny would return. */
  const approve = async (url: string) => {
    const u = new URL(url);
    await callback(
      `${u.searchParams.get("redirect_uri") ?? ""}?code=c&state=${u.searchParams.get("state") ?? ""}`,
    );
  };
  const tokenBody = { access_token: "access", refresh_token: "refresh", expires_in: 3600 };

  it("registers once per auth origin and reuses the cached client", async () => {
    let registered = 0;
    const authorizedAs: (string | null)[] = [];
    const calls = stubFetch(
      withDiscovery((call) => {
        if (call.url.pathname === "/oauth/register") {
          registered += 1;
          return { status: 201, body: { client_id: `dyn-${String(registered)}` } };
        }
        return { body: tokenBody };
      }),
    );
    const login = () =>
      authenticateAnny({
        port: 18743,
        store,
        openUrl: async (url) => {
          authorizedAs.push(new URL(url).searchParams.get("client_id"));
          await approve(url);
        },
      });

    const first = await login();
    const second = await login();

    expect(registered).toBe(1);
    expect(authorizedAs).toEqual(["dyn-1", "dyn-1"]);
    expect(first.clientId).toBe("dyn-1");
    expect(second.clientId).toBe("dyn-1");
    expect(store.getClient("https://auth.anny.co")).toMatchObject({
      clientId: "dyn-1",
      redirectUri: "http://127.0.0.1:18743/callback",
    });
    const registration = calls.find((c) => c.url.pathname === "/oauth/register");
    expect(registration?.body).toMatchObject({
      redirect_uris: ["http://127.0.0.1:18743/callback"],
    });
    expect(calls.filter((c) => c.url.pathname === "/oauth/token")[0]?.body).toMatchObject({
      client_id: "dyn-1",
    });
  });

  it("registers anew when the cached client has another redirect URI", async () => {
    store.setClient("https://auth.anny.co", {
      clientId: "old",
      redirectUri: "http://127.0.0.1:9999/callback",
      registeredAt: 1,
    });
    stubFetch(
      withDiscovery((call) =>
        call.url.pathname === "/oauth/register"
          ? { status: 201, body: { client_id: "new" } }
          : { body: tokenBody },
      ),
    );
    const token = await authenticateAnny({ port: 18744, store, openUrl: approve });
    expect(token.clientId).toBe("new");
    expect(store.getClient("https://auth.anny.co")?.clientId).toBe("new");
  });

  it("forgets a client anny rejects so the next sign-in registers again", async () => {
    store.setClient("https://auth.anny.co", {
      clientId: "revoked",
      redirectUri: "http://127.0.0.1:18745/callback",
      registeredAt: 1,
    });
    stubFetch(withDiscovery(() => ({ status: 401, body: { error: "invalid_client" } })));
    await expect(authenticateAnny({ port: 18745, store, openUrl: approve })).rejects.toThrow(
      /run booking_login again to register a new one/,
    );
    expect(store.getClient("https://auth.anny.co")).toBeUndefined();
  });

  it("keeps a configured client ID even when anny rejects it", async () => {
    store.setClient("https://auth.anny.co", {
      clientId: "cached",
      redirectUri: "http://127.0.0.1:18746/callback",
      registeredAt: 1,
    });
    stubFetch(withDiscovery(() => ({ status: 401, body: { error: "invalid_client" } })));
    const error: unknown = await authenticateAnny({
      clientId: "issued",
      port: 18746,
      store,
      openUrl: approve,
    }).catch((e: unknown) => e);
    expect(String(error)).not.toMatch(/register a new one/);
    expect(store.getClient("https://auth.anny.co")?.clientId).toBe("cached");
  });

  it("drops the client only on anny's own error redirect", async () => {
    const cached = {
      clientId: "dyn",
      redirectUri: "http://127.0.0.1:18747/callback",
      registeredAt: 1,
    };
    store.setClient("https://auth.anny.co", cached);
    stubFetch(withDiscovery(() => ({})));
    const failWith = (state: (u: URL) => string) =>
      authenticateAnny({
        port: 18747,
        store,
        openUrl: async (url) => {
          const u = new URL(url);
          await callback(
            `${u.searchParams.get("redirect_uri") ?? ""}?error=invalid_client&state=${state(u)}`,
          );
        },
      });

    await expect(failWith(() => "forged")).rejects.toThrow(/invalid_client/);
    expect(store.getClient("https://auth.anny.co")).toEqual(cached);
    await expect(failWith((u) => u.searchParams.get("state") ?? "")).rejects.toThrow(
      /register a new one/,
    );
    expect(store.getClient("https://auth.anny.co")).toBeUndefined();
  });

  it("explains a server without client registration", async () => {
    const { registration_endpoint: _, ...rest } = metadata();
    stubFetch(() => ({ body: rest }));
    await expect(authenticateAnny({ port: 18748, store, openUrl: approve })).rejects.toThrow(
      /set "clientId"/,
    );
  });

  it("refresh forgets a registered client anny no longer accepts", async () => {
    store.setClient("https://auth.anny.co", {
      clientId: "dyn",
      redirectUri: "http://127.0.0.1:8741/callback",
      registeredAt: 1,
    });
    stubFetch(withDiscovery(() => ({ status: 401, body: { error: "invalid_client" } })));
    await expect(
      refreshAnnyToken(
        { accessToken: "a", refreshToken: "r", expiresAt: 0, clientId: "dyn" },
        undefined,
        store,
      ),
    ).rejects.toThrow(/401/);
    expect(store.getClient("https://auth.anny.co")).toBeUndefined();
  });
});
