import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { createTransport, type SendMailOptions, type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  hasFolder,
  wellKnownMailFolder,
  type WellKnownMailFolder,
} from "../../utils/mail-folders.js";
import { assembleHtml } from "../../utils/mail-html.js";
import { buildMimeMessage } from "../../utils/mime-build.js";
import {
  assertNoHeaderInjection,
  assertSafeAddresses,
  MAX_RESPONSE_BYTES,
} from "../../utils/security.js";
import type {
  MailAttachment,
  MailConnector,
  MailMessage,
  MailMessageFull,
  MailSendOpts,
  OutgoingAttachment,
  SendReceipt,
} from "../../types/index.js";

/** Map connector attachments to nodemailer's attachment shape. */
function nodemailerAttachments(
  attachments?: readonly OutgoingAttachment[],
): { filename: string; content: Buffer; contentType?: string; cid?: string }[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map((a) => ({
    filename: a.filename,
    content: a.content,
    contentType: a.contentType,
    ...(a.cid ? { cid: a.cid } : {}),
  }));
}

/** An imapflow bodyStructure node (loosely typed — the lib types are permissive). */
interface BodyStructureNode {
  part?: string;
  type?: string;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  size?: number;
  id?: string;
  childNodes?: BodyStructureNode[];
}

/** Walk a bodyStructure tree and collect attachment/inline parts with their part ids. */
function walkAttachments(node: BodyStructureNode | undefined, out: MailAttachment[]): void {
  if (!node) return;
  const disposition = node.disposition?.toLowerCase();
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name;
  if (node.part && (disposition === "attachment" || disposition === "inline" || filename)) {
    out.push({
      id: node.part,
      name: filename ?? `attachment-${String(out.length + 1)}`,
      size: node.size ?? 0,
      contentType: node.type ?? "application/octet-stream",
      isInline: disposition === "inline",
      ...(node.id ? { contentId: node.id.replace(/[<>]/g, "") } : {}),
    });
  }
  for (const child of node.childNodes ?? []) walkAttachments(child, out);
}

/**
 * IMAP UIDs are only unique within one mailbox, so a message id carries its
 * mailbox: `<encoded mailbox>/<uid>`. Encoding keeps a hierarchy delimiter in
 * the mailbox name from colliding with the separator.
 */
export function formatImapId(mailbox: string, uid: number): string {
  return `${encodeURIComponent(mailbox)}/${String(uid)}`;
}

/**
 * Splits an id from {@link formatImapId}. A bare UID means `defaultMailbox`, so
 * ids issued before ids carried their mailbox resolve where they always did.
 */
export function parseImapId(
  id: string,
  defaultMailbox = "INBOX",
): { mailbox: string; uid: number } {
  const slash = id.lastIndexOf("/");
  const uid = id.slice(slash + 1);
  let mailbox = defaultMailbox;
  if (slash >= 0) {
    try {
      mailbox = decodeURIComponent(id.slice(0, slash));
    } catch {
      mailbox = "";
    }
  }
  if (!/^\d+$/.test(uid) || mailbox === "") throw new Error(`Invalid IMAP message id: ${id}`);
  return { mailbox, uid: Number(uid) };
}

/** The headers of a parent message that decide how a reply threads. */
export interface ThreadSource {
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}

/** Upper bound on the ids a reply carries forward in References. */
const MAX_REFERENCES = 50;

/**
 * The msg-ids in a header value, in order. These values come from someone
 * else's message, so only well-formed `<...>` tokens survive: nothing with
 * whitespace or line breaks that could end the header line early.
 */
function messageIds(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? [];
}

/** One header's value from a raw header block, with folded lines joined. */
function headerValue(raw: Buffer | undefined, name: string): string | undefined {
  if (!raw) return undefined;
  const prefix = `${name.toLowerCase()}:`;
  return raw
    .toString("utf8")
    .replace(/\r?\n[ \t]+/g, " ")
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().startsWith(prefix))
    ?.slice(prefix.length)
    .trim();
}

/**
 * Threading headers for a reply, as RFC 5322 (section 3.6.4) specifies them.
 * In-Reply-To names the parent's Message-ID. References is the parent's
 * References, or else its In-Reply-To when that holds a single id, followed by
 * the parent's Message-ID. A very long chain keeps its root and the most
 * recent ancestors, which is what threading clients walk.
 */
