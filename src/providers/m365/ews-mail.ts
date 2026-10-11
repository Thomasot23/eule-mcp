import { XMLParser } from "fast-xml-parser";
import { hasFolder, looksLikeFolderId, wellKnownMailFolder } from "../../utils/mail-folders.js";
import { assembleHtml } from "../../utils/mail-html.js";
import { assertResponseSize, escapeXml, fetchWithTimeout } from "../../utils/security.js";
import type {
  MailConnector,
  MailMessage,
  MailMessageFull,
  MailAttachment,
  MailSendOpts,
  OutgoingAttachment,
  SendReceipt,
} from "../../types/index.js";

const EWS_URL = "https://outlook.office365.com/EWS/Exchange.asmx";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  isArray: (name) => ["Message", "FileAttachment", "Mailbox"].includes(name),
  processEntities: { enabled: true, maxTotalExpansions: 50000 },
  htmlEntities: true,
  numberParseOptions: { hex: false, leadingZeros: false, skipLike: /.*/ },
});

function soap(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"
  xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">
  <soap:Body>${body}</soap:Body>
</soap:Envelope>`;
}

/** Concurrent FindItem requests for a mailbox-wide search. */
const FOLDER_SEARCH_CONCURRENCY = 4;

/** Safely navigate a nested object path. */
function dig(obj: unknown, ...keys: string[]): unknown {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function str(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object" && "#text" in (val as Record<string, unknown>)) {
    return String((val as Record<string, unknown>)["#text"]);
  }
  return JSON.stringify(val);
}

export class EwsMailConnector implements MailConnector {
  readonly tier = "ews";
  signature?: string;
  displayName?: string;

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly shared = false,
  ) {}

  /**
   * FolderId XML for a name: well-known names become a DistinguishedFolderId,
   * an opaque id a FolderId, anything else is looked up by display name below
   * the message root. Undefined when no folder has that name.
   */
  private async folderRef(name: string): Promise<string | undefined> {
    const known = wellKnownMailFolder(name);
    if (known) return this.folderId(known);
    const folder = name.trim();
    if (looksLikeFolderId(folder)) return `<t:FolderId Id="${escapeXml(folder)}"/>`;
    const data = await this.post(`
    <m:FindFolder Traversal="Deep">
      <m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>
      <m:Restriction>
        <t:IsEqualTo>
          <t:FieldURI FieldURI="folder:DisplayName"/>
          <t:FieldURIOrConstant><t:Constant Value="${escapeXml(folder)}"/></t:FieldURIOrConstant>
        </t:IsEqualTo>
      </m:Restriction>
      <m:ParentFolderIds>${this.folderId("msgfolderroot")}</m:ParentFolderIds>
    </m:FindFolder>`);
    const folders = dig(
      data,
      "Envelope",
      "Body",
      "FindFolderResponse",
      "ResponseMessages",
      "FindFolderResponseMessage",
      "RootFolder",
      "Folders",
    ) as Record<string, unknown> | undefined;
    const first = Object.values(folders ?? {}).flat()[0];
    const id = dig(first, "FolderId", "@_Id");
    return typeof id === "string" ? `<t:FolderId Id="${escapeXml(id)}"/>` : undefined;
  }

  private async requireFolder(name: string): Promise<string> {
    const ref = await this.folderRef(name);
    if (!ref) throw new Error(`Mail folder "${name}" not found in ${this.account}`);
    return ref;
  }

  /** Build DistinguishedFolderId XML, with Mailbox for shared mailboxes. */
  private folderId(folder: string): string {
    if (this.shared) {
      return `<t:DistinguishedFolderId Id="${escapeXml(folder)}"><t:Mailbox><t:EmailAddress>${escapeXml(this.account)}</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>`;
    }
    return `<t:DistinguishedFolderId Id="${escapeXml(folder)}"/>`;
  }

  private async post(body: string): Promise<unknown> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    const res = await fetchWithTimeout(EWS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/xml; charset=utf-8",
      },
      body: soap(body),
    });
    if (!res.ok) throw new Error(`EWS ${String(res.status)}: ${await res.text()}`);
    assertResponseSize(res);
    const xml = await res.text();
    return parser.parse(xml);
  }

  async listMessages(folder = "inbox", limit = 10): Promise<MailMessage[]> {
    const parent = await this.requireFolder(folder);
    const data = await this.post(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:ToRecipients"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${String(limit)}" Offset="0" BasePoint="Beginning"/>
      <m:SortOrder>
        <t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        ${parent}
      </m:ParentFolderIds>
    </m:FindItem>`);

    const messages = this.extractMessages(data);
    return messages.map((m) => this.mapMessage(m));
  }

  async getMessage(id: string): Promise<MailMessageFull> {
    const data = await this.post(`
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:BodyType>HTML</t:BodyType>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Body"/>
          <t:FieldURI FieldURI="item:Attachments"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:ToRecipients"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
          <t:FieldURI FieldURI="item:Subject"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:ItemIds>
        <t:ItemId Id="${escapeXml(id)}"/>
      </m:ItemIds>
    </m:GetItem>`);

    const messages = this.extractMessages(data);
    const m = messages[0];
    const msg = m
      ? this.mapMessage(m)
      : {
          id,
          account: this.account,
          subject: "",
          from: "",
          to: [],
          receivedAt: "",
          snippet: "",
          isRead: false,
        };

    const bodyNode = m ? dig(m, "Body") : undefined;
    const body = str(bodyNode);
    const bodyType =
      typeof bodyNode === "object" &&
      bodyNode !== null &&
      (bodyNode as Record<string, unknown>)["@_BodyType"] === "Text"
        ? ("text" as const)
        : ("html" as const);

    const fileAttachments = (m ? dig(m, "Attachments", "FileAttachment") : undefined) as
      Record<string, unknown>[] | undefined;
    const attachments: MailAttachment[] = (fileAttachments ?? []).map((a) => {
      const contentId = str(a.ContentId);
      return {
        id: str(dig(a, "AttachmentId", "@_Id")),
        name: str(a.Name),
        size: parseInt(str(a.Size) || "0", 10),
        contentType: str(a.ContentType) || "application/octet-stream",
        isInline: str(a.IsInline) === "true",
        ...(contentId ? { contentId } : {}),
      };
    });

    return { ...msg, body, bodyType, attachments };
  }

  /**
   * Headline metadata for a set of ids. EWS batches this natively: GetItem
   * accepts many ItemIds in one request, and IdOnly plus a short
   * AdditionalProperties list keeps bodies and attachments out of the response.
   */
  async getSummaries(ids: readonly string[]): Promise<MailMessage[]> {
    if (ids.length === 0) return [];
    const itemIds = ids.map((id) => `<t:ItemId Id="${escapeXml(id)}"/>`).join("");
    const data = await this.post(`
    <m:GetItem>
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="message:ToRecipients"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:ItemIds>${itemIds}</m:ItemIds>
    </m:GetItem>`);
    return this.extractMessages(data).map((m) => this.mapMessage(m));
  }

  async searchMessages(query: string, limit = 10, folder?: string): Promise<MailMessage[]> {
    if (hasFolder(folder)) {
      // A folder this mailbox does not have narrows the search to nothing.
      const parent = await this.folderRef(folder);
      return parent ? this.findInFolder(parent, query, limit) : [];
    }

    // EWS refuses a QueryString across several ParentFolderIds ("Shared folder
    // search cannot be performed on multiple folders"), and FindItem has no deep
    // traversal. A mailbox-wide search therefore runs one FindItem per mail
    // folder and keeps the newest matches. A folder that fails is skipped; the
    // search only fails when every folder does.
    const folderIds = await this.mailFolderIds();
    const parents = folderIds
      ? folderIds.map((id) => `<t:FolderId Id="${escapeXml(id)}"/>`)
      : [this.folderId("inbox")];
    const found: MailMessage[] = [];
    const errors: unknown[] = [];
    const queue = [...parents];
    const worker = async (): Promise<void> => {
      for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
        try {
          found.push(...(await this.findInFolder(parent, query, limit)));
        } catch (error) {
          errors.push(error);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FOLDER_SEARCH_CONCURRENCY, parents.length) }, () => worker()),
    );
    if (parents.length > 0 && errors.length === parents.length) throw errors[0];
    return found.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
  }

  /**
   * Ids of every mail folder below the message root (`IPF.Note` and its
   * subclasses, Deleted Items and Junk included). Undefined when the folder
   * tree cannot be read, as with a delegate that only has access to the inbox
   * of a shared mailbox; the caller then searches the inbox alone, which is
   * what it can reach.
   */
  private async mailFolderIds(): Promise<string[] | undefined> {
    let data: unknown;
    try {
      data = await this.post(`
    <m:FindFolder Traversal="Deep">
      <m:FolderShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties><t:FieldURI FieldURI="folder:FolderClass"/></t:AdditionalProperties>
      </m:FolderShape>
      <m:ParentFolderIds>${this.folderId("msgfolderroot")}</m:ParentFolderIds>
    </m:FindFolder>`);
    } catch {
      return undefined;
    }
    const response = dig(
      data,
      "Envelope",
      "Body",
      "FindFolderResponse",
      "ResponseMessages",
      "FindFolderResponseMessage",
    ) as Record<string, unknown> | undefined;
    if (!response || response["@_ResponseClass"] === "Error") return undefined;
    const folders = dig(response, "RootFolder", "Folders", "Folder");
    const list: unknown[] = Array.isArray(folders) ? folders : folders ? [folders] : [];
    const ids = list.flatMap((entry) => {
      const folderClass = str(dig(entry, "FolderClass"));
      const id = dig(entry, "FolderId", "@_Id");
      const isMail = folderClass === "IPF.Note" || folderClass.startsWith("IPF.Note.");
      return isMail && typeof id === "string" ? [id] : [];
    });
    return ids.length > 0 ? ids : undefined;
  }

  /** FindItem with a content-index query in one folder, newest first. */
  private async findInFolder(
    parentFolderId: string,
    query: string,
    limit: number,
  ): Promise<MailMessage[]> {
    const data = await this.post(`
    <m:FindItem Traversal="Shallow">
      <m:ItemShape>
        <t:BaseShape>IdOnly</t:BaseShape>
        <t:AdditionalProperties>
          <t:FieldURI FieldURI="item:Subject"/>
          <t:FieldURI FieldURI="message:From"/>
          <t:FieldURI FieldURI="item:DateTimeReceived"/>
          <t:FieldURI FieldURI="message:IsRead"/>
        </t:AdditionalProperties>
      </m:ItemShape>
      <m:IndexedPageItemView MaxEntriesReturned="${String(limit)}" Offset="0" BasePoint="Beginning"/>
      <m:SortOrder>
        <t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder>
      </m:SortOrder>
      <m:ParentFolderIds>
        ${parentFolderId}
      </m:ParentFolderIds>
      <m:QueryString>${escapeXml(query)}</m:QueryString>
    </m:FindItem>`);

    return this.extractMessages(data).map((m) => this.mapMessage(m));
  }

  async sendMessage(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt> {
    // EWS has no way to send a typed Message with attachments in one call, so
    // when attachments are present we save a draft, attach, then send it.
    if (opts?.attachments?.length) {
      const draft = await this.createDraft(to, subject, body, opts);
      await this.sendDraft(draft.id);
      return {};
    }
    const html = assembleHtml(body, this.signature);
    const ccXml = opts?.cc?.length
      ? `<t:CcRecipients>${opts.cc.map((addr) => `<t:Mailbox><t:EmailAddress>${escapeXml(addr)}</t:EmailAddress></t:Mailbox>`).join("")}</t:CcRecipients>`
      : "";
    const bccXml = opts?.bcc?.length
      ? `<t:BccRecipients>${opts.bcc.map((addr) => `<t:Mailbox><t:EmailAddress>${escapeXml(addr)}</t:EmailAddress></t:Mailbox>`).join("")}</t:BccRecipients>`
      : "";
    await this.post(`
    <m:CreateItem MessageDisposition="SendAndSaveCopy">
      <m:Items>
        <t:Message>
          <t:Subject>${escapeXml(subject)}</t:Subject>
          <t:Body BodyType="HTML">${escapeXml(html)}</t:Body>
          <t:ToRecipients>
            ${to.map((addr) => `<t:Mailbox><t:EmailAddress>${escapeXml(addr)}</t:EmailAddress></t:Mailbox>`).join("")}
          </t:ToRecipients>
          ${ccXml}${bccXml}
        </t:Message>
      </m:Items>
    </m:CreateItem>`);
    return {};
  }

  /**
   * Attach files to an existing draft via CreateAttachment. Each file becomes a
   * FileAttachment; the item's ChangeKey is bumped but SendItem-by-Id still works.
   */
  private async addAttachments(
    parentId: string,
    attachments: readonly OutgoingAttachment[],
  ): Promise<void> {
    const parts = attachments
      .map((a) => {
        const cid = a.cid
          ? `<t:IsInline>true</t:IsInline><t:ContentId>${escapeXml(a.cid)}</t:ContentId>`
          : "<t:IsInline>false</t:IsInline>";
        return `<t:FileAttachment>
          <t:Name>${escapeXml(a.filename)}</t:Name>
          <t:ContentType>${escapeXml(a.contentType ?? "application/octet-stream")}</t:ContentType>
          ${cid}
          <t:Content>${a.content.toString("base64")}</t:Content>
        </t:FileAttachment>`;
      })
      .join("");
    await this.post(`
    <m:CreateAttachment>
      <m:ParentItemId Id="${escapeXml(parentId)}"/>
      <m:Attachments>${parts}</m:Attachments>
    </m:CreateAttachment>`);
  }

  async createDraft(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<MailMessage> {
    const html = assembleHtml(body, this.signature);
    const ccXml = opts?.cc?.length
      ? `<t:CcRecipients>${opts.cc.map((addr) => `<t:Mailbox><t:EmailAddress>${escapeXml(addr)}</t:EmailAddress></t:Mailbox>`).join("")}</t:CcRecipients>`
      : "";
    const bccXml = opts?.bcc?.length
      ? `<t:BccRecipients>${opts.bcc.map((addr) => `<t:Mailbox><t:EmailAddress>${escapeXml(addr)}</t:EmailAddress></t:Mailbox>`).join("")}</t:BccRecipients>`
      : "";
    const xml = await this.post(`
    <m:CreateItem MessageDisposition="SaveOnly">
      <m:Items>
        <t:Message>
          <t:Subject>${escapeXml(subject)}</t:Subject>
          <t:Body BodyType="HTML">${escapeXml(html)}</t:Body>
          <t:ToRecipients>
            ${to.map((addr) => `<t:Mailbox><t:EmailAddress>${escapeXml(addr)}</t:EmailAddress></t:Mailbox>`).join("")}
          </t:ToRecipients>
          ${ccXml}${bccXml}
        </t:Message>
      </m:Items>
    </m:CreateItem>`);
    const id = this.extractCreatedItemId(xml);
    if (opts?.attachments?.length) {
      if (!id) throw new Error("EWS createDraft: could not resolve draft ItemId to attach files.");
      await this.addAttachments(id, opts.attachments);
    }
    return {
      id,
      account: this.account,
      subject,
      from: this.account,
      to,
      receivedAt: new Date().toISOString(),
      snippet: body.slice(0, 100),
      isRead: true,
    };
  }

  /** Pull the ItemId of a freshly created item from a CreateItem response. */
  private extractCreatedItemId(data: unknown): string {
    const body = dig(data, "Envelope", "Body") as Record<string, unknown> | undefined;
    if (!body) return "";
    for (const key of Object.keys(body)) {
      const items = dig(
        body[key],
        "ResponseMessages",
        "CreateItemResponseMessage",
        "Items",
        "Message",
      );
      const msg = Array.isArray(items) ? (items as unknown[])[0] : items;
      const idNode = dig(msg, "ItemId", "@_Id");
      if (idNode) return str(idNode);
    }
    return "";
  }

  async sendDraft(id: string): Promise<SendReceipt> {
    await this.post(`
    <m:SendItem SaveItemToFolder="true">
      <m:ItemIds>
        <t:ItemId Id="${escapeXml(id)}" />
      </m:ItemIds>
      <m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems" /></m:SavedItemFolderId>
    </m:SendItem>`);
    return {};
  }

  async replyToMessage(id: string, body: string, opts?: MailSendOpts): Promise<SendReceipt> {
    if (opts?.attachments?.length)
      throw new Error(
        "EWS tier: attachments on reply are not supported — send a new message with attachments, or create a draft.",
      );
    const html = assembleHtml(body, this.signature);
    await this.post(`
    <m:CreateItem MessageDisposition="SendAndSaveCopy">
      <m:Items>
        <t:ReplyToItem>
          <t:ReferenceItemId Id="${escapeXml(id)}"/>
          <t:NewBodyContent BodyType="HTML">${escapeXml(html)}</t:NewBodyContent>
        </t:ReplyToItem>
      </m:Items>
    </m:CreateItem>`);
    return {};
  }

  async forwardMessage(
    id: string,
    to: string[],
    body?: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt> {
    if (opts?.attachments?.length)
      throw new Error(
        "EWS tier: attachments on forward are not supported — send a new message with attachments, or create a draft.",
      );
    const toRecipients = to
      .map((addr) => `<t:Mailbox><t:EmailAddress>${escapeXml(addr)}</t:EmailAddress></t:Mailbox>`)
      .join("");
    await this.post(`
    <m:CreateItem MessageDisposition="SendAndSaveCopy">
      <m:Items>
        <t:ForwardItem>
          <t:ReferenceItemId Id="${escapeXml(id)}"/>
          <t:NewBodyContent BodyType="HTML">${escapeXml(assembleHtml(body ?? "", this.signature))}</t:NewBodyContent>
          <t:ToRecipients>${toRecipients}</t:ToRecipients>
        </t:ForwardItem>
      </m:Items>
    </m:CreateItem>`);
    return {};
  }

  async markRead(id: string, isRead: boolean): Promise<void> {
    await this.post(`
    <m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite">
      <m:ItemChanges>
        <t:ItemChange>
          <t:ItemId Id="${escapeXml(id)}"/>
          <t:Updates>
            <t:SetItemField>
              <t:FieldURI FieldURI="message:IsRead"/>
              <t:Message><t:IsRead>${String(isRead)}</t:IsRead></t:Message>
            </t:SetItemField>
          </t:Updates>
        </t:ItemChange>
      </m:ItemChanges>
    </m:UpdateItem>`);
  }

  async moveMessage(id: string, folder: string): Promise<void> {
    const target = await this.requireFolder(folder);
    await this.post(`
    <m:MoveItem>
      <m:ToFolderId>
        ${target}
      </m:ToFolderId>
      <m:ItemIds>
        <t:ItemId Id="${escapeXml(id)}"/>
      </m:ItemIds>
    </m:MoveItem>`);
  }

  async deleteMessage(id: string): Promise<void> {
    await this.post(`
    <m:DeleteItem DeleteType="MoveToDeletedItems">
      <m:ItemIds>
        <t:ItemId Id="${escapeXml(id)}"/>
      </m:ItemIds>
    </m:DeleteItem>`);
  }

  async downloadAttachment(_messageId: string, attachmentId: string): Promise<Buffer> {
    const data = await this.post(`
    <m:GetAttachment>
      <m:AttachmentIds>
        <t:AttachmentId Id="${escapeXml(attachmentId)}"/>
      </m:AttachmentIds>
    </m:GetAttachment>`);

    const content = str(
      dig(
        data,
        "Envelope",
        "Body",
        "GetAttachmentResponse",
        "ResponseMessages",
        "GetAttachmentResponseMessage",
        "Attachments",
        "FileAttachment",
        "Content",
      ),
    );
    if (!content) {
      // Try array form.
      const attachments = dig(
        data,
        "Envelope",
        "Body",
        "GetAttachmentResponse",
        "ResponseMessages",
        "GetAttachmentResponseMessage",
        "Attachments",
        "FileAttachment",
      ) as Record<string, unknown>[] | undefined;
      const first = attachments?.[0];
      if (first) return Buffer.from(str(first.Content), "base64");
      throw new Error("No attachment content found");
    }
    return Buffer.from(content, "base64");
  }

  /** Extract Message items from parsed EWS response. */
  private extractMessages(data: unknown): Record<string, unknown>[] {
    // Navigate: Envelope > Body > *Response > ResponseMessages > *ResponseMessage > RootFolder? > Items > Message
    const body = dig(data, "Envelope", "Body") as Record<string, unknown> | undefined;
    if (!body) return [];

    // Find the response messages (works for FindItem, GetItem, etc.). A GetItem
    // with several ItemIds answers with one *ResponseMessage per id, which the
    // parser turns into an array, so every entry has to be collected.
    const collected: Record<string, unknown>[] = [];
    for (const key of Object.keys(body)) {
      const response = body[key] as Record<string, unknown>;
      const responseMessages = dig(response, "ResponseMessages") as
        Record<string, unknown> | undefined;
      if (!responseMessages) continue;

      for (const rmKey of Object.keys(responseMessages)) {
        const entry = responseMessages[rmKey];
        const entries: unknown[] = Array.isArray(entry) ? entry : [entry];
        for (const candidate of entries) {
          if (!candidate || typeof candidate !== "object") continue;
          const rm = candidate as Record<string, unknown>;
          // FindItem has RootFolder > Items > Message
          const rootFolder = rm.RootFolder as Record<string, unknown> | undefined;
          const items = (rootFolder ? dig(rootFolder, "Items") : dig(rm, "Items")) as
            Record<string, unknown> | undefined;
          if (!items) continue;

          const messages = items.Message;
          if (Array.isArray(messages)) collected.push(...(messages as Record<string, unknown>[]));
          else if (messages && typeof messages === "object")
            collected.push(messages as Record<string, unknown>);
        }
      }
    }

    return collected;
  }

  private mapMessage(m: Record<string, unknown>): MailMessage {
    // Mailbox is always an array due to isArray config.
    const fromMailboxes = dig(m, "From", "Mailbox") as Record<string, unknown>[] | undefined;
    const fromAddr = fromMailboxes?.[0] ? str(fromMailboxes[0].EmailAddress) : "";

    const toMailboxes = dig(m, "ToRecipients", "Mailbox") as Record<string, unknown>[] | undefined;
    const toList = (toMailboxes ?? []).map((r) => str(r.EmailAddress));

    return {
      id: str(dig(m, "ItemId", "@_Id")),
      account: this.account,
      subject: str(m.Subject),
      from: fromAddr,
      to: toList,
      receivedAt: str(m.DateTimeReceived),
      snippet: str(m.Preview ?? m.BodyPreview ?? ""),
      isRead: str(m.IsRead) === "true",
    };
  }
}
