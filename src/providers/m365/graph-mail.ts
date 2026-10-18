import type {
  MailConnector,
  MailMessage,
  MailMessageFull,
  MailSendOpts,
  OutgoingAttachment,
  RawMailSubmitter,
  SendReceipt,
} from "../../types/index.js";
import { fetchWithExecutionContext as fetch } from "../../utils/execution-context.js";
import { hasFolder, looksLikeFolderId, wellKnownMailFolder } from "../../utils/mail-folders.js";
import { stripBccHeader } from "../../utils/mail-headers.js";
import { assembleHtml } from "../../utils/mail-html.js";
import { assertResponseSize, fetchWithTimeout } from "../../utils/security.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Graph rejects inline fileAttachment payloads above ~3MB; larger needs an upload session. */
const GRAPH_INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
/** Upload-session chunk size — must be a multiple of 320 KiB (and stay well under Graph's 4MB body cap). */
const GRAPH_UPLOAD_CHUNK = 5 * 320 * 1024; // 1.6 MiB

interface GraphAttachment {
  id?: string;
  name?: string;
  size?: number;
  contentType?: string;
  contentBytes?: string;
  isInline?: boolean;
  contentId?: string;
}

const isLargeAttachment = (a: OutgoingAttachment): boolean =>
  a.content.length >= GRAPH_INLINE_ATTACHMENT_LIMIT;

/** Serialize one outgoing attachment as a Graph inline `fileAttachment` resource (≤3MB). */
function graphFileAttachment(a: OutgoingAttachment): Record<string, unknown> {
  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: a.filename,
    contentType: a.contentType ?? "application/octet-stream",
    contentBytes: a.content.toString("base64"),
    ...(a.cid ? { isInline: true, contentId: a.cid } : {}),
  };
}

interface GraphMessage {
  id: string;
  subject: string;
  from?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  bodyPreview?: string;
  isRead?: boolean;
  body?: { contentType?: string; content?: string };
  attachments?: GraphAttachment[];
}

