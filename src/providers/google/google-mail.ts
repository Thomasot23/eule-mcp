import type {
  MailAttachment,
  MailConnector,
  MailMessage,
  MailMessageFull,
  MailSendOpts,
  SendReceipt,
} from "../../types/index.js";
import { fetchWithExecutionContext as fetch } from "../../utils/execution-context.js";
import {
  hasFolder,
  wellKnownMailFolder,
  type WellKnownMailFolder,
} from "../../utils/mail-folders.js";
import { assembleHtml } from "../../utils/mail-html.js";
import { buildMimeMessage } from "../../utils/mime-build.js";
import {
  assertNoHeaderInjection,
  assertResponseSize,
  assertSafeAddresses,
  fetchWithTimeout,
} from "../../utils/security.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

interface GmailMsg {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
  internalDate?: string;
}
interface GmailPayload {
  headers?: { name?: string; value?: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPayload[];
  mimeType?: string;
  filename?: string;
}
interface GmailListItem {
  id?: string;
  threadId?: string;
}

/** Gmail system label ids for the well-known folders. */
const FOLDER_LABELS: Partial<Record<WellKnownMailFolder, string>> = {
  inbox: "INBOX",
  sentitems: "SENT",
  drafts: "DRAFT",
  deleteditems: "TRASH",
  junkemail: "SPAM",
};

/** Gmail search operators for the well-known folders. Gmail has no outbox. */
const FOLDER_QUERIES: Partial<Record<WellKnownMailFolder, string>> = {
  inbox: "in:inbox",
  sentitems: "in:sent",
  drafts: "in:drafts",
  deleteditems: "in:trash",
  junkemail: "in:spam",
  // Archiving in Gmail only removes the inbox label, so the archive is
  // everything outside the system folders.
  archive: "-in:inbox -in:sent -in:drafts -in:spam -in:trash",
};

function folderLabel(folder: string): string {
  const known = wellKnownMailFolder(folder);
  return (known && FOLDER_LABELS[known]) ?? folder.toUpperCase();
}

function folderQuery(folder: string): string {
  const known = wellKnownMailFolder(folder);
  // The label: operator writes spaces in label names as hyphens.
  return (known && FOLDER_QUERIES[known]) ?? `label:${folder.trim().replace(/\s+/g, "-")}`;
}

export class GoogleMailConnector implements MailConnector {
  readonly tier = "google";
  signature?: string;
  displayName?: string;

  constructor(
    readonly account: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private get fromHeader(): string {
    const header = this.displayName ? `${this.displayName} <${this.account}>` : this.account;
    return assertNoHeaderInjection(header, "From");
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return { Authorization: `Bearer ${token}` };
  }

  async listMessages(folder = "inbox", limit = 10): Promise<MailMessage[]> {
    const h = await this.headers();
    const label = folderLabel(folder);
    const res = await fetch(`${BASE}/messages?labelIds=${label}&maxResults=${String(limit)}`, {
      headers: h,
    });
    if (!res.ok) throw new Error(`Gmail list: ${String(res.status)}`);
    const data = (await res.json()) as { messages?: GmailListItem[] };
    const msgs: MailMessage[] = [];
    for (const item of (data.messages ?? []).slice(0, limit)) {
      const msg = await this.fetchMsg(item.id ?? "", h);
      if (msg) msgs.push(this.mapSummary(msg));
    }
    return msgs;
  }

  async getMessage(id: string): Promise<MailMessageFull> {
    const h = await this.headers();
    const msg = await this.fetchMsg(id, h);
    if (!msg) throw new Error(`Message ${id} not found`);
    const body = extractBody(msg.payload);
    return {
      ...this.mapSummary(msg),
      body,
      bodyType: "html",
      attachments: extractAttachments(msg.payload),
    };
  }

  async searchMessages(query: string, limit = 10, folder?: string): Promise<MailMessage[]> {
    const h = await this.headers();
    // Without a folder the search covers the whole mailbox like every other
    // provider, spam and trash included; a folder narrows it through the
    // matching search operator.
    const q = hasFolder(folder) ? `(${query}) ${folderQuery(folder)}` : query;
    const res = await fetch(
      `${BASE}/messages?q=${encodeURIComponent(q)}&maxResults=${String(limit)}&includeSpamTrash=true`,
      { headers: h },
    );
    if (!res.ok) throw new Error(`Gmail search: ${String(res.status)}`);
    const data = (await res.json()) as { messages?: GmailListItem[] };
    const msgs: MailMessage[] = [];
    for (const item of (data.messages ?? []).slice(0, limit)) {
      const msg = await this.fetchMsg(item.id ?? "", h);
      if (msg) msgs.push(this.mapSummary(msg));
    }
    return msgs;
  }

  /**
   * Headline metadata for a set of ids. Gmail has no id-set endpoint, so this
   * is one request per id, but `format=metadata` with an explicit header list
   * returns just those headers instead of the full payload. Concurrency is
   * bounded; ids that no longer resolve are skipped.
   */
  async getSummaries(ids: readonly string[]): Promise<MailMessage[]> {
    const h = await this.headers();
    const query = "format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To";
    const results: MailMessage[] = [];
    const queue = [...ids];
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        // Execution-context fetch so a cancelled tool call stops the sweep.
        const res = await fetch(`${BASE}/messages/${encodeURIComponent(id)}?${query}`, {
          headers: h,
        });
        if (!res.ok) continue;
        results.push(this.mapSummary((await res.json()) as GmailMsg));
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, () => worker()));
    return results;
  }

