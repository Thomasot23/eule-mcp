import { describe, expect, it, vi } from "vitest";
import {
  formatImapId,
  ImapMailConnector,
  parseImapId,
  replyThreadHeaders,
} from "../src/providers/imap/imap-mail.js";

describe("ImapMailConnector search", () => {
  it("selects the newest matching UIDs instead of truncating the oldest results", async () => {
    const release = vi.fn();
    const logout = vi.fn(async () => undefined);
    const search = vi.fn(async () => [10, 11, 900, 901]);
    const fetch = vi.fn((_uids: number[]) =>
      (async function* () {
        // IMAP servers normally stream the requested UID set in ascending order.
        yield {
          uid: 900,
          envelope: { subject: "Invoice A", date: new Date("2026-01-10T10:00:00Z") },
          flags: new Set<string>(),
        };
        yield {
          uid: 901,
          envelope: { subject: "Invoice B", date: new Date("2026-02-10T10:00:00Z") },
          flags: new Set(["\\Seen"]),
        };
      })(),
    );
    const client = {
      getMailboxLock: vi.fn(async () => ({ release })),
      search,
      fetch,
      logout,
    };
    const connector = new ImapMailConnector("user@example.com", {
      account: "user@example.com",
      host: "imap.example.com",
      smtpHost: "smtp.example.com",
      auth: "password",
      password: "test",
    });
    Object.defineProperty(connector, "connect", { value: vi.fn(async () => client) });

    const messages = await connector.searchMessages("invoice", 2, "INBOX");

    expect(search).toHaveBeenCalledWith({ text: "invoice" }, { uid: true });
    expect(fetch).toHaveBeenCalledWith([900, 901], { envelope: true, flags: true }, { uid: true });
    expect(messages.map((message) => message.id)).toEqual(["INBOX/901", "INBOX/900"]);
    expect(messages.every((message) => message.receivedAt.startsWith("2026-"))).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledOnce();
  });
});

/** Builds a connector whose `connect` returns the given fake IMAP client. */
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

