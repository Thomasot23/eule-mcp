import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleMailConnector } from "../src/providers/google/google-mail.js";
import { EwsMailConnector } from "../src/providers/m365/ews-mail.js";
import { GraphMailConnector } from "../src/providers/m365/graph-mail.js";

/**
 * The folder contract of `MailConnector.searchMessages`: without a folder the
 * whole mailbox, with one exactly that folder. IMAP is covered in
 * imap-mail.test.ts.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stub fetch, record every request and answer through `respond`. */
function recordFetch(respond: (url: string, body: string) => Response) {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const call = { url: String(input), body: typeof init?.body === "string" ? init.body : "" };
      calls.push(call);
      return respond(call.url, call.body);
    }),
  );
  return calls;
}

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });

describe("GraphMailConnector folder scope", () => {
  const graph = (shared = false) =>
    new GraphMailConnector("user@example.com", async () => "token", shared);

  it("searches the whole mailbox without a folder", async () => {
    const calls = recordFetch(() => json({ value: [] }));
    await graph().searchMessages("invoice", 5);
    await graph().searchMessages("invoice", 5, " ");
    for (const call of calls) {
      expect(call.url).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages\?\$search=/);
    }
  });

  it("scopes the search to a folder and normalises its name", async () => {
    const calls = recordFetch(() => json({ value: [] }));
    await graph().searchMessages("invoice", 5, "Posteingang");
    await graph().searchMessages("invoice", 5, "Sent Messages");
    await graph(true).searchMessages("invoice", 5, "Archiv");
    expect(calls.map((c) => c.url.split("?")[0])).toEqual([
      "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
      "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages",
      "https://graph.microsoft.com/v1.0/users/user@example.com/mailFolders/archive/messages",
    ]);
  });

  it("resolves a custom folder by display name and passes an opaque id through", async () => {
    const id = `AAMkAG${"x".repeat(60)}`;
    const calls = recordFetch((url) =>
      url.includes("/mailFolders?") ? json({ value: [{ id: "folder-42" }] }) : json({ value: [] }),
    );
    await graph().searchMessages("invoice", 5, "Projekte 2026");
    await graph().searchMessages("invoice", 5, id);
    expect(decodeURIComponent(calls[0]?.url ?? "")).toContain(
      "/me/mailFolders?$filter=displayName eq 'Projekte 2026'",
    );
    expect(calls[1]?.url.split("?")[0]).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/folder-42/messages",
    );
    expect(calls[2]?.url.split("?")[0]).toBe(
      `https://graph.microsoft.com/v1.0/me/mailFolders/${id}/messages`,
    );
  });

  it("narrows a search to nothing for a folder the mailbox lacks, but fails list and move", async () => {
    const calls = recordFetch(() => json({ value: [] }));
    await expect(graph().searchMessages("invoice", 5, "Nicht da")).resolves.toEqual([]);
    expect(calls).toHaveLength(1);
    await expect(graph().listMessages("Nicht da")).rejects.toThrow(/"Nicht da" not found/);
    await expect(graph().moveMessage("msg-1", "Nicht da")).rejects.toThrow(/not found/);
  });

  it("normalises folder names when listing and moving", async () => {
    const calls = recordFetch(() => json({ value: [] }));
    await graph().listMessages("Gesendete Elemente", 5);
    await graph().moveMessage("msg-1", "Papierkorb");
    expect(calls[0]?.url.split("?")[0]).toBe(
      "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages",
    );
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ destinationId: "deleteditems" });
  });
});

const soapEnvelope = (inner: string): string => `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">
  <s:Body>${inner}</s:Body>
</s:Envelope>`;

const folderListing = (folders: { id: string; folderClass: string; element?: string }[]) =>
  soapEnvelope(`<m:FindFolderResponse><m:ResponseMessages>
    <m:FindFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
      <m:RootFolder TotalItemsInView="${String(folders.length)}"><t:Folders>
        ${folders
          .map(
            ({ id, folderClass, element = "Folder" }) =>
              `<t:${element}><t:FolderId Id="${id}" ChangeKey="ck"/><t:FolderClass>${folderClass}</t:FolderClass></t:${element}>`,
          )
          .join("")}
      </t:Folders></m:RootFolder>
    </m:FindFolderResponseMessage></m:ResponseMessages></m:FindFolderResponse>`);

