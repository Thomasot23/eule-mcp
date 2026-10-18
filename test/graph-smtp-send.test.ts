import { describe, it, expect, vi, afterEach } from "vitest";
import { GraphMailConnector } from "../src/providers/m365/graph-mail.js";
import type { RawMailSubmitter } from "../src/types/index.js";

const MIME = Buffer.from(
  "From: me@lexict.de\r\nTo: to@x.de\r\nCc: cc@x.de\r\nBcc: secret@x.de\r\nSubject: Hi\r\n\r\nBody\r\n",
  "latin1",
);

interface Recorded {
  url: string;
  method: string;
}

interface Routes {
  meta?: object;
  mime?: Buffer;
  deleteStatus?: number;
  metaStatus?: number;
  mimeStatus?: number;
}

/** Stubs the Graph calls a draft send makes, and records every request. */
function mockGraph(routes: Routes = {}): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      if (url.endsWith("/$value"))
        return Promise.resolve(
          new Response(routes.mime ?? MIME, { status: routes.mimeStatus ?? 200 }),
        );
      if (url.includes("?$select=from,sender,toRecipients"))
        return Promise.resolve(
          new Response(
            JSON.stringify(
              routes.meta ?? {
                from: { emailAddress: { address: "me@lexict.de" } },
                toRecipients: [{ emailAddress: { address: "to@x.de" } }],
                ccRecipients: [{ emailAddress: { address: "cc@x.de" } }],
                bccRecipients: [{ emailAddress: { address: "secret@x.de" } }],
              },
            ),
            { status: routes.metaStatus ?? 200 },
          ),
        );
      if (method === "DELETE")
        return Promise.resolve(new Response(null, { status: routes.deleteStatus ?? 204 }));
      if (url.endsWith("/messages") && method === "POST")
        return Promise.resolve(new Response(JSON.stringify({ id: "draft1" }), { status: 201 }));
      if (url.endsWith("/createReply") && method === "POST")
        return Promise.resolve(
          new Response(JSON.stringify({ id: "reply1", body: { content: "<p>orig</p>" } }), {
            status: 201,
          }),
        );
      if (method === "PATCH") return Promise.resolve(new Response("{}", { status: 200 }));
      return Promise.resolve(new Response("unexpected", { status: 500 }));
    }),
  );
  return calls;
}

function submitter(failWith?: Error): {
  submitter: RawMailSubmitter;
  submitted: { raw: Buffer; envelope?: { from: string; to: readonly string[] } }[];
} {
  const submitted: { raw: Buffer; envelope?: { from: string; to: readonly string[] } }[] = [];
  return {
    submitted,
    submitter: {
      submitRaw: (raw, envelope) => {
        if (failWith) return Promise.reject(failWith);
        submitted.push({ raw, envelope });
        return Promise.resolve();
      },
    },
  };
}

const token = () => Promise.resolve("graph-token");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GraphMailConnector sending over SMTP", () => {
  it("submits the draft's MIME with every recipient in the envelope and no Bcc header", async () => {
    mockGraph();
    const s = submitter();
    const connector = new GraphMailConnector("me@lexict.de", token, false, s.submitter);

    const receipt = await connector.sendDraft("draft1");

    expect(receipt).toEqual({});
    expect(s.submitted).toHaveLength(1);
    expect(s.submitted[0]?.envelope).toEqual({
      from: "me@lexict.de",
      to: ["to@x.de", "cc@x.de", "secret@x.de"],
    });
    const header = s.submitted[0]?.raw.toString("latin1") ?? "";
    expect(header).toContain("To: to@x.de");
    expect(header).not.toMatch(/^bcc:/im);
  });

  it("never calls Graph's own send action, which needs Mail.Send", async () => {
    const calls = mockGraph();
    const connector = new GraphMailConnector("me@lexict.de", token, false, submitter().submitter);

    await connector.sendDraft("draft1");

    expect(calls.some((c) => /\/send$|\/sendMail$/.test(c.url))).toBe(false);
  });

  it("removes the draft after delivery", async () => {
    const calls = mockGraph();
    const connector = new GraphMailConnector("me@lexict.de", token, false, submitter().submitter);

    await connector.sendDraft("draft1");

    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      "https://graph.microsoft.com/v1.0/me/messages/draft1",
    ]);
  });

  it("reports a draft that could not be removed as a warning, not as a failed send", async () => {
    mockGraph({ deleteStatus: 500 });
    const connector = new GraphMailConnector("me@lexict.de", token, false, submitter().submitter);

    const receipt = await connector.sendDraft("draft1");

    expect(receipt.warning).toMatch(/Sent, but the draft could not be removed/);
  });

  it("keeps the draft when the submission fails", async () => {
    const calls = mockGraph();
    const connector = new GraphMailConnector(
      "me@lexict.de",
      token,
      false,
      submitter(new Error("SMTP auth refused")).submitter,
    );

    await expect(connector.sendDraft("draft1")).rejects.toThrow("SMTP auth refused");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("refuses a draft without recipients instead of submitting it", async () => {
    mockGraph({ meta: { from: { emailAddress: { address: "me@lexict.de" } } } });
    const s = submitter();
    const connector = new GraphMailConnector("me@lexict.de", token, false, s.submitter);

    await expect(connector.sendDraft("draft1")).rejects.toThrow(/no recipients/);
    expect(s.submitted).toHaveLength(0);
  });

  it("takes the sender from the mailbox when the draft names none", async () => {
    mockGraph({ meta: { toRecipients: [{ emailAddress: { address: "to@x.de" } }] } });
    const s = submitter();
    const connector = new GraphMailConnector("me@lexict.de", token, false, s.submitter);

    await connector.sendDraft("draft1");

    expect(s.submitted[0]?.envelope?.from).toBe("me@lexict.de");
  });

  it("fails clearly when the draft cannot be read", async () => {
    mockGraph({ metaStatus: 404 });
    const connector = new GraphMailConnector("me@lexict.de", token, false, submitter().submitter);

    await expect(connector.sendDraft("gone")).rejects.toThrow(/Graph readDraft: 404/);
  });

  it("sends a new message by saving it as a draft first", async () => {
    const calls = mockGraph();
    const s = submitter();
    const connector = new GraphMailConnector("me@lexict.de", token, false, s.submitter);

    await connector.sendMessage(["to@x.de"], "Hi", "Body");

    expect(calls.some((c) => c.url.endsWith("/sendMail"))).toBe(false);
    expect(calls.some((c) => c.url.endsWith("/messages") && c.method === "POST")).toBe(true);
    expect(s.submitted).toHaveLength(1);
  });

  it("sends a reply through the same path", async () => {
    const calls = mockGraph();
    const s = submitter();
    const connector = new GraphMailConnector("me@lexict.de", token, false, s.submitter);

    await connector.replyToMessage("orig1", "Thanks");

    expect(calls.some((c) => /\/send$/.test(c.url))).toBe(false);
    expect(s.submitted).toHaveLength(1);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/messages/reply1"))).toBe(
      true,
    );
  });
});

describe("GraphMailConnector without a submitter", () => {
  it("still sends a draft with Graph's own action", async () => {
    const calls: Recorded[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        calls.push({ url: String(input), method: init?.method ?? "GET" });
        return Promise.resolve(new Response(null, { status: 202 }));
      }),
    );
    const connector = new GraphMailConnector("me@lexict.de", token);

    await connector.sendDraft("draft1");

    expect(calls).toEqual([
      { url: "https://graph.microsoft.com/v1.0/me/messages/draft1/send", method: "POST" },
    ]);
  });
});