describe("ImapMailConnector delete", () => {
  function client(mailboxes: { path: string; specialUse?: string }[]) {
    return {
      list: vi.fn(async () => mailboxes),
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      messageMove: vi.fn(async () => undefined),
      messageFlagsAdd: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    };
  }

  it("moves to the server's declared \\Trash folder rather than flagging in place", async () => {
    const c = client([{ path: "INBOX" }, { path: "Bin", specialUse: "\\Trash" }]);
    await connectorWith(c).deleteMessage("42");
    expect(c.messageMove).toHaveBeenCalledWith("42", "Bin", { uid: true });
    // Setting \Deleted leaves the mail in place and exposed to any EXPUNGE.
    expect(c.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("falls back to a conventional trash name when no special-use flag is given", async () => {
    const c = client([{ path: "INBOX" }, { path: "Deleted Messages" }]);
    await connectorWith(c).deleteMessage("42");
    expect(c.messageMove).toHaveBeenCalledWith("42", "Deleted Messages", { uid: true });
  });

  it("prefers the special-use folder over a same-named conventional one", async () => {
    const c = client([{ path: "Trash" }, { path: "Papierkorb", specialUse: "\\Trash" }]);
    await connectorWith(c).deleteMessage("42");
    expect(c.messageMove).toHaveBeenCalledWith("42", "Papierkorb", { uid: true });
  });

  it("only falls back to the \\Deleted flag when the server has no trash at all", async () => {
    const c = client([{ path: "INBOX" }, { path: "Archive" }]);
    await connectorWith(c).deleteMessage("42");
    expect(c.messageMove).not.toHaveBeenCalled();
    expect(c.messageFlagsAdd).toHaveBeenCalledWith("42", ["\\Deleted"], { uid: true });
  });
});

describe("ImapMailConnector getSummaries", () => {
  it("fetches envelopes for many UIDs in a single FETCH, without bodies", async () => {
    const fetch = vi.fn((_uids: number[]) =>
      (async function* () {
        yield {
          uid: 7,
          envelope: {
            subject: "Build failed",
            from: [{ address: "ci@example.com" }],
            date: new Date("2026-03-01T08:00:00Z"),
          },
          flags: new Set<string>(),
        };
      })(),
    );
    const c = {
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      fetch,
      logout: vi.fn(async () => undefined),
    };
    const summaries = await connectorWith(c).getSummaries(["7", "8"]);

    expect(fetch).toHaveBeenCalledWith([7, 8], { envelope: true, flags: true }, { uid: true });
    expect(summaries).toEqual([
      expect.objectContaining({ id: "7", subject: "Build failed", from: "ci@example.com" }),
    ]);
  });

  it("ignores non-numeric ids and skips the round trip when nothing is left", async () => {
    const c = { fetch: vi.fn(), getMailboxLock: vi.fn(), logout: vi.fn() };
    expect(await connectorWith(c).getSummaries(["not-a-uid"])).toEqual([]);
    expect(c.getMailboxLock).not.toHaveBeenCalled();
  });
});

describe("IMAP message ids", () => {
  it("carry their mailbox and round-trip, hierarchy delimiters included", () => {
    expect(formatImapId("INBOX", 42)).toBe("INBOX/42");
    expect(parseImapId("INBOX/42")).toEqual({ mailbox: "INBOX", uid: 42 });
    const nested = formatImapId("Archive/2026", 7);
    expect(nested).toBe("Archive%2F2026/7");
    expect(parseImapId(nested)).toEqual({ mailbox: "Archive/2026", uid: 7 });
  });

  it("read a bare UID as the default mailbox", () => {
    expect(parseImapId("42")).toEqual({ mailbox: "INBOX", uid: 42 });
    expect(parseImapId("42", "Drafts")).toEqual({ mailbox: "Drafts", uid: 42 });
  });

  it.each(["", "abc", "INBOX/", "/42", "INBOX/4x", "%E0%A4%A/1"])("reject %j", (id) => {
    expect(() => parseImapId(id)).toThrow(/Invalid IMAP message id/);
  });
});

/** A fake IMAP account: mailbox path → messages, with per-mailbox locks. */
function account(
  boxes: Record<string, { uid: number; subject: string; date: string }[]>,
  listing: { path: string; specialUse?: string; flags?: string[] }[] = Object.keys(boxes).map(
    (path) => ({ path }),
  ),
) {
  let open = "";
  const locked: string[] = [];
  const client = {
    list: vi.fn(async () => listing.map((box) => ({ ...box, flags: new Set(box.flags ?? []) }))),
    getMailboxLock: vi.fn(async (path: string) => {
      if (!(path in boxes)) throw new Error(`Mailbox doesn't exist: ${path}`);
      open = path;
      locked.push(path);
      return { release: vi.fn() };
    }),
    search: vi.fn(async () => (boxes[open] ?? []).map((m) => m.uid)),
    fetch: vi.fn((uids: number[]) =>
      (async function* () {
        for (const m of boxes[open] ?? []) {
          if (uids.includes(m.uid)) {
            yield { uid: m.uid, envelope: { subject: m.subject, date: new Date(m.date) } };
          }
        }
      })(),
    ),
    fetchOne: vi.fn(async (uid: string) => {
      const m = (boxes[open] ?? []).find((entry) => String(entry.uid) === uid);
      return m ? { uid: m.uid, envelope: { subject: m.subject }, source: Buffer.from("") } : false;
    }),
    messageMove: vi.fn(async () => undefined),
    messageFlagsAdd: vi.fn(async () => undefined),
    messageFlagsRemove: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
  };
  return { client, locked };
}

describe("ImapMailConnector search scope", () => {
  const boxes = {
    INBOX: [{ uid: 5, subject: "inbox mail", date: "2026-09-01T10:00:00Z" }],
    Archive: [{ uid: 5, subject: "archived mail", date: "2026-10-01T10:00:00Z" }],
    "Sent Messages": [{ uid: 9, subject: "sent mail", date: "2026-08-01T10:00:00Z" }],
    "[Gmail]": [],
  };
  const listing = [
    { path: "INBOX" },
    { path: "Archive", specialUse: "\\Archive" },
    { path: "Sent Messages", specialUse: "\\Sent" },
    { path: "[Gmail]", flags: ["\\Noselect"] },
  ];

  it("searches every selectable mailbox without a folder, newest first, ids per mailbox", async () => {
    const { client, locked } = account(boxes, listing);
    const messages = await connectorWith(client).searchMessages("mail", 10);
    expect(locked).toEqual(["INBOX", "Archive", "Sent Messages"]);
    expect(messages.map((m) => [m.id, m.subject])).toEqual([
      ["Archive/5", "archived mail"],
      ["INBOX/5", "inbox mail"],
      ["Sent%20Messages/9", "sent mail"],
    ]);
  });

  it("keeps only the newest matches across mailboxes", async () => {
    const { client } = account(boxes, listing);
    const messages = await connectorWith(client).searchMessages("mail", 1);
    expect(messages.map((m) => m.id)).toEqual(["Archive/5"]);
  });

  it("resolves a well-known folder name through the special-use flag", async () => {
    const { client, locked } = account(boxes, listing);
    const messages = await connectorWith(client).searchMessages("mail", 10, "Gesendete Elemente");
    expect(locked).toEqual(["Sent Messages"]);
    expect(messages.map((m) => m.id)).toEqual(["Sent%20Messages/9"]);
  });

  it("searches only \\All, junk and trash where an \\All mailbox exists", async () => {
    const { client, locked } = account({ "All Mail": [], Spam: [], Bin: [], INBOX: [] }, [
      { path: "INBOX" },
      { path: "All Mail", specialUse: "\\All" },
      { path: "Spam", specialUse: "\\Junk" },
      { path: "Bin", specialUse: "\\Trash" },
    ]);
    await connectorWith(client).searchMessages("x", 10);
    expect(locked).toEqual(["All Mail", "Spam", "Bin"]);
  });

  it("skips a mailbox that cannot be opened, and fails only when none can", async () => {
    const partial = account(boxes, [...listing, { path: "Gone" }]);
    const messages = await connectorWith(partial.client).searchMessages("mail", 10);
    expect(messages).toHaveLength(3);

    const none = account({}, [{ path: "Gone" }]);
    await expect(connectorWith(none.client).searchMessages("mail", 10)).rejects.toThrow(
      /doesn't exist/,
    );
  });
});

describe("ImapMailConnector follow-up actions use the id's mailbox", () => {
  const boxes = {
    INBOX: [{ uid: 5, subject: "inbox mail", date: "2026-09-01T10:00:00Z" }],
    Archive: [{ uid: 5, subject: "archived mail", date: "2026-10-01T10:00:00Z" }],
    Bin: [],
  };
  const listing = [
    { path: "INBOX" },
    { path: "Archive", specialUse: "\\Archive" },
    { path: "Bin", specialUse: "\\Trash" },
  ];

  it("reads the message from its own mailbox, not the inbox with the same UID", async () => {
    const { client, locked } = account(boxes, listing);
    const message = await connectorWith(client).getMessage("Archive/5");
    expect(locked).toEqual(["Archive"]);
    expect(message.subject).toBe("archived mail");
    expect(message.id).toBe("Archive/5");
  });

  it("deletes from the id's mailbox into the trash", async () => {
    const { client, locked } = account(boxes, listing);
    await connectorWith(client).deleteMessage("Archive/5");
    expect(locked).toEqual(["Archive"]);
    expect(client.messageMove).toHaveBeenCalledWith("5", "Bin", { uid: true });
  });

  it("leaves a message that is already in the trash alone", async () => {
    const { client } = account(boxes, listing);
    await connectorWith(client).deleteMessage("Bin/3");
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("moves from the id's mailbox to a resolved target folder", async () => {
    const { client, locked } = account(boxes, listing);
    await connectorWith(client).moveMessage("Archive/5", "Posteingang");
    expect(locked).toEqual(["Archive"]);
    expect(client.messageMove).toHaveBeenCalledWith("5", "INBOX", { uid: true });
  });

  it("flags in the id's mailbox", async () => {
    const { client, locked } = account(boxes, listing);
    await connectorWith(client).markRead("Archive/5", false);
    expect(locked).toEqual(["Archive"]);
    expect(client.messageFlagsRemove).toHaveBeenCalledWith("5", ["\\Seen"], { uid: true });
  });

  it("groups summaries by mailbox and returns the ids as requested", async () => {
    const { client, locked } = account(boxes, listing);
    const summaries = await connectorWith(client).getSummaries(["5", "Archive/5", "Gone/1"]);
    expect(locked).toEqual(["INBOX", "Archive"]);
    expect(summaries.map((s) => [s.id, s.subject])).toEqual([
      ["5", "inbox mail"],
      ["Archive/5", "archived mail"],
    ]);
  });

  it("rejects a malformed id before connecting", async () => {
    const { client } = account(boxes, listing);
    const connector = connectorWith(client);
    await expect(connector.getMessage("Archive/x")).rejects.toThrow(/Invalid IMAP message id/);
    expect(client.getMailboxLock).not.toHaveBeenCalled();
  });
});

describe("replyThreadHeaders", () => {
  it("replies to the parent's Message-ID and extends its References", () => {
    expect(
      replyThreadHeaders({
        messageId: "<m3@example.com>",
        inReplyTo: "<m2@example.com>",
        references: "<m1@example.com> <m2@example.com>",
      }),
    ).toEqual({
      inReplyTo: "<m3@example.com>",
      references: ["<m1@example.com>", "<m2@example.com>", "<m3@example.com>"],
    });
  });

  it("falls back to a single-id In-Reply-To when the parent has no References", () => {
    expect(
      replyThreadHeaders({ messageId: "<m2@example.com>", inReplyTo: "<m1@example.com>" }),
    ).toEqual({
      inReplyTo: "<m2@example.com>",
      references: ["<m1@example.com>", "<m2@example.com>"],
    });
  });

  it("does not take an In-Reply-To with several ids as the chain", () => {
    expect(
      replyThreadHeaders({
        messageId: "<m3@example.com>",
        inReplyTo: "<m1@example.com> <m2@example.com>",
      }),
    ).toEqual({ inReplyTo: "<m3@example.com>", references: ["<m3@example.com>"] });
  });

  it("keeps the parent's References when the parent has no Message-ID", () => {
    expect(replyThreadHeaders({ references: "<m1@example.com>" })).toEqual({
      references: ["<m1@example.com>"],
    });
  });

  it("sets nothing when the parent has none of the three", () => {
    expect(replyThreadHeaders({})).toEqual({});
  });

  it("carries only well-formed ids, so a crafted header cannot add a line", () => {
    const headers = replyThreadHeaders({
      messageId: "<m2@example.com>\r\nBcc: attacker@example.com",
      references: "<m1@example.com>\r\nX-Injected: yes <broken",
    });
    expect(headers).toEqual({
      inReplyTo: "<m2@example.com>",
      references: ["<m1@example.com>", "<m2@example.com>"],
    });
  });

  it("keeps the root and the newest ancestors of a very long chain", () => {
    const chain = Array.from({ length: 80 }, (_, i) => `<m${String(i)}@example.com>`);
    const { references } = replyThreadHeaders({
      messageId: "<own@example.com>",
      references: chain.join(" "),
    });
    expect(references).toHaveLength(50);
    expect(references?.[0]).toBe("<m0@example.com>");
    expect(references?.at(-2)).toBe("<m79@example.com>");
    expect(references?.at(-1)).toBe("<own@example.com>");
  });
});

describe("ImapMailConnector reply threading", () => {
  /** A client holding one message, and a connector whose SMTP send is recorded. */
  function setup(headers: string) {
    const client = {
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      fetchOne: vi.fn(async () => ({
        uid: 5,
        envelope: {
          subject: "Budget",
          from: [{ address: "colleague@example.com" }],
          messageId: "<m3@example.com>",
          inReplyTo: "<m2@example.com>",
        },
        headers: Buffer.from(headers),
        source: Buffer.from(""),
      })),
      logout: vi.fn(async () => undefined),
    };
    const connector = connectorWith(client);
    const sendMail = vi.fn(async (_options: Record<string, unknown>) => ({}));
    Object.defineProperty(connector, "makeTransport", {
      value: vi.fn(async () => ({ sendMail, close: vi.fn() })),
    });
    return { client, connector, sendMail };
  }

  it("threads a reply on the parent's Message-ID rather than eule's id", async () => {
    const { client, connector, sendMail } = setup(
      "References: <m1@example.com>\r\n <m2@example.com>\r\n\r\n",
    );
    await connector.replyToMessage("Archive/5", "Danke");

    expect(client.fetchOne).toHaveBeenCalledWith(
      "5",
      expect.objectContaining({ headers: ["references"] }),
      { uid: true },
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "colleague@example.com",
        subject: "Re: Budget",
        inReplyTo: "<m3@example.com>",
        references: ["<m1@example.com>", "<m2@example.com>", "<m3@example.com>"],
      }),
    );
  });

  it("forwards without threading headers", async () => {
    const { connector, sendMail } = setup("References: <m1@example.com>\r\n\r\n");
    await connector.forwardMessage("INBOX/5", ["third@example.com"]);
    const options = sendMail.mock.calls[0]?.[0] ?? {};
    expect(options).not.toHaveProperty("inReplyTo");
    expect(options).not.toHaveProperty("references");
  });
});

describe("ImapMailConnector Sent copy", () => {
  function client(mailboxes: { path: string; specialUse?: string }[]) {
    return {
      list: vi.fn(async () => mailboxes),
      append: vi.fn(async (_mailbox: string, _raw: Buffer, _flags: string[]) => ({ uid: 7 })),
      mailboxOpen: vi.fn(async () => undefined),
      fetchOne: vi.fn(async () => ({ source: Buffer.from("Subject: draft\r\n\r\nbody") })),
      messageFlagsAdd: vi.fn(async () => undefined),
      messageDelete: vi.fn(async () => undefined),
      logout: vi.fn(async () => undefined),
    };
  }

  function sending(
    imap: unknown,
    smtpHost = "smtp.mail.me.com",
    saveSentCopy?: boolean,
  ): { connector: ImapMailConnector; sendMail: ReturnType<typeof vi.fn> } {
    const connector = new ImapMailConnector("user@example.com", {
      account: "user@example.com",
      host: "imap.example.com",
      smtpHost,
      auth: "password",
      password: "test",
      ...(saveSentCopy === undefined ? {} : { saveSentCopy }),
    });
    const sendMail = vi.fn(async () => ({}));
    Object.defineProperty(connector, "connect", { value: vi.fn(async () => imap) });
    Object.defineProperty(connector, "makeTransport", {
      value: vi.fn(async () => ({ sendMail, close: vi.fn() })),
    });
    return { connector, sendMail };
  }

  it("files the sent message in the server's \\Sent mailbox with the same Message-ID", async () => {
    const imap = client([{ path: "INBOX" }, { path: "Sent Messages", specialUse: "\\Sent" }]);
    const { connector, sendMail } = sending(imap);

    const receipt = await connector.sendMessage(["to@example.com"], "Hi", "Body", {
      bcc: ["hidden@example.com"],
    });

    expect(receipt).toEqual({});
    const sent = (sendMail.mock.calls[0] as unknown as [{ messageId: string }])[0];
    expect(imap.append).toHaveBeenCalledOnce();
    const [mailbox, raw, flags] = imap.append.mock.calls[0] as unknown as [
      string,
      Buffer,
      string[],
    ];
    expect(mailbox).toBe("Sent Messages");
    expect(flags).toEqual(["\\Seen"]);
    const copy = raw.toString();
    expect(copy).toContain(`Message-ID: ${sent.messageId}`);
    // The filed copy keeps Bcc, as mail clients do; the submission does not need it.
    expect(copy).toContain("Bcc: hidden@example.com");
  });

  it("falls back to a mailbox named like Sent when the server has no special-use flags", async () => {
    const imap = client([{ path: "INBOX" }, { path: "Sent" }]);
    const { connector } = sending(imap);
    await connector.sendMessage(["to@example.com"], "Hi", "Body");
    expect(imap.append.mock.calls[0]?.[0]).toBe("Sent");
  });

  it("does not file a copy where the SMTP service does it itself", async () => {
    for (const host of ["smtp.gmail.com", "smtp.office365.com"]) {
      const imap = client([{ path: "Sent", specialUse: "\\Sent" }]);
      const { connector, sendMail } = sending(imap, host);
      await connector.sendMessage(["to@example.com"], "Hi", "Body");
      expect(sendMail).toHaveBeenCalledOnce();
      expect(imap.append).not.toHaveBeenCalled();
    }
  });

  it("honours an explicit saveSentCopy setting", async () => {
    const off = client([{ path: "Sent", specialUse: "\\Sent" }]);
    await sending(off, "smtp.mail.me.com", false).connector.sendMessage(["a@b.de"], "x", "y");
    expect(off.append).not.toHaveBeenCalled();
    const on = client([{ path: "Sent", specialUse: "\\Sent" }]);
    await sending(on, "smtp.gmail.com", true).connector.sendMessage(["a@b.de"], "x", "y");
    expect(on.append).toHaveBeenCalledOnce();
  });

  it("reports a failed Sent copy as a warning, not as a failed send", async () => {
    const imap = client([{ path: "Sent", specialUse: "\\Sent" }]);
    imap.append.mockRejectedValueOnce(new Error("quota exceeded"));
    const { connector, sendMail } = sending(imap);

    const receipt = await connector.sendMessage(["to@example.com"], "Hi", "Body");

    expect(sendMail).toHaveBeenCalledOnce();
    expect(receipt.warning).toMatch(/Sent folder: quota exceeded/);
  });

  it("files a sent draft in the special-use Sent mailbox, not a literal 'Sent'", async () => {
    const imap = client([
      { path: "Drafts", specialUse: "\\Drafts" },
      { path: "Sent Messages", specialUse: "\\Sent" },
    ]);
    const { connector, sendMail } = sending(imap);

    await connector.sendDraft("Drafts/12");

    expect(sendMail).toHaveBeenCalledOnce();
    expect(imap.messageDelete).toHaveBeenCalledWith("12", { uid: true });
    expect(imap.append).toHaveBeenCalledWith("Sent Messages", expect.any(Buffer), ["\\Seen"]);
  });

  it("creates drafts in the server's \\Drafts mailbox", async () => {
    const imap = client([{ path: "Entwürfe", specialUse: "\\Drafts" }]);
    const { connector } = sending(imap);

    const draft = await connector.createDraft(["to@example.com"], "Hi", "Body");

    expect(imap.append.mock.calls[0]?.[0]).toBe("Entwürfe");
    expect(draft.id).toBe("Entw%C3%BCrfe/7");
  });
});