  async sendMessage(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt> {
    const h = await this.headers();
    const mime = buildMimeMessage(
      {
        from: this.fromHeader,
        to: assertSafeAddresses(to, "To").join(", "),
        cc: opts?.cc?.length ? assertSafeAddresses(opts.cc, "Cc").join(", ") : undefined,
        bcc: opts?.bcc?.length ? assertSafeAddresses(opts.bcc, "Bcc").join(", ") : undefined,
        subject,
      },
      assembleHtml(body, this.signature),
      opts?.attachments,
    );
    const raw = Buffer.from(mime).toString("base64url");
    const res = await fetch(`${BASE}/messages/send`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`Gmail send: ${String(res.status)} ${await res.text()}`);
    return {};
  }

  async createDraft(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<MailMessage> {
    const h = await this.headers();
    const mime = buildMimeMessage(
      {
        from: this.fromHeader,
        to: assertSafeAddresses(to, "To").join(", "),
        cc: opts?.cc?.length ? assertSafeAddresses(opts.cc, "Cc").join(", ") : undefined,
        bcc: opts?.bcc?.length ? assertSafeAddresses(opts.bcc, "Bcc").join(", ") : undefined,
        subject,
      },
      assembleHtml(body, this.signature),
      opts?.attachments,
    );
    const raw = Buffer.from(mime).toString("base64url");
    const res = await fetch(`${BASE}/drafts`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { raw } }),
    });
    if (!res.ok) throw new Error(`Gmail createDraft: ${String(res.status)} ${await res.text()}`);
    const data = (await res.json()) as { id?: string; message?: { id?: string } };
    return {
      id: data.id ?? data.message?.id ?? "",
      account: this.account,
      subject,
      from: this.account,
      to,
      receivedAt: new Date().toISOString(),
      snippet: body.slice(0, 100),
      isRead: true,
    };
  }

  async sendDraft(id: string): Promise<SendReceipt> {
    const h = await this.headers();
    const res = await fetch(`${BASE}/drafts/send`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!res.ok) throw new Error(`Gmail sendDraft: ${String(res.status)} ${await res.text()}`);
    return {};
  }

  async replyToMessage(id: string, body: string, opts?: MailSendOpts): Promise<SendReceipt> {
    const h = await this.headers();
    const orig = await this.fetchMsg(id, h);
    if (!orig) throw new Error("Original not found");
    const from = assertNoHeaderInjection(getHeader(orig.payload, "From") ?? "", "To");
    const subject = getHeader(orig.payload, "Subject") ?? "";
    const msgId = getHeader(orig.payload, "Message-ID") ?? "";
    const mime = buildMimeMessage(
      {
        from: this.fromHeader,
        to: from,
        cc: opts?.cc?.length ? assertSafeAddresses(opts.cc, "Cc").join(", ") : undefined,
        bcc: opts?.bcc?.length ? assertSafeAddresses(opts.bcc, "Bcc").join(", ") : undefined,
        subject: `Re: ${subject}`,
        inReplyTo: msgId || undefined,
        references: msgId || undefined,
      },
      assembleHtml(body, this.signature),
      opts?.attachments,
    );
    const raw = Buffer.from(mime).toString("base64url");
    const res = await fetch(`${BASE}/messages/send`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ raw, threadId: orig.threadId }),
    });
    if (!res.ok) throw new Error(`Gmail reply: ${String(res.status)}`);
    return {};
  }

  async forwardMessage(
    id: string,
    to: string[],
    body?: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt> {
    const orig = await this.getMessage(id);
    const origBody = orig.bodyType === "html" ? orig.body : `<pre>${orig.body}</pre>`;
    const html = assembleHtml(
      body ?? "",
      this.signature,
      `<p><b>Von:</b> ${orig.from}<br><b>Betreff:</b> ${orig.subject}</p>${origBody}`,
    );
    const h = await this.headers();
    const mime = buildMimeMessage(
      {
        from: this.fromHeader,
        to: assertSafeAddresses(to, "To").join(", "),
        cc: opts?.cc?.length ? assertSafeAddresses(opts.cc, "Cc").join(", ") : undefined,
        bcc: opts?.bcc?.length ? assertSafeAddresses(opts.bcc, "Bcc").join(", ") : undefined,
        subject: `Fwd: ${orig.subject}`,
      },
      html,
      opts?.attachments,
    );
    const raw = Buffer.from(mime).toString("base64url");
    const res = await fetch(`${BASE}/messages/send`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`Gmail forward: ${String(res.status)}`);
    return {};
  }

  async markRead(id: string, isRead: boolean): Promise<void> {
    const h = await this.headers();
    const body = isRead ? { removeLabelIds: ["UNREAD"] } : { addLabelIds: ["UNREAD"] };
    const res = await fetch(`${BASE}/messages/${id}/modify`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Gmail markRead: ${String(res.status)}`);
  }

  async moveMessage(id: string, folder: string): Promise<void> {
    const h = await this.headers();
    const label = folderLabel(folder);
    const res = await fetch(`${BASE}/messages/${id}/modify`, {
      method: "POST",
      headers: { ...h, "Content-Type": "application/json" },
      body: JSON.stringify({ addLabelIds: [label] }),
    });
    if (!res.ok) throw new Error(`Gmail move: ${String(res.status)}`);
  }

  async deleteMessage(id: string): Promise<void> {
    const h = await this.headers();
    const res = await fetch(`${BASE}/messages/${id}/trash`, { method: "POST", headers: h });
    if (!res.ok) throw new Error(`Gmail delete: ${String(res.status)}`);
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const h = await this.headers();
    const res = await fetchWithTimeout(
      `${BASE}/messages/${messageId}/attachments/${attachmentId}`,
      {
        headers: h,
      },
    );
    if (!res.ok) throw new Error(`Gmail attachment: ${String(res.status)}`);
    assertResponseSize(res);
    const data = (await res.json()) as { data?: string };
    return Buffer.from(data.data ?? "", "base64url");
  }

  private async fetchMsg(id: string, h: Record<string, string>): Promise<GmailMsg | null> {
    const res = await fetch(`${BASE}/messages/${id}?format=full`, { headers: h });
    if (!res.ok) return null;
    return (await res.json()) as GmailMsg;
  }

  private mapSummary(msg: GmailMsg): MailMessage {
    const p = msg.payload;
    const epochMs = Number(msg.internalDate);
    return {
      id: msg.id ?? "",
      account: this.account,
      subject: getHeader(p, "Subject") ?? "",
      from: getHeader(p, "From") ?? "",
      to: (getHeader(p, "To") ?? "").split(",").map((s) => s.trim()),
      receivedAt: Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : "",
      snippet: msg.snippet ?? "",
      isRead: !(msg.labelIds ?? []).includes("UNREAD"),
    };
  }
}

function getHeader(payload: GmailPayload | undefined, name: string): string | undefined {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value;
}

function extractBody(payload: GmailPayload | undefined): string {
  if (!payload) return "";
  if (payload.body?.data) return Buffer.from(payload.body.data, "base64url").toString();
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/html" && part.body?.data)
      return Buffer.from(part.body.data, "base64url").toString();
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data)
      return Buffer.from(part.body.data, "base64url").toString();
  }
  return "";
}

/**
 * Walk the payload tree (Gmail nests attachments inside multipart/* parts) and
 * collect every part that carries an `attachmentId`. The id we surface is the
 * real Gmail `body.attachmentId`, which is exactly what `downloadAttachment`
 * feeds to `/messages/{id}/attachments/{attachmentId}`.
 */
function extractAttachments(payload: GmailPayload | undefined): MailAttachment[] {
  const result: MailAttachment[] = [];
  const walk = (part: GmailPayload | undefined): void => {
    if (!part) return;
    const attachmentId = part.body?.attachmentId;
    if (attachmentId) {
      const disposition = getHeader(part, "Content-Disposition") ?? "";
      const contentId = getHeader(part, "Content-ID")?.replace(/[<>]/g, "");
      result.push({
        id: attachmentId,
        name: part.filename ?? `attachment-${String(result.length + 1)}`,
        size: part.body?.size ?? 0,
        contentType: part.mimeType ?? "application/octet-stream",
        isInline: disposition.toLowerCase().includes("inline") || Boolean(contentId),
        ...(contentId ? { contentId } : {}),
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return result;
}
