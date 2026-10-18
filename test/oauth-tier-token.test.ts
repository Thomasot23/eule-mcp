import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

// In-memory fs so loadTokens/saveTokens operate on a virtual token store.
let files: Record<string, string> = {};
vi.mock("node:fs", () => ({
  existsSync: (p: string) => p in files,
  readFileSync: (p: string) => files[p],
  writeFileSync: (p: string, data: string) => {
    files[p] = data;
  },
  chmodSync: () => {},
  renameSync: (from: string, to: string) => {
    files[to] = files[from] ?? "";
    delete files[from];
  },
  rmSync: (p: string) => {
    delete files[p];
  },
}));

const TOKENS_PATH = join(homedir(), ".eule", "tokens.json");

import {
  getAccessTokenForTier,
  loadTokens,
  InteractionRequiredError,
} from "../src/providers/m365/auth/oauth.js";

const V1 = { clientId: "cid", tenant: "common", apiVersion: "v1" as const };
const V2 = { clientId: "cid", tenant: "common", apiVersion: "v2" as const };

// The tier-token cache lives in the module, so each test uses its own account.
let n = 0;
function account(): string {
  n += 1;
  return `user${String(n)}@x.de`;
}

function seedGraph(name: string, extra: object = {}): void {
  files[TOKENS_PATH] = JSON.stringify({
    accounts: {
      [name]: {
        account: name,
        accessToken: "graph-access",
        refreshToken: "rt0",
        expiresAt: Date.now() + 60 * 60 * 1000,
        tier: "graph",
        clientId: "tb-id",
        apiVersion: "v1",
        ...extra,
      },
    },
  });
}

describe("getAccessTokenForTier", () => {
  beforeEach(() => {
    files = {};
    vi.restoreAllMocks();
  });

  it("returns the account's own token when the tier is the one it signed in with", async () => {
    const name = account();
    seedGraph(name);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await getAccessTokenForTier(name, "graph", V1)).toBe("graph-access");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null for an account without a stored sign-in", async () => {
    expect(await getAccessTokenForTier("nobody@x.de", "imap", V1)).toBeNull();
  });

  it("redeems the refresh token for the other resource with the token's own client", async () => {
    const name = account();
    seedGraph(name);
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: "smtp-access", refresh_token: "rt1", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    // The global config says v2 and another client; the token's own v1 client must win.
    expect(await getAccessTokenForTier(name, "imap", V2)).toBe("smtp-access");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/token");
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("tb-id");
    expect(body.get("refresh_token")).toBe("rt0");
    expect(body.get("resource")).toBe("https://outlook.office.com");
    expect(body.get("scope")).toBeNull();
  });

  it("asks for the SMTP scope on a v2 token", async () => {
    const name = account();
    seedGraph(name, { apiVersion: "v2", clientId: "own-id" });
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: "smtp-access", refresh_token: "rt1", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getAccessTokenForTier(name, "imap", V1);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(new URLSearchParams(init.body).get("scope")).toContain(
      "https://outlook.office.com/SMTP.Send",
    );
  });

  it("keeps the stored token as it was and saves only the rotated refresh token", async () => {
    const name = account();
    seedGraph(name);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ access_token: "smtp-access", refresh_token: "rt1", expires_in: 3600 }),
      ),
    );

    await getAccessTokenForTier(name, "imap", V1);

    const stored = loadTokens().accounts[name];
    expect(stored?.refreshToken).toBe("rt1"); // rotated and saved, or the next refresh fails
    expect(stored?.accessToken).toBe("graph-access"); // the Graph token is not replaced
    expect(stored?.tier).toBe("graph"); // and the account stays a graph account
  });

  it("keeps the old refresh token when none comes back", async () => {
    const name = account();
    seedGraph(name);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "smtp-access", expires_in: 3600 })),
    );

    await getAccessTokenForTier(name, "imap", V1);

    expect(loadTokens().accounts[name]?.refreshToken).toBe("rt0");
  });

  it("serves a second call from memory", async () => {
    const name = account();
    seedGraph(name);
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: "smtp-access", refresh_token: "rt1", expires_in: 3600 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getAccessTokenForTier(name, "imap", V1);
    await getAccessTokenForTier(name, "imap", V1);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks again once the cached token is about to expire", async () => {
    const name = account();
    seedGraph(name);
    const fetchMock = vi.fn(async () =>
      Response.json({ access_token: "short", refresh_token: "rtn", expires_in: 120 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getAccessTokenForTier(name, "imap", V1);
    await getAccessTokenForTier(name, "imap", V1);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets two simultaneous callers share one redemption", async () => {
    const name = account();
    seedGraph(name);
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ access_token: "smtp-access", refresh_token: "rt1", expires_in: 3600 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([
      getAccessTokenForTier(name, "imap", V1),
      getAccessTokenForTier(name, "imap", V1),
    ]);

    expect(a).toBe("smtp-access");
    expect(b).toBe("smtp-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps a dead refresh token to InteractionRequiredError", async () => {
    const name = account();
    seedGraph(name);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: "invalid_grant", error_description: "AADSTS700082 expired" }),
            { status: 400 },
          ),
      ),
    );

    await expect(getAccessTokenForTier(name, "imap", V1)).rejects.toBeInstanceOf(
      InteractionRequiredError,
    );
  });

  it("says what Microsoft said when it refuses the other resource, instead of asking for a new sign-in", async () => {
    const name = account();
    seedGraph(name);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "invalid_resource",
              error_description: "AADSTS65001: consent has not been given",
            }),
            { status: 400 },
          ),
      ),
    );

    const failure = getAccessTokenForTier(name, "imap", V1);
    await expect(failure).rejects.toThrow(/refused to issue a token for the imap tier/);
    await expect(failure).rejects.not.toBeInstanceOf(InteractionRequiredError);
    await expect(failure).rejects.toThrow(/AADSTS65001/);
  });

  it("does not cache a refusal", async () => {
    const name = account();
    seedGraph(name);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 400 }))
      .mockResolvedValueOnce(
        Response.json({ access_token: "second", refresh_token: "rt1", expires_in: 3600 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAccessTokenForTier(name, "imap", V1)).rejects.toThrow();
    expect(await getAccessTokenForTier(name, "imap", V1)).toBe("second");
  });
});