export function replyThreadHeaders(parent: ThreadSource): {
  inReplyTo?: string;
  references?: string[];
} {
  const own = messageIds(parent.messageId)[0];
  const ancestors = messageIds(parent.references);
  const repliedTo = messageIds(parent.inReplyTo);
  const chain = ancestors.length > 0 ? ancestors : repliedTo.length === 1 ? repliedTo : [];
  const all = own ? [...chain, own] : chain;
  const references =
    all.length > MAX_REFERENCES ? [...all.slice(0, 1), ...all.slice(-(MAX_REFERENCES - 1))] : all;
  return {
    ...(own ? { inReplyTo: own } : {}),
    ...(references.length > 0 ? { references } : {}),
  };
}

/** Special-use flags (RFC 6154) of the well-known folders. */
const SPECIAL_USE: Partial<Record<WellKnownMailFolder, string>> = {
  archive: "\\Archive",
  sentitems: "\\Sent",
  drafts: "\\Drafts",
  deleteditems: "\\Trash",
  junkemail: "\\Junk",
};

/** Mailbox names tried when a server announces no special-use flag for them. */
const FALLBACK_MAILBOXES: Readonly<Record<"\\Sent" | "\\Drafts", readonly string[]>> = {
  "\\Sent": ["Sent Messages", "Sent", "Sent Items", "Gesendet", "Gesendete Objekte"],
  "\\Drafts": ["Drafts", "Entwürfe"],
};

/**
 * SMTP services that file every submitted message in Sent themselves. A copy
 * appended over IMAP would show up twice there.
 */
const SERVER_FILES_SENT = /(^|\.)(gmail\.com|googlemail\.com|office365\.com|outlook\.com)$/i;

export interface ImapConfig {
  account: string;
  host: string;
  port?: number;
  smtpHost: string;
  smtpPort?: number;
  /**
   * Append a copy of every sent message to the Sent mailbox. Defaults to true,
   * except for SMTP services that file sent mail themselves (Gmail, Microsoft).
   */
  saveSentCopy?: boolean;
  auth: "oauth" | "password";
  getToken?: () => Promise<string | null>;
  password?: string;
}

interface ImapSummary {
  uid: number;
  envelope?: {
    subject?: string;
    date?: Date;
    from?: { address?: string }[];
    to?: { address?: string }[];
  };
  flags?: Set<string>;
}

export class ImapMailConnector implements MailConnector {
  readonly tier = "imap";
  signature?: string;
  displayName?: string;

  constructor(
    readonly account: string,
    private readonly cfg: ImapConfig,
  ) {}

  private async connect(): Promise<ImapFlow> {
    const auth =
      this.cfg.auth === "oauth"
        ? { user: this.cfg.account, accessToken: await this.getTokenOrThrow() }
        : { user: this.cfg.account, pass: this.cfg.password ?? "" };

    const client = new ImapFlow({
      host: this.cfg.host,
      port: this.cfg.port ?? 993,
      secure: true,
      auth,
      logger: false,
    });
    await client.connect();
    return client;
  }

  private async getTokenOrThrow(): Promise<string> {
    if (!this.cfg.getToken) throw new Error(`No token provider for ${this.account}`);
    const token = await this.cfg.getToken();
    if (!token) throw new Error(`No token for ${this.account}`);
    return token;
  }

  private mapSummary(message: ImapSummary, mailbox: string): MailMessage {
    return {
      id: formatImapId(mailbox, message.uid),
      account: this.account,
      subject: message.envelope?.subject ?? "",
      from: message.envelope?.from?.[0]?.address ?? "",
      to: (message.envelope?.to ?? []).map((address) => address.address ?? ""),
      receivedAt: message.envelope?.date?.toISOString() ?? "",
      snippet: "",
      isRead: message.flags?.has("\\Seen") ?? false,
    };
  }

  /**
   * Mailbox path for a folder name. Well-known names ("Archiv", "Sent Items",
   * "Papierkorb") resolve through the server's special-use flags, so the same
   * name works on every provider; any other name is taken as the path.
   */
  private async resolveMailbox(client: ImapFlow, folder: string): Promise<string> {
    const known = wellKnownMailFolder(folder);
    if (known === "inbox") return "INBOX";
    const specialUse = known && SPECIAL_USE[known];
    if (!specialUse) return folder;
    const mailboxes = await client.list();
    return mailboxes.find((box) => box.specialUse === specialUse)?.path ?? folder;
  }