const itemsFound = (items: { id: string; subject: string; date: string }[]) =>
  soapEnvelope(`<m:FindItemResponse><m:ResponseMessages>
    <m:FindItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>
      <m:RootFolder TotalItemsInView="${String(items.length)}"><t:Items>
        ${items
          .map(
            (item) => `<t:Message><t:ItemId Id="${item.id}" ChangeKey="ck"/>
              <t:Subject>${item.subject}</t:Subject>
              <t:From><t:Mailbox><t:EmailAddress>x@example.com</t:EmailAddress></t:Mailbox></t:From>
              <t:DateTimeReceived>${item.date}</t:DateTimeReceived><t:IsRead>false</t:IsRead>
            </t:Message>`,
          )
          .join("")}
      </t:Items></m:RootFolder>
    </m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse>`);

describe("EwsMailConnector folder scope", () => {
  const ews = (shared = false) =>
    new EwsMailConnector("user@example.com", async () => "token", shared);
  const xml = (body: string): Response => new Response(body, { status: 200 });

  const items: Record<string, { id: string; subject: string; date: string }[]> = {
    "f-inbox": [{ id: "i1", subject: "Inbox", date: "2026-09-01T10:00:00Z" }],
    "f-archive": [{ id: "a1", subject: "Archived", date: "2026-10-01T10:00:00Z" }],
    "f-conv": [{ id: "c1", subject: "Conversation", date: "2026-08-01T10:00:00Z" }],
  };
  const listing = folderListing([
    { id: "f-inbox", folderClass: "IPF.Note" },
    { id: "f-archive", folderClass: "IPF.Note" },
    { id: "f-conv", folderClass: "IPF.Note.Microsoft.Conversation" },
    { id: "f-config", folderClass: "IPF.Configuration" },
    { id: "f-cal", folderClass: "IPF.Appointment", element: "CalendarFolder" },
  ]);

  const respond = (_url: string, body: string): Response => {
    if (body.includes("<m:FindFolder")) return xml(listing);
    const folder = /<t:FolderId Id="([^"]+)"/.exec(body)?.[1] ?? "";
    return xml(itemsFound(items[folder] ?? []));
  };

  it("searches every mail folder without a folder and merges newest first", async () => {
    const calls = recordFetch(respond);
    const messages = await ews().searchMessages("x", 10);

    expect(calls[0]?.body).toMatch(/<m:FindFolder Traversal="Deep">/);
    expect(calls[0]?.body).toContain('<t:DistinguishedFolderId Id="msgfolderroot"/>');
    const searched = calls.slice(1).map((c) => /<t:FolderId Id="([^"]+)"/.exec(c.body)?.[1]);
    expect(searched.sort()).toEqual(["f-archive", "f-conv", "f-inbox"]);
    expect(messages.map((m) => m.subject)).toEqual(["Archived", "Inbox", "Conversation"]);
  });

  it("keeps only the newest matches across folders", async () => {
    recordFetch(respond);
    const messages = await ews().searchMessages("x", 2);
    expect(messages.map((m) => m.subject)).toEqual(["Archived", "Inbox"]);
  });

  it("searches only the named folder, normalised, without listing folders", async () => {
    const calls = recordFetch(() => xml(itemsFound([])));
    await ews().searchMessages("x", 10, "Archiv");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain('<t:DistinguishedFolderId Id="archive"/>');
    expect(calls[0]?.body).not.toContain("FindFolder");
  });

  it("lists the folders of a shared mailbox in that mailbox", async () => {
    const calls = recordFetch(respond);
    await ews(true).searchMessages("x", 10);
    expect(calls[0]?.body).toContain(
      '<t:DistinguishedFolderId Id="msgfolderroot"><t:Mailbox><t:EmailAddress>user@example.com</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>',
    );
  });

  it("falls back to the inbox when the folder tree cannot be read", async () => {
    const denied = soapEnvelope(`<m:FindFolderResponse><m:ResponseMessages>
      <m:FindFolderResponseMessage ResponseClass="Error">
        <m:MessageText>Access is denied.</m:MessageText><m:ResponseCode>ErrorAccessDenied</m:ResponseCode>
      </m:FindFolderResponseMessage></m:ResponseMessages></m:FindFolderResponse>`);
    const calls = recordFetch((_url, body) =>
      xml(body.includes("<m:FindFolder") ? denied : itemsFound(items["f-inbox"] ?? [])),
    );
    const messages = await ews().searchMessages("x", 10);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toContain('<t:DistinguishedFolderId Id="inbox"/>');
    expect(messages.map((m) => m.subject)).toEqual(["Inbox"]);
  });

  it("skips a folder that fails and fails only when every folder does", async () => {
    recordFetch((url, body) => {
      if (body.includes("<m:FindFolder")) return xml(listing);
      if (body.includes('Id="f-archive"')) return new Response("boom", { status: 500 });
      return respond(url, body);
    });
    expect((await ews().searchMessages("x", 10)).map((m) => m.subject)).toEqual([
      "Inbox",
      "Conversation",
    ]);

    recordFetch((_url, body) =>
      body.includes("<m:FindFolder") ? xml(listing) : new Response("boom", { status: 500 }),
    );
    await expect(ews().searchMessages("x", 10)).rejects.toThrow(/EWS 500/);
  });
});