interface GraphDraftRecipients {
  from?: { emailAddress?: { address?: string } };
  sender?: { emailAddress?: { address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  ccRecipients?: { emailAddress?: { address?: string } }[];
  bccRecipients?: { emailAddress?: { address?: string } }[];
}

export class GraphMailConnector implements MailConnector {
  readonly tier = "graph";
  signature?: string;
  displayName?: string;

  /**
   * With a `submitter`, mail is sent over SMTP and Graph only reads and writes
   * the mailbox. Graph's own send actions need the `Mail.Send` permission,
   * which Thunderbird's app registration does not carry; Thunderbird itself
   * sends over SMTP, and so does this connector when it is given a submitter.
   */
  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
    private readonly shared = false,
    private readonly submitter?: RawMailSubmitter,
  ) {}

  private get base(): string {
    return this.shared ? `${GRAPH_BASE}/users/${this.account}` : `${GRAPH_BASE}/me`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  /**
   * Graph folder id for a name: well-known names become their distinguished
   * token, an opaque id passes through, anything else is looked up by display
   * name among the top-level folders. Undefined when no folder has that name.
   */
  private async folderRef(folder: string): Promise<string | undefined> {
    const known = wellKnownMailFolder(folder);
    if (known) return known;
    const name = folder.trim();
    if (looksLikeFolderId(name)) return name;
    const filter = encodeURIComponent(`displayName eq '${name.replace(/'/g, "''")}'`);
    const res = await fetch(`${this.base}/mailFolders?$filter=${filter}&$select=id&$top=1`, {
      headers: await this.headers(),
    });
    if (!res.ok) throw new Error(`Graph mailFolders: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: { id?: string }[] };
    return data.value[0]?.id;
  }

  private async requireFolder(folder: string): Promise<string> {
    const ref = await this.folderRef(folder);
    if (!ref) throw new Error(`Mail folder "${folder}" not found in ${this.account}`);
    return ref;
  }

  async listMessages(folder = "inbox", limit = 10): Promise<MailMessage[]> {
    const ref = await this.requireFolder(folder);
    const h = await this.headers();
    const url = `${this.base}/mailFolders/${encodeURIComponent(ref)}/messages?$top=${String(limit)}&$orderby=receivedDateTime desc&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph listMessages: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: GraphMessage[] };
    return data.value.map((m) => this.mapMessage(m));
  }

  async getMessage(id: string): Promise<MailMessageFull> {
    const h = await this.headers();
    const url = `${this.base}/messages/${encodeURIComponent(id)}?$expand=attachments`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph getMessage: ${String(res.status)} ${await res.text()}`);
    const m = (await res.json()) as GraphMessage;
    return {
      ...this.mapMessage(m),
      body: m.body?.content ?? "",
      bodyType: m.body?.contentType === "html" ? "html" : "text",
      attachments: (m.attachments ?? []).map((a) => ({
        id: a.id ?? "",
        name: a.name ?? "",
        size: a.size ?? 0,
        contentType: a.contentType ?? "application/octet-stream",
        isInline: a.isInline ?? false,
        ...(a.contentId ? { contentId: a.contentId } : {}),
      })),
    };
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const h = await this.headers();
    const url = `${this.base}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`;
    const res = await fetchWithTimeout(url, { headers: h });
    if (!res.ok)
      throw new Error(`Graph downloadAttachment: ${String(res.status)} ${await res.text()}`);
    assertResponseSize(res);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Headline metadata for a set of ids. Graph has no id-set filter, so this is
   * one request per id, but `$select` keeps each response tiny compared with
   * `getMessage`, which expands attachments. Concurrency is bounded so a large
   * bulk preview cannot open hundreds of sockets at once. Ids that no longer
   * resolve are skipped rather than failing the whole batch.
   */
  async getSummaries(ids: readonly string[]): Promise<MailMessage[]> {
    const h = await this.headers();
    const select = "$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead";
    const results: MailMessage[] = [];
    const queue = [...ids];
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        // Execution-context fetch so a cancelled tool call stops the sweep.
        const res = await fetch(`${this.base}/messages/${encodeURIComponent(id)}?${select}`, {
          headers: h,
        });
        if (!res.ok) continue;
        results.push(this.mapMessage((await res.json()) as GraphMessage));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, () => worker()));
    return results;
  }

  async searchMessages(query: string, limit = 10, folder?: string): Promise<MailMessage[]> {
    // `/messages` covers the whole mailbox; a folder's own messages collection
    // scopes `$search` to that folder. A folder this mailbox does not have
    // narrows the search to nothing here rather than failing it.
    let scope = "";
    if (hasFolder(folder)) {
      const ref = await this.folderRef(folder);
      if (!ref) return [];
      scope = `/mailFolders/${encodeURIComponent(ref)}`;
    }
    const h = await this.headers();
    const url = `${this.base}${scope}/messages?$search="${encodeURIComponent(query)}"&$top=${String(limit)}&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead`;
    const res = await fetch(url, { headers: h });
    if (!res.ok) throw new Error(`Graph searchMessages: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { value: GraphMessage[] };
    return data.value.map((m) => this.mapMessage(m));
  }

  async sendMessage(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt> {
    // The sendMail action can't carry >3MB attachments (they need an upload
    // session against a saved message), so route those via a draft + send.
    if (this.submitter || opts?.attachments?.some(isLargeAttachment)) {
      const draft = await this.createDraft(to, subject, body, opts);
      return this.sendDraft(draft.id);
    }
    const h = await this.headers();
    const html = assembleHtml(body, this.signature);
    const message: Record<string, unknown> = {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
    };
    if (opts?.cc?.length)
      message.ccRecipients = opts.cc.map((addr) => ({ emailAddress: { address: addr } }));
    if (opts?.bcc?.length)
      message.bccRecipients = opts.bcc.map((addr) => ({ emailAddress: { address: addr } }));
    if (opts?.attachments?.length)
      message.attachments = opts.attachments.map((a) => graphFileAttachment(a));
    const res = await fetch(`${this.base}/sendMail`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`Graph sendMessage: ${String(res.status)} ${await res.text()}`);
    return {};
  }

  async createDraft(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<MailMessage> {
    const h = await this.headers();
    const html = assembleHtml(body, this.signature);
    const message: Record<string, unknown> = {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
      isDraft: true,
    };
    if (opts?.cc?.length)
      message.ccRecipients = opts.cc.map((addr) => ({ emailAddress: { address: addr } }));
    if (opts?.bcc?.length)
      message.bccRecipients = opts.bcc.map((addr) => ({ emailAddress: { address: addr } }));
    // Small attachments ride along in the create call; large ones are uploaded
    // to the saved draft afterward via an upload session.
    const attachments = opts?.attachments ?? [];
    const large = attachments.filter(isLargeAttachment);
    const small = attachments.filter((a) => !isLargeAttachment(a));
    if (small.length) message.attachments = small.map((a) => graphFileAttachment(a));
    const res = await fetch(`${this.base}/messages`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(message),
    });
    if (!res.ok) throw new Error(`Graph createDraft: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as {
      id?: string;
      subject?: string;
      from?: { emailAddress?: { address?: string } };
      toRecipients?: { emailAddress?: { address?: string } }[];
      receivedDateTime?: string;
    };
    const id = data.id ?? "";
    for (const att of large) {
      if (!id)
        throw new Error("Graph createDraft: no draft id returned; cannot upload attachment.");
      await this.uploadLargeAttachment(id, att);
    }
    return {
      id,
      account: this.account,
      subject: data.subject ?? subject,
      from: this.account,
      to,
      receivedAt: data.receivedDateTime ?? new Date().toISOString(),
      snippet: body.slice(0, 100),
      isRead: true,
    };
  }

  /**
   * Attach a file larger than the inline limit to a saved message via a Graph
   * upload session: open the session, then PUT the bytes in 320-KiB-aligned
   * chunks. The upload URL is pre-authorized, so no auth header is sent on the PUTs.
   */
  private async uploadLargeAttachment(messageId: string, att: OutgoingAttachment): Promise<void> {
    const h = await this.headers();
    const total = att.content.length;
    const sessionRes = await fetch(
      `${this.base}/messages/${encodeURIComponent(messageId)}/attachments/createUploadSession`,
      {
        method: "POST",
        headers: h,
        body: JSON.stringify({
          AttachmentItem: {
            attachmentType: "file",
            name: att.filename,
            size: total,
            contentType: att.contentType ?? "application/octet-stream",
            ...(att.cid ? { isInline: true, contentId: att.cid } : {}),
          },
        }),
      },
    );
    if (!sessionRes.ok)
      throw new Error(
        `Graph createUploadSession: ${String(sessionRes.status)} ${await sessionRes.text()}`,
      );
    const { uploadUrl } = (await sessionRes.json()) as { uploadUrl?: string };
    if (!uploadUrl) throw new Error("Graph createUploadSession: no uploadUrl returned.");

    for (let start = 0; start < total; start += GRAPH_UPLOAD_CHUNK) {
      const end = Math.min(start + GRAPH_UPLOAD_CHUNK, total);
      const chunk = att.content.subarray(start, end);
      const putRes = await fetchWithTimeout(uploadUrl, {
        method: "PUT",
        headers: { "Content-Range": `bytes ${String(start)}-${String(end - 1)}/${String(total)}` },
        body: chunk,
      });
      if (!putRes.ok)
        throw new Error(
          `Graph attachment upload (${att.filename}): ${String(putRes.status)} ${await putRes.text()}`,
        );
    }
  }

  async sendDraft(id: string): Promise<SendReceipt> {
    if (this.submitter) return this.submitDraft(id, this.submitter);
    const h = await this.headers();
    const res = await fetch(`${this.base}/messages/${encodeURIComponent(id)}/send`, {
      method: "POST",
      headers: h,
    });
    if (!res.ok) throw new Error(`Graph sendDraft: ${String(res.status)} ${await res.text()}`);
    return {};
  }

  /**
   * Sends a saved draft over SMTP: read its recipients and its MIME form from
   * Graph, submit it, then remove the draft. The recipients come from the
   * message resource and not from the MIME header, because Bcc recipients
   * need to be in the envelope and must not be in the header.
   *
   * Removing the draft comes after delivery, so its failure is a warning and
   * never turns a delivered message into an error. Exchange Online files the
   * Sent copy itself when a message is submitted.
   */
  private async submitDraft(id: string, submitter: RawMailSubmitter): Promise<SendReceipt> {
    const h = await this.headers();
    const ref = encodeURIComponent(id);
    const metaRes = await fetch(
      `${this.base}/messages/${ref}?$select=from,sender,toRecipients,ccRecipients,bccRecipients`,
      { headers: h },
    );
    if (!metaRes.ok)
      throw new Error(`Graph readDraft: ${String(metaRes.status)} ${await metaRes.text()}`);
    const meta = (await metaRes.json()) as GraphDraftRecipients;
    const addressOf = (r: { emailAddress?: { address?: string } }): string =>
      r.emailAddress?.address ?? "";
    const to = [
      ...(meta.toRecipients ?? []),
      ...(meta.ccRecipients ?? []),
      ...(meta.bccRecipients ?? []),
    ]
      .map(addressOf)
      .filter((address) => address !== "");
    if (to.length === 0) throw new Error(`Graph sendDraft: draft ${id} has no recipients.`);
    const from = addressOf(meta.from ?? {}) || addressOf(meta.sender ?? {}) || this.account;

    const mimeRes = await fetch(`${this.base}/messages/${ref}/$value`, {
      headers: { Authorization: h.Authorization ?? "" },
    });
    if (!mimeRes.ok)
      throw new Error(`Graph readDraftMime: ${String(mimeRes.status)} ${await mimeRes.text()}`);
    const raw = stripBccHeader(Buffer.from(await mimeRes.arrayBuffer()));

    await submitter.submitRaw(raw, { from, to });

    try {
      await this.deleteMessage(id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { warning: `Sent, but the draft could not be removed: ${reason}` };
    }
    return {};
  }

  /** POST each attachment to an existing draft's attachments collection. */
  private async postAttachments(
    draftId: string,
    attachments: readonly OutgoingAttachment[],
  ): Promise<void> {
    const h = await this.headers();
    for (const att of attachments) {
      if (isLargeAttachment(att)) {
        await this.uploadLargeAttachment(draftId, att);
        continue;
      }
      const res = await fetch(`${this.base}/messages/${draftId}/attachments`, {
        method: "POST",
        headers: h,
        body: JSON.stringify(graphFileAttachment(att)),
      });
      if (!res.ok)
        throw new Error(`Graph addAttachment: ${String(res.status)} ${await res.text()}`);
    }
  }

  async replyToMessage(id: string, body: string, opts?: MailSendOpts): Promise<SendReceipt> {
    const h = await this.headers();
    // Create reply draft (Graph includes quoted original automatically)
    const r1 = await fetch(`${this.base}/messages/${encodeURIComponent(id)}/createReply`, {
      method: "POST",
      headers: h,
    });
    if (!r1.ok) throw new Error(`Graph createReply: ${String(r1.status)} ${await r1.text()}`);
    const draft = (await r1.json()) as { id: string; body?: { content?: string } };
    // Assemble HTML: our reply + signature + Graph's quoted original
    const html = assembleHtml(body, this.signature, draft.body?.content);
    // Update draft body
    const r2 = await fetch(`${this.base}/messages/${draft.id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ body: { contentType: "HTML", content: html } }),
    });
    if (!r2.ok) throw new Error(`Graph updateReply: ${String(r2.status)} ${await r2.text()}`);
    if (opts?.attachments?.length) await this.postAttachments(draft.id, opts.attachments);
    if (this.submitter) return this.sendDraft(draft.id);
    // Send
    const r3 = await fetch(`${this.base}/messages/${draft.id}/send`, {
      method: "POST",
      headers: h,
    });
    if (!r3.ok) throw new Error(`Graph sendReply: ${String(r3.status)} ${await r3.text()}`);
    return {};
  }

  async forwardMessage(
    id: string,
    to: string[],
    body?: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt> {
    const h = await this.headers();
    // Create forward draft (Graph includes original)
    const r1 = await fetch(`${this.base}/messages/${encodeURIComponent(id)}/createForward`, {
      method: "POST",
      headers: h,
    });
    if (!r1.ok) throw new Error(`Graph createForward: ${String(r1.status)} ${await r1.text()}`);
    const draft = (await r1.json()) as { id: string; body?: { content?: string } };
    const html = body
      ? assembleHtml(body, this.signature, draft.body?.content)
      : assembleHtml("", this.signature, draft.body?.content);
    // Update draft
    const r2 = await fetch(`${this.base}/messages/${draft.id}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({
        body: { contentType: "HTML", content: html },
        toRecipients: to.map((addr) => ({ emailAddress: { address: addr } })),
      }),
    });
    if (!r2.ok) throw new Error(`Graph updateForward: ${String(r2.status)} ${await r2.text()}`);
    if (opts?.attachments?.length) await this.postAttachments(draft.id, opts.attachments);
    if (this.submitter) return this.sendDraft(draft.id);
    // Send
    const r3 = await fetch(`${this.base}/messages/${draft.id}/send`, {
      method: "POST",
      headers: h,
    });
    if (!r3.ok) throw new Error(`Graph sendForward: ${String(r3.status)} ${await r3.text()}`);
    return {};
  }

  async markRead(id: string, isRead: boolean): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/messages/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: h,
      body: JSON.stringify({ isRead }),
    });
    if (!res.ok) throw new Error(`Graph markRead: ${String(res.status)} ${await res.text()}`);
  }

  async moveMessage(id: string, folder: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/messages/${encodeURIComponent(id)}/move`, {
      method: "POST",
      headers: h,
      body: JSON.stringify({ destinationId: await this.requireFolder(folder) }),
    });
    if (!res.ok) throw new Error(`Graph moveMessage: ${String(res.status)} ${await res.text()}`);
  }

  async deleteMessage(id: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${this.base}/messages/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: h,
    });
    if (!res.ok) throw new Error(`Graph deleteMessage: ${String(res.status)} ${await res.text()}`);
  }

  private mapMessage(m: GraphMessage): MailMessage {
    return {
      id: m.id,
      account: this.account,
      subject: m.subject,
      from: m.from?.emailAddress?.address ?? "",
      to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? ""),
      receivedAt: m.receivedDateTime ?? "",
      snippet: m.bodyPreview ?? "",
      isRead: m.isRead ?? false,
    };
  }
}