  /**
   * Mailbox carrying a special-use flag (`\\Sent`, `\\Drafts`). Servers name these
   * differently (iCloud "Sent Messages", Dovecot "Sent"), so the flag decides;
   * without one, the first existing mailbox with a common name wins.
   */
  private async specialMailbox(client: ImapFlow, use: "\\Sent" | "\\Drafts"): Promise<string> {
    const mailboxes = await client.list();
    const flagged = mailboxes.find((box) => box.specialUse === use);
    if (flagged) return flagged.path;
    const candidates = FALLBACK_MAILBOXES[use];
    const byName = candidates.find((name) =>
      mailboxes.some((box) => box.path.toLowerCase() === name.toLowerCase()),
    );
    const fallback = byName ?? candidates[0];
    if (!fallback) throw new Error(`No ${use} mailbox`);
    return (
      mailboxes.find((box) => box.path.toLowerCase() === fallback.toLowerCase())?.path ?? fallback
    );
  }

  /**
   * Mailboxes a search without a folder covers: every selectable one. A `\All`
   * mailbox (Gmail's "All Mail") already holds every other message, so where
   * one exists only it, junk and trash are searched, which avoids duplicates.
   */
  private async searchableMailboxes(client: ImapFlow): Promise<string[]> {
    const selectable = (await client.list()).filter(
      (box) => !box.flags.has("\\Noselect") && !box.flags.has("\\NonExistent"),
    );
    if (selectable.some((box) => box.specialUse === "\\All")) {
      const covering = new Set(["\\All", "\\Junk", "\\Trash"]);
      return selectable
        .filter((box) => box.specialUse !== undefined && covering.has(box.specialUse))
        .map((box) => box.path);
    }
    return selectable.map((box) => box.path);
  }