describe("EwsMailConnector folder names", () => {
  const ews = () => new EwsMailConnector("user@example.com", async () => "token");
  const xml = (body: string): Response => new Response(body, { status: 200 });

  it("maps provider names such as iCloud's 'Sent Messages' onto sentitems", async () => {
    const calls = recordFetch(() => xml(itemsFound([])));
    await ews().searchMessages("x", 5, "Sent Messages");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toContain('<t:DistinguishedFolderId Id="sentitems"/>');
  });

  it("looks up a custom folder by display name and searches its id", async () => {
    const calls = recordFetch((_url, body) =>
      body.includes("<m:FindFolder")
        ? xml(folderListing([{ id: "f-proj", folderClass: "IPF.Note" }]))
        : xml(itemsFound([])),
    );
    await ews().searchMessages("x", 5, "Projekte 2026");
    expect(calls[0]?.body).toContain('<t:Constant Value="Projekte 2026"/>');
    expect(calls[1]?.body).toContain('<t:FolderId Id="f-proj"/>');
  });

  it("narrows a search to nothing for a folder the mailbox lacks, but fails list and move", async () => {
    recordFetch(() => xml(folderListing([])));
    await expect(ews().searchMessages("x", 5, "Nicht da")).resolves.toEqual([]);
    await expect(ews().listMessages("Nicht da")).rejects.toThrow(/"Nicht da" not found/);
    await expect(ews().moveMessage("i1", "Nicht da")).rejects.toThrow(/not found/);
  });
});

describe("GoogleMailConnector folder scope", () => {
  const gmail = () => new GoogleMailConnector("user@gmail.com", async () => "token");
  const query = (url: string) => new URL(url).searchParams;

  it("searches the whole mailbox, spam and trash included, without a folder", async () => {
    const calls = recordFetch(() => json({ messages: [] }));
    await gmail().searchMessages("invoice", 5);
    expect(query(calls[0]?.url ?? "").get("q")).toBe("invoice");
    expect(query(calls[0]?.url ?? "").get("includeSpamTrash")).toBe("true");
  });

  it.each([
    ["Papierkorb", "(invoice) in:trash"],
    ["INBOX", "(invoice) in:inbox"],
    ["Archiv", "(invoice) -in:inbox -in:sent -in:drafts -in:spam -in:trash"],
    ["Projekte 2026", "(invoice) label:Projekte-2026"],
  ])("narrows a search in %j with %j", async (folder, expected) => {
    const calls = recordFetch(() => json({ messages: [] }));
    await gmail().searchMessages("invoice", 5, folder);
    expect(query(calls[0]?.url ?? "").get("q")).toBe(expected);
  });

  it("maps display names onto system labels when listing", async () => {
    const calls = recordFetch(() => json({ messages: [] }));
    await gmail().listMessages("Posteingang", 5);
    expect(query(calls[0]?.url ?? "").get("labelIds")).toBe("INBOX");
  });
});
