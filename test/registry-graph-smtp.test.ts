import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

// The token store is virtual; every other path (package.json, ...) is the real file.
const store = vi.hoisted(() => ({ files: {} as Record<string, string> }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const isVirtual = (p: unknown): p is string => typeof p === "string" && p in store.files;
  const isTokenPath = (p: unknown): p is string =>
    typeof p === "string" && p.includes(".eule/tokens.json");
  const api = {
    ...real,
    existsSync: (p: Parameters<typeof real.existsSync>[0]) =>
      isVirtual(p) ? true : real.existsSync(p),
    readFileSync: ((p: Parameters<typeof real.readFileSync>[0], ...rest: unknown[]) =>
      isVirtual(p)
        ? store.files[p]
        : (real.readFileSync as (...a: unknown[]) => unknown)(
            p,
            ...rest,
          )) as typeof real.readFileSync,
    writeFileSync: ((p: Parameters<typeof real.writeFileSync>[0], data: string) => {
      if (isTokenPath(p)) store.files[p] = data;
      else (real.writeFileSync as (...a: unknown[]) => unknown)(p, data);
    }) as typeof real.writeFileSync,
    chmodSync: ((p: Parameters<typeof real.chmodSync>[0], mode: never) => {
      if (!isTokenPath(p)) real.chmodSync(p, mode);
    }) as typeof real.chmodSync,
    renameSync: ((from: string, to: string) => {
      if (isTokenPath(to)) {
        store.files[to] = store.files[from] ?? "";
        delete store.files[from];
      } else real.renameSync(from, to);
    }) as typeof real.renameSync,
    rmSync: ((p: string, options?: never) => {
      if (isVirtual(p)) delete store.files[p];
      else real.rmSync(p, options);
    }) as typeof real.rmSync,
  };
  return { ...api, default: api };
});

// Capture what the SMTP transport is built with and what it is asked to send.
const transports: { options: Record<string, unknown>; sent: Record<string, unknown>[] }[] = [];
vi.mock("nodemailer", async (importOriginal) => {
  const original = await importOriginal<typeof import("nodemailer")>();
  return {
    ...original,
    createTransport: (options: Record<string, unknown>) => {
      const record = { options, sent: [] as Record<string, unknown>[] };
      transports.push(record);
      return {
        sendMail: (message: Record<string, unknown>) => {
          record.sent.push(message);
          return Promise.resolve({});
        },
        close: () => {},
      };
    },
  };
});

import { ConnectorRegistry } from "../src/connectors/registry.js";
import type { AppConfig } from "../src/types/index.js";

const TOKENS_PATH = join(homedir(), ".eule", "tokens.json");
const ACCOUNT = "me@lexict.de";

const config = {
  oauth: { clientId: "tb-id", tenant: "common", apiVersion: "v1" },
  roles: [{ id: "lexict", connectors: { mail: [{ type: "m365", account: ACCOUNT }] } }],
} as unknown as AppConfig;

const MIME = Buffer.from(
  "From: me@lexict.de\r\nTo: to@x.de\r\nBcc: secret@x.de\r\nSubject: Hi\r\n\r\nBody\r\n",
  "latin1",
);

describe("a Graph-tier account sends the way Thunderbird does", () => {
  beforeEach(() => {
    store.files = {};
    transports.length = 0;
    store.files[TOKENS_PATH] = JSON.stringify({
      accounts: {
        [ACCOUNT]: {
          account: ACCOUNT,
          accessToken: "graph-access",
          refreshToken: "rt0",
          expiresAt: Date.now() + 60 * 60 * 1000,
          tier: "graph",
          clientId: "tb-id",
          apiVersion: "v1",
        },
      },
    });
  });

  it("submits over smtp.office365.com with an Exchange Online token, not the Graph token", async () => {
    const urls: string[] = [];
    let tokenRequest: URLSearchParams | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const url = String(input);
        urls.push(url);
        if (url.startsWith("https://login.microsoftonline.com/")) {
          tokenRequest = new URLSearchParams(String(init?.body));
          return Promise.resolve(
            Response.json({ access_token: "smtp-access", refresh_token: "rt1", expires_in: 3600 }),
          );
        }
        if (url.endsWith("/$value")) return Promise.resolve(new Response(MIME));
        if (url.includes("?$select=from,sender,toRecipients"))
          return Promise.resolve(
            Response.json({
              from: { emailAddress: { address: ACCOUNT } },
              toRecipients: [{ emailAddress: { address: "to@x.de" } }],
              bccRecipients: [{ emailAddress: { address: "secret@x.de" } }],
            }),
          );
        if ((init?.method ?? "GET") === "DELETE")
          return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(new Response("unexpected", { status: 500 }));
      }),
    );

    const registry = new ConnectorRegistry({ get: () => config } as never, {} as never);
    const [connector] = registry.getMailConnectors("lexict", "write");
    expect(connector?.tier).toBe("graph");

    await connector?.sendDraft?.("draft1");

    // The token for SMTP is minted for the Exchange Online resource, from the sign-in.
    expect(tokenRequest?.get("resource")).toBe("https://outlook.office.com");
    expect(tokenRequest?.get("refresh_token")).toBe("rt0");

    expect(transports).toHaveLength(1);
    expect(transports[0]?.options).toMatchObject({
      host: "smtp.office365.com",
      port: 587,
      requireTLS: true,
      auth: { type: "OAuth2", user: ACCOUNT, accessToken: "smtp-access" },
    });
    expect(transports[0]?.sent).toHaveLength(1);
    expect(transports[0]?.sent[0]?.envelope).toEqual({
      from: ACCOUNT,
      to: ["to@x.de", "secret@x.de"],
    });
    expect((transports[0]?.sent[0]?.raw as Buffer).toString("latin1")).not.toMatch(/^bcc:/im);

    // Graph's own send action is never used.
    expect(urls.some((u) => /\/send$|\/sendMail$/.test(u))).toBe(false);
  });
});