  async listMessages(folder = "INBOX", limit = 10): Promise<MailMessage[]> {
    const client = await this.connect();
    try {
      const path = await this.resolveMailbox(client, folder);
      const lock = await client.getMailboxLock(path);
      try {
        const messages: MailMessage[] = [];
        const mailbox = client.mailbox;
        const total = mailbox && typeof mailbox === "object" ? mailbox.exists : 0;
        const from = Math.max(1, total - limit + 1);

        for await (const raw of client.fetch(`${String(from)}:*`, {
          envelope: true,
          flags: true,
        })) {
          messages.push(this.mapSummary(raw, path));
        }
        return messages.reverse();
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async getMessage(id: string): Promise<MailMessageFull> {
    return (await this.fetchFull(id)).message;
  }

  /** The full message, plus the headers a reply needs to thread, in one fetch. */
  private async fetchFull(id: string): Promise<{ message: MailMessageFull; thread: ThreadSource }> {
    const { mailbox, uid } = parseImapId(id);
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const raw = await client.fetchOne(
          String(uid),
          {
            envelope: true,
            flags: true,
            source: true,
            bodyStructure: true,
            headers: ["references"],
          },
          { uid: true },
        );
        if (!raw) throw new Error(`Message ${id} not found`);
        const msg = raw as {
          uid: number;
          source?: Buffer;
          headers?: Buffer;
          bodyStructure?: BodyStructureNode;
          envelope?: {
            subject?: string;
            date?: Date;
            from?: { address?: string }[];
            to?: { address?: string }[];
            messageId?: string;
            inReplyTo?: string;
          };
          flags?: Set<string>;
        };
        const body = msg.source?.toString() ?? "";
        const bodyStart = body.indexOf("\r\n\r\n");
        const textBody = bodyStart >= 0 ? body.slice(bodyStart + 4) : "";

        const attachments: MailAttachment[] = [];
        walkAttachments(msg.bodyStructure, attachments);

        return {
          message: {
            id: formatImapId(mailbox, msg.uid),
            account: this.account,
            subject: msg.envelope?.subject ?? "",
            from: msg.envelope?.from?.[0]?.address ?? "",
            to: (msg.envelope?.to ?? []).map((a) => a.address ?? ""),
            receivedAt: msg.envelope?.date?.toISOString() ?? "",
            snippet: textBody.slice(0, 200),
            isRead: msg.flags?.has("\\Seen") ?? false,
            body: textBody,
            bodyType: "text",
            attachments,
          },
          thread: {
            messageId: msg.envelope?.messageId,
            inReplyTo: msg.envelope?.inReplyTo,
            references: headerValue(msg.headers, "references"),
          },
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const { mailbox, uid } = parseImapId(messageId);
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(mailbox);
      try {
        const part = await client.download(String(uid), attachmentId, { uid: true });
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of part.content) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          total += buf.length;
          // No Content-Length on a streamed IMAP part — cap as bytes arrive.
          if (total > MAX_RESPONSE_BYTES) {
            throw new Error(`Attachment exceeds the ${String(MAX_RESPONSE_BYTES)}-byte limit.`);
          }
          chunks.push(buf);
        }
        return Buffer.concat(chunks);
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async searchMessages(query: string, limit = 10, folder?: string): Promise<MailMessage[]> {
    const client = await this.connect();
    try {
      if (hasFolder(folder)) {
        const mailbox = await this.resolveMailbox(client, folder);
        return await this.searchMailbox(client, mailbox, query, limit);
      }
      // Without a folder every searchable mailbox is searched and the newest
      // matches win. A mailbox that cannot be opened is skipped; the search
      // only fails when none can.
      const mailboxes = await this.searchableMailboxes(client);
      const found: MailMessage[] = [];
      const errors: unknown[] = [];
      for (const mailbox of mailboxes) {
        try {
          found.push(...(await this.searchMailbox(client, mailbox, query, limit)));
        } catch (error) {
          errors.push(error);
        }
      }
      if (mailboxes.length > 0 && errors.length === mailboxes.length) throw errors[0];
      return found.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, limit);
    } finally {
      await client.logout();
    }
  }

  /** The newest `limit` matches in one mailbox, newest first. */
  private async searchMailbox(
    client: ImapFlow,
    mailbox: string,
    query: string,
    limit: number,
  ): Promise<MailMessage[]> {
    const lock = await client.getMailboxLock(mailbox);
    try {
      // SEARCH returns ascending UIDs. Fetching the search expression directly
      // and stopping at `limit` therefore returned the oldest matches and could
      // hide current-year mail behind a full page of historical results.
      const matches = await client.search({ text: query }, { uid: true });
      if (!matches || matches.length === 0) return [];

      const latestUids = [...matches].sort((a, b) => a - b).slice(-limit);
      const byUid = new Map<number, MailMessage>();
      for await (const raw of client.fetch(
        latestUids,
        { envelope: true, flags: true },
        { uid: true },
      )) {
        const message = raw as ImapSummary;
        byUid.set(message.uid, this.mapSummary(message, mailbox));
      }

      return [...latestUids]
        .reverse()
        .map((uid) => byUid.get(uid))
        .filter((message): message is MailMessage => message !== undefined);
    } finally {
      lock.release();
    }
  }

  private get fromAddress(): string {
    const header = this.displayName ? `${this.displayName} <${this.account}>` : this.account;
    return assertNoHeaderInjection(header, "From");
  }

  /**
   * Builds an SMTP transport that refuses to fall back to cleartext:
   * implicit TLS on 465, STARTTLS elsewhere, and `requireTLS` so a MITM that
   * strips the STARTTLS capability cannot downgrade the auth exchange.
   */
  private async makeTransport(): Promise<Transporter> {
    const auth =
      this.cfg.auth === "oauth"
        ? {
            type: "OAuth2" as const,
            user: this.cfg.account,
            accessToken: await this.getTokenOrThrow(),
          }
        : { user: this.cfg.account, pass: this.cfg.password ?? "" };
    const port = this.cfg.smtpPort ?? 587;
    return createTransport({
      host: this.cfg.smtpHost,
      port,
      secure: port === 465,
      requireTLS: true,
      auth,
    });
  }

  private get savesSentCopy(): boolean {
    return this.cfg.saveSentCopy ?? !SERVER_FILES_SENT.test(this.cfg.smtpHost);
  }

  /**
   * Sends over SMTP, then files the same message in Sent. Message-ID and Date
   * are fixed up front so the filed copy is the message the recipients got;
   * unlike the submitted one it keeps the Bcc header, as mail clients do.
   * Filing happens after delivery, so its failure is reported as a warning
   * and never turns a delivered message into an error.
   */
  private async deliver(mail: SendMailOptions): Promise<SendReceipt> {
    const domain = this.account.split("@")[1] ?? "localhost";
    const message: SendMailOptions = {
      ...mail,
      messageId: `<${randomUUID()}@${domain}>`,
      date: new Date(),
    };
    const transport = await this.makeTransport();
    try {
      await transport.sendMail(message);
    } finally {
      transport.close();
    }
    if (!this.savesSentCopy) return {};
    const node = new MailComposer(message).compile();
    node.keepBcc = true;
    return this.fileSent(await node.build());
  }

  private async fileSent(raw: Buffer | string): Promise<SendReceipt> {
    try {
      const client = await this.connect();
      try {
        const mailbox = await this.specialMailbox(client, "\\Sent");
        await client.append(mailbox, raw, ["\\Seen"]);
        return {};
      } finally {
        await client.logout();
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { warning: `Sent, but the copy could not be saved to the Sent folder: ${reason}` };
    }
  }

  async sendMessage(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt> {
    return this.deliver({
      from: this.fromAddress,
      to: assertSafeAddresses(to, "To").join(", "),
      cc: opts?.cc && assertSafeAddresses(opts.cc, "Cc").join(", "),
      bcc: opts?.bcc && assertSafeAddresses(opts.bcc, "Bcc").join(", "),
      subject,
      html: assembleHtml(body, this.signature),
      attachments: nodemailerAttachments(opts?.attachments),
    });
  }

  async replyToMessage(id: string, body: string, opts?: MailSendOpts): Promise<SendReceipt> {
    const { message: original, thread } = await this.fetchFull(id);
    return this.deliver({
      from: this.fromAddress,
      to: assertNoHeaderInjection(original.from, "To"),
      cc: opts?.cc && assertSafeAddresses(opts.cc, "Cc").join(", "),
      bcc: opts?.bcc && assertSafeAddresses(opts.bcc, "Bcc").join(", "),
      subject: `Re: ${original.subject}`,
      html: assembleHtml(body, this.signature),
      ...replyThreadHeaders(thread),
      attachments: nodemailerAttachments(opts?.attachments),
    });
  }

  async forwardMessage(
    id: string,
    to: string[],
    body?: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt> {
    // A forward starts a new conversation for its recipients, so unlike a reply
    // it carries neither In-Reply-To nor References.
    const original = await this.getMessage(id);
    return this.deliver({
      from: this.fromAddress,
      to: assertSafeAddresses(to, "To").join(", "),
      cc: opts?.cc && assertSafeAddresses(opts.cc, "Cc").join(", "),
      bcc: opts?.bcc && assertSafeAddresses(opts.bcc, "Bcc").join(", "),
      subject: `Fwd: ${original.subject}`,
      html: assembleHtml(
        body ?? "",
        this.signature,
        `<p><b>Von:</b> ${original.from}<br><b>Betreff:</b> ${original.subject}</p><pre>${original.body}</pre>`,
      ),
      attachments: nodemailerAttachments(opts?.attachments),
    });
  }

  async createDraft(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<MailMessage> {
    const mime = buildMimeMessage(
      {
        from: this.fromAddress,
        to: assertSafeAddresses(to, "To").join(", "),
        cc: opts?.cc?.length ? assertSafeAddresses(opts.cc, "Cc").join(", ") : undefined,
        bcc: opts?.bcc?.length ? assertSafeAddresses(opts.bcc, "Bcc").join(", ") : undefined,
        subject,
      },
      assembleHtml(body, this.signature),
      opts?.attachments,
    );
    const client = await this.connect();
    try {
      const drafts = await this.specialMailbox(client, "\\Drafts");
      const result = await client.append(drafts, Buffer.from(mime), ["\\Draft", "\\Seen"]);
      const uid =
        result && typeof result === "object"
          ? Number((result as unknown as Record<string, unknown>).uid) || 0
          : 0;
      return {
        id: uid ? formatImapId(drafts, uid) : "",
        account: this.account,
        subject,
        from: this.account,
        to,
        receivedAt: new Date().toISOString(),
        snippet: body.slice(0, 100),
        isRead: true,
      };
    } finally {
      await client.logout();
    }
  }

  async sendDraft(id: string): Promise<SendReceipt> {
    const { mailbox, uid } = parseImapId(id, "Drafts");
    const client = await this.connect();
    let raw: Buffer;
    try {
      await client.mailboxOpen(mailbox);
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || typeof msg !== "object" || !("source" in msg) || !msg.source)
        throw new Error(`Draft ${id} not found`);
      raw = msg.source;

      const transport = await this.makeTransport();
      try {
        await transport.sendMail({ envelope: false as never, raw });
      } finally {
        transport.close();
      }

      // Delivered: the draft is spent whether or not the Sent copy works out.
      await client.messageFlagsAdd(String(uid), ["\\Deleted"], { uid: true });
      await client.messageDelete(String(uid), { uid: true });
    } finally {
      await client.logout();
    }
    return this.savesSentCopy ? this.fileSent(raw) : {};
  }

  /**
   * Envelope-only lookup for a set of ids. IMAP batches this natively: one
   * FETCH per mailbox over its UID set, no bodies. Each summary keeps the id
   * it was asked for, so callers can match them up; ids that are malformed or
   * whose mailbox cannot be opened are omitted.
   */
  async getSummaries(ids: readonly string[]): Promise<MailMessage[]> {
    const byMailbox = new Map<string, Map<number, string>>();
    for (const id of ids) {
      let parsed: { mailbox: string; uid: number };
      try {
        parsed = parseImapId(id);
      } catch {
        continue;
      }
      const uids = byMailbox.get(parsed.mailbox) ?? new Map<number, string>();
      uids.set(parsed.uid, id);
      byMailbox.set(parsed.mailbox, uids);
    }
    if (byMailbox.size === 0) return [];
    const client = await this.connect();
    try {
      const results: MailMessage[] = [];
      for (const [mailbox, uids] of byMailbox) {
        let lock: { release: () => void };
        try {
          lock = await client.getMailboxLock(mailbox);
        } catch {
          continue;
        }
        try {
          for await (const raw of client.fetch(
            [...uids.keys()],
            { envelope: true, flags: true },
            { uid: true },
          )) {
            const message = raw as ImapSummary;
            results.push({
              ...this.mapSummary(message, mailbox),
              id: uids.get(message.uid) ?? formatImapId(mailbox, message.uid),
            });
          }
        } finally {
          lock.release();
        }
      }
      return results;
    } finally {
      await client.logout();
    }
  }

  async markRead(id: string, isRead: boolean): Promise<void> {
    const { mailbox, uid } = parseImapId(id);
    const client = await this.connect();
    try {
      const lock = await client.getMailboxLock(mailbox);
      try {
        await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        if (!isRead) await client.messageFlagsRemove(String(uid), ["\\Seen"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async moveMessage(id: string, folder: string): Promise<void> {
    const { mailbox, uid } = parseImapId(id);
    const client = await this.connect();
    try {
      const target = await this.resolveMailbox(client, folder);
      const lock = await client.getMailboxLock(mailbox);
      try {
        await client.messageMove(String(uid), target, { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  /**
   * Resolves the mailbox that acts as the trash, preferring the server's
   * declared `\Trash` special-use folder and falling back to the names in
   * common use. Returns undefined when the server offers no trash at all.
   */
  private async trashMailbox(client: ImapFlow): Promise<string | undefined> {
    const mailboxes = await client.list();
    const special = mailboxes.find((box) => box.specialUse === "\\Trash");
    if (special) return special.path;
    const candidates = new Set([
      "trash",
      "deleted messages",
      "deleted items",
      "inbox.trash",
      "papierkorb",
      "gelöschte elemente",
    ]);
    return mailboxes.find((box) => candidates.has(box.path.toLowerCase()))?.path;
  }

  async deleteMessage(id: string): Promise<void> {
    const { mailbox, uid } = parseImapId(id);
    const client = await this.connect();
    try {
      // Move to the trash rather than only setting \Deleted. The flag leaves the
      // message in place, hidden by most clients and still exposed to an EXPUNGE
      // from any other session, which is neither visible nor reliably
      // recoverable. Only if the server has no trash at all do we fall back to
      // the flag, and then we say so.
      const trash = await this.trashMailbox(client);
      // Already in the trash: deleting never purges, so there is nothing to do.
      if (trash === mailbox) return;
      const lock = await client.getMailboxLock(mailbox);
      try {
        if (trash) {
          await client.messageMove(String(uid), trash, { uid: true });
          return;
        }
        await client.messageFlagsAdd(String(uid), ["\\Deleted"], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }
}
