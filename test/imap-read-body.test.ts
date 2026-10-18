import { describe, expect, it, vi } from "vitest";
import { ImapMailConnector, pickBodyPart } from "../src/providers/imap/imap-mail.js";

function connectorWith(client: unknown): ImapMailConnector {
  const connector = new ImapMailConnector("user@example.com", {
    account: "user@example.com",
    host: "imap.example.com",
    smtpHost: "smtp.example.com",
    auth: "password",
    password: "test",
  });
  Object.defineProperty(connector, "connect", { value: vi.fn(async () => client) });
  return connector;
}

const ALTERNATIVE = {
  type: "multipart/mixed",
  childNodes: [
    {
      part: "1",
      type: "multipart/alternative",
      childNodes: [
        { part: "1.1", type: "text/plain", parameters: { charset: "windows-1252" } },
        { part: "1.2", type: "text/html", parameters: { charset: "utf-8" } },
      ],
    },
    {
      part: "2",
      type: "application/pdf",
      disposition: "attachment",
      dispositionParameters: { filename: "Rechnung.pdf" },
    },
  ],
};

describe("pickBodyPart", () => {
  it("prefers the HTML alternative over plain text", () => {
    expect(pickBodyPart(ALTERNATIVE)).toEqual({ part: "1.2", bodyType: "html" });
  });

  it("falls back to plain text and calls a single-part body part 1", () => {
    expect(pickBodyPart({ type: "text/plain" })).toEqual({ part: "1", bodyType: "text" });
  });

  it("never picks an attachment, even a text one", () => {
    expect(
      pickBodyPart({
        type: "multipart/mixed",
        childNodes: [
          { part: "1", type: "text/plain", disposition: "attachment" },
          { part: "2", type: "text/html", parameters: { name: "page.html" } },
        ],
      }),
    ).toBeUndefined();
  });

  it("reads the outer body rather than a forwarded message's", () => {
    expect(
      pickBodyPart({
        type: "multipart/mixed",
        childNodes: [
          { part: "1", type: "text/plain" },
          {
            part: "2",
            type: "message/rfc822",
            childNodes: [{ part: "2.1", type: "text/html" }],
          },
        ],
      }),
    ).toEqual({ part: "1", bodyType: "text" });
  });
});

describe("ImapMailConnector reading", () => {
  function client(
    bodyStructure: unknown,
    download: ReturnType<typeof vi.fn>,
    date?: Date | string,
  ) {
    return {
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      fetchOne: vi.fn(async (_uid: string, query: Record<string, unknown>) =>
        query.source
          ? { uid: 7, source: Buffer.from("Subject: x\r\n\r\nraw fallback body") }
          : {
              uid: 7,
              envelope: { subject: "Rechnung", from: [{ address: "hotel@example.com" }], date },
              flags: new Set<string>(),
              bodyStructure,
            },
      ),
      download,
      logout: vi.fn(async () => undefined),
    };
  }

  it("returns the decoded HTML part instead of the raw MIME source", async () => {
    const download = vi.fn(async () => ({
      content: (async function* () {
        yield Buffer.from("<p>Sehr geehrter Herr Schmieder, anbei die Rechnung.</p>");
      })(),
    }));
    const message = await connectorWith(client(ALTERNATIVE, download)).getMessage("INBOX/7");

    expect(download).toHaveBeenCalledWith("7", "1.2", { uid: true });
    expect(message.bodyType).toBe("html");
    expect(message.body).toContain("Sehr geehrter Herr Schmieder");
    expect(message.body).not.toContain("Content-Transfer-Encoding");
    expect(message.snippet).toBe("Sehr geehrter Herr Schmieder, anbei die Rechnung.");
    expect(message.attachments.map((attachment) => attachment.name)).toEqual(["Rechnung.pdf"]);
  });

  it("falls back to the raw body when the structure names no readable part", async () => {
    const download = vi.fn();
    const message = await connectorWith(client(undefined, download)).getMessage("INBOX/7");

    expect(download).not.toHaveBeenCalled();
    expect(message.body).toBe("raw fallback body");
    expect(message.bodyType).toBe("text");
  });

  it.each([
    ["Sat, 17 Oct 2026 12:00:00 +0200", "2026-10-17T10:00:00.000Z"],
    [new Date("2026-10-17T10:00:00Z"), "2026-10-17T10:00:00.000Z"],
    ["not a date", ""],
  ])("normalizes envelope date %s", async (date, expected) => {
    const message = await connectorWith(client(undefined, vi.fn(), date)).getMessage("INBOX/7");
    expect(message.receivedAt).toBe(expected);
  });

  it("reports a missing body and releases the mailbox and connection", async () => {
    const imap = client(
      ALTERNATIVE,
      vi.fn(async () => ({})),
    );
    const release = vi.fn();
    imap.getMailboxLock.mockResolvedValue({ release });

    await expect(connectorWith(imap).getMessage("INBOX/7")).rejects.toThrow(/body.*not found/i);
    expect(release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
  });

  it("reports a missing attachment and releases the mailbox and connection", async () => {
    const imap = client(
      ALTERNATIVE,
      vi.fn(async () => ({})),
    );
    const release = vi.fn();
    imap.getMailboxLock.mockResolvedValue({ release });

    await expect(connectorWith(imap).downloadAttachment("INBOX/7", "2")).rejects.toThrow(
      /attachment.*not found/i,
    );
    expect(release).toHaveBeenCalledOnce();
    expect(imap.logout).toHaveBeenCalledOnce();
  });
});
