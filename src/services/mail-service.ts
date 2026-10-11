import { randomUUID } from "node:crypto";
import type { ConnectorRegistry } from "../connectors/index.js";
import type {
  MailConnector,
  MailMessage,
  MailMessageFull,
  MailSendOpts,
  SendReceipt,
} from "../types/index.js";
import { hasFolder } from "../utils/mail-folders.js";
import { resolveAttachmentPaths } from "../utils/outgoing-attachments.js";
import { assertNoHeaderInjection } from "../utils/security.js";
import {
  collectProviderResults,
  requireConnector,
  type ProviderFailure,
} from "./provider-orchestration.js";

const MAX_RECIPIENTS = 100;
const MAX_ATTACHMENTS = 20;
/**
 * Ceiling for one `mail_update` call. High enough to clear a real inbox backlog
 * in a few calls, low enough that a mistaken id list stays reviewable and a
 * single call cannot run for minutes against a slow provider.
 */
const MAX_UPDATE_BATCH = 200;

/**
 * Above this many matches a bulk action needs an extra explicit acknowledgement.
 * A too-broad filter is the realistic failure here, and it goes wrong quietly
 * and in breadth, unlike a single mistaken id.
 */
const BULK_ACK_THRESHOLD = 50;
/** How long a preview stays confirmable. Long enough to read, short enough not to go stale. */
const BULK_PREVIEW_TTL_MS = 15 * 60 * 1000;

/** One message pinned by a preview, kept so the action can name what it touched. */
export interface BulkTarget {
  readonly id: string;
  readonly account: string;
  readonly subject: string;
  readonly from: string;
}

export interface BulkPreview {
  readonly token: string;
  readonly targets: BulkTarget[];
  readonly failures: ProviderFailure[];
  /** True when the caller must also pass acknowledgeLarge to proceed. */
  readonly needsAcknowledgement: boolean;
  readonly expiresAt: number;
}

/** Per-message result of a bulk update, carrying enough to spot a wrong target. */
export interface MailUpdateOutcome {
  readonly id: string;
  readonly subject?: string;
  readonly from?: string;
  readonly actions: string[];
  readonly error?: string;
}

export function parseRecipients(value: string | undefined, required = false): string[] | undefined {
  const recipients =
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  if (required && recipients.length === 0) throw new Error("At least one recipient is required");
  if (recipients.length > MAX_RECIPIENTS)
    throw new Error(`At most ${String(MAX_RECIPIENTS)} recipients are allowed per field`);
  for (const recipient of recipients) {
    assertNoHeaderInjection(recipient, "recipient");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))
      throw new Error(`Invalid email address: ${recipient}`);
  }
  return recipients.length ? recipients : undefined;
}

export interface MailSendInput {
  readonly to: string;
  readonly subject?: string;
  readonly body: string;
  readonly role?: string;
  readonly account?: string;
  readonly replyTo?: string;
  readonly forwardId?: string;
  readonly signature?: boolean;
  readonly cc?: string;
  readonly bcc?: string;
  readonly attachments?: readonly string[];
  readonly idempotencyKey?: string;
}

export class MailService {
  private readonly connectorLocks = new WeakMap<MailConnector, Promise<void>>();
  private readonly idempotency = new Map<
    string,
    { promise: Promise<string>; createdAt: number; fingerprint: string }
  >();
  private readonly draftSubmissionIdempotency = new Map<
    string,
    { promise: Promise<string | undefined>; createdAt: number }
  >();
  /** Pinned bulk previews, keyed by the token handed back to the caller. */
  private readonly bulkPreviews = new Map<
    string,
    { targets: BulkTarget[]; createdAt: number; fingerprint: string }
  >();
  constructor(private readonly registry: ConnectorRegistry) {}

  async list(
    role?: string,
    folder = "inbox",
    limit = 10,
  ): Promise<{ messages: MailMessage[]; failures: ProviderFailure[] }> {
    const result = await collectProviderResults(this.registry.getMailConnectors(role), (c) =>
      c.listMessages(folder, limit),
    );
    result.values.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return { messages: result.values, failures: result.failures };
  }
  async search(
    query: string,
    role?: string,
    folder?: string,
    limit = 10,
  ): Promise<{ messages: MailMessage[]; failures: ProviderFailure[] }> {
    const result = await collectProviderResults(this.registry.getMailConnectors(role), (c) =>
      c.searchMessages(query, limit, folder),
    );
    result.values.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return { messages: result.values, failures: result.failures };
  }
  async read(id: string, account: string, role?: string): Promise<MailMessageFull> {
    const connector = this.registry.getMailConnectorForAccount(account, role);
    if (!connector) throw new Error(`No connector for ${account}`);
    return connector.getMessage(id);
  }
  async send(input: MailSendInput): Promise<string> {
    if (input.replyTo && input.forwardId)
      throw new Error("reply_to and forward_id are mutually exclusive");
    const operation = async (): Promise<string> => {
      // The registry lookup prefers a personal mailbox over a shared one with the
      // same auth account; requireConnector only supplies the error with the
      // accounts that would have been accepted.
      const connector =
        (input.account
          ? this.registry.getMailConnectorForAccount(input.account, input.role, "write")
          : undefined) ??
        requireConnector(
          this.registry.getMailConnectors(input.role, "write"),
          input.account,
          "mail",
        );
      const to = parseRecipients(input.to, !input.replyTo) ?? [];
      const options = this.sendOptions(input);
      const attachmentNote = options.attachments?.length
        ? ` with ${String(options.attachments.length)} attachment(s)`
        : "";
      return this.withSignature(connector, input.signature !== false, async () => {
        if (input.replyTo) {
          const receipt = await connector.replyToMessage(input.replyTo, input.body, options);
          return withWarning(`✅ Reply sent from ${connector.account}${attachmentNote}`, receipt);
        }
        if (input.forwardId) {
          const receipt = await connector.forwardMessage(input.forwardId, to, input.body, options);
          return withWarning(
            `✅ Forwarded from ${connector.account} to ${input.to}${attachmentNote}`,
            receipt,
          );
        }
        const receipt = await connector.sendMessage(
          to,
          input.subject ?? "(no subject)",
          input.body,
          options,
        );
        return withWarning(
          `✅ Sent from ${connector.account} to ${input.to}${attachmentNote}`,
          receipt,
        );
      });
    };
    if (!input.idempotencyKey) return operation();
    this.pruneIdempotency();
    const fingerprint = JSON.stringify({ ...input, idempotencyKey: undefined });
    const existing = this.idempotency.get(input.idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("Idempotency key was already used for a different mail command");
      return existing.promise;
    }
    const pending = operation();
    this.idempotency.set(input.idempotencyKey, {
      promise: pending,
      createdAt: Date.now(),
      fingerprint,
    });
    try {
      return await pending;
    } catch (error) {
      this.idempotency.delete(input.idempotencyKey);
      throw error;
    }
  }
  async draft(input: MailSendInput): Promise<MailMessage> {
    const connector = requireConnector(
      this.registry.getMailConnectors(input.role, "write"),
      input.account,
      "mail draft",
      (c) => c.createDraft != null,
    );
    if (!connector.createDraft) throw new Error("No mail connector with draft support found.");
    const createDraft = connector.createDraft.bind(connector);
    const to = parseRecipients(input.to, true) ?? [];
    return this.withSignature(connector, input.signature !== false, () =>
      createDraft(to, input.subject ?? "(no subject)", input.body, this.sendOptions(input)),
    );
  }
  async sendDraft(
    id: string,
    account: string,
    role?: string,
    idempotencyKey?: string,
  ): Promise<string | undefined> {
    const connector = this.registry.getMailConnectorForAccount(account, role, "write");
    if (!connector?.sendDraft)
      throw new Error(`sendDraft not supported for ${connector?.tier ?? account}`);
    const sendDraft = connector.sendDraft.bind(connector);
    const submit = async (): Promise<string | undefined> => (await sendDraft(id)).warning;
    if (!idempotencyKey) return submit();
    this.pruneIdempotency();
    const scopedKey = `${account}\u0000${id}\u0000${idempotencyKey}`;
    const existing = this.draftSubmissionIdempotency.get(scopedKey);
    if (existing) return existing.promise;
    const pending = submit();
    this.draftSubmissionIdempotency.set(scopedKey, { promise: pending, createdAt: Date.now() });
    try {
      return await pending;
    } catch (error) {
      this.draftSubmissionIdempotency.delete(scopedKey);
      throw error;
    }
  }
  async update(
    ids: readonly string[],
    account: string,
    role: string | undefined,
    patch: { isRead?: boolean; moveTo?: string; delete?: boolean },
  ): Promise<MailUpdateOutcome[]> {
    if (patch.isRead === undefined && !patch.moveTo && !patch.delete)
      throw new Error("At least one update action is required");
    if (ids.length === 0) throw new Error("At least one message id is required");
    if (ids.length > MAX_UPDATE_BATCH)
      throw new Error(
        `At most ${String(MAX_UPDATE_BATCH)} messages can be updated in one call (got ${String(ids.length)})`,
      );
    const connector = this.registry.getMailConnectorForAccount(account, role, "write");
    if (!connector) throw new Error(`No connector for ${account}`);

    // Read the headline metadata BEFORE mutating. After a move or delete the id
    // no longer resolves in the source folder, so this is the only point at
    // which the caller can be told what was actually touched. Best effort: a
    // connector without getSummaries, or a lookup that fails, must not stop the
    // action itself.
    const summaries = new Map<string, MailMessage>();
    if (connector.getSummaries) {
      try {
        for (const summary of await connector.getSummaries(ids)) summaries.set(summary.id, summary);
      } catch {
        /* diagnostics are best effort */
      }
    }

    const outcomes: MailUpdateOutcome[] = [];
    for (const id of ids) {
      const summary = summaries.get(id);
      const actions: string[] = [];
      try {
        if (patch.isRead !== undefined) {
          await connector.markRead(id, patch.isRead);
          actions.push(patch.isRead ? "marked read" : "marked unread");
        }
        if (patch.moveTo) {
          await connector.moveMessage(id, patch.moveTo);
          actions.push(`moved to ${patch.moveTo}`);
        }
        if (patch.delete) {
          await connector.deleteMessage(id);
          actions.push("deleted");
        }
        outcomes.push({ id, subject: summary?.subject, from: summary?.from, actions });
      } catch (error) {
        // One bad id must not abandon the rest of the batch, but it has to be
        // reported per message rather than collapsed into a single failure.
        outcomes.push({
          id,
          subject: summary?.subject,
          from: summary?.from,
          actions,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return outcomes;
  }
  getConnector(account: string, role?: string): MailConnector {
    const connector = this.registry.getMailConnectorForAccount(account, role);
    if (!connector) throw new Error(`No connector for ${account}`);
    return connector;
  }
  private sendOptions(input: MailSendInput): MailSendOpts {
    if ((input.attachments?.length ?? 0) > MAX_ATTACHMENTS)
      throw new Error(`At most ${String(MAX_ATTACHMENTS)} attachments are allowed`);
    return {
      cc: parseRecipients(input.cc),
      bcc: parseRecipients(input.bcc),
      attachments: input.attachments?.length
        ? resolveAttachmentPaths([...input.attachments])
        : undefined,
    };
  }
  private async withSignature<T>(
    connector: MailConnector,
    enabled: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.connectorLocks.get(connector) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.connectorLocks.set(
      connector,
      previous.then(() => gate),
    );
    await previous;
    const signature = connector.signature;
    if (!enabled) connector.signature = undefined;
    try {
      return await operation();
    } finally {
      connector.signature = signature;
      release();
    }
  }

  /**
   * Step one of a bulk action: run the query, pin exactly what it matched, and
   * hand back a token. Nothing is changed here.
   *
   * The pinning is the point. Confirming by re-running the query would act on a
   * different set than the one the caller reviewed: mail keeps arriving, and
   * criteria like unread state change on their own. The provider search
   * syntaxes also differ (Graph $search, IMAP SEARCH, Gmail q), so the same
   * query can match differently per account.
   */
  async previewBulk(
    query: string,
    opts: { role?: string; folder?: string; limit?: number } = {},
  ): Promise<BulkPreview> {
    const limit = Math.min(opts.limit ?? 100, MAX_UPDATE_BATCH);
    // A search without a folder covers the whole mailbox. A bulk action moves
    // or deletes what it matches, so it stays in the inbox unless told otherwise.
    const folder = hasFolder(opts.folder) ? opts.folder : "inbox";
    const { messages, failures } = await this.search(query, opts.role, folder, limit);
    const targets: BulkTarget[] = messages
      .slice(0, limit)
      .map((m) => ({ id: m.id, account: m.account, subject: m.subject, from: m.from }));

    this.pruneBulkPreviews();
    const token = randomUUID();
    this.bulkPreviews.set(token, {
      targets,
      createdAt: Date.now(),
      fingerprint: JSON.stringify({ query, role: opts.role, folder }),
    });
    return {
      token,
      targets,
      failures,
      needsAcknowledgement: targets.length > BULK_ACK_THRESHOLD,
      expiresAt: Date.now() + BULK_PREVIEW_TTL_MS,
    };
  }

  /**
   * Step two: apply the action to the pinned set, grouped per account because a
   * search fans out across connectors while an update targets one.
   *
   * Deleting moves to the trash on every provider; nothing here purges.
   */
  async executeBulk(
    token: string,
    action: { delete: true } | { moveTo: string },
    opts: { role?: string; acknowledgeLarge?: boolean } = {},
  ): Promise<MailUpdateOutcome[]> {
    this.pruneBulkPreviews();
    const pinned = this.bulkPreviews.get(token);
    if (!pinned)
      throw new Error(
        "Unknown or expired confirmation token. Run the preview again and confirm with its fresh token.",
      );
    if (pinned.targets.length > BULK_ACK_THRESHOLD && !opts.acknowledgeLarge)
      throw new Error(
        `This would affect ${String(pinned.targets.length)} messages (over the ${String(BULK_ACK_THRESHOLD)} threshold). Re-run with acknowledge_large to proceed.`,
      );

    // Consume the token first: a confirmation must not be replayable, otherwise
    // a retried call could act twice on ids that have already moved.
    this.bulkPreviews.delete(token);

    const byAccount = new Map<string, BulkTarget[]>();
    for (const target of pinned.targets)
      byAccount.set(target.account, [...(byAccount.get(target.account) ?? []), target]);

    const patch = "delete" in action ? { delete: true } : { moveTo: action.moveTo };
    const outcomes: MailUpdateOutcome[] = [];
    for (const [account, targets] of byAccount) {
      const ids = targets.map((t) => t.id);
      try {
        const result = await this.update(ids, account, opts.role, patch);
        // The preview already knows subject and sender, so a per-account
        // summary lookup that now fails cannot blank out the report.
        for (const [index, outcome] of result.entries()) {
          const target = targets[index];
          outcomes.push({
            ...outcome,
            subject: outcome.subject ?? target?.subject,
            from: outcome.from ?? target?.from,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const target of targets)
          outcomes.push({
            id: target.id,
            subject: target.subject,
            from: target.from,
            actions: [],
            error: message,
          });
      }
    }
    return outcomes;
  }

  private pruneBulkPreviews(): void {
    const cutoff = Date.now() - BULK_PREVIEW_TTL_MS;
    for (const [key, entry] of this.bulkPreviews)
      if (entry.createdAt < cutoff || this.bulkPreviews.size > 100) this.bulkPreviews.delete(key);
  }

  private pruneIdempotency(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [key, entry] of this.idempotency) {
      if (entry.createdAt < cutoff || this.idempotency.size > 1_000) this.idempotency.delete(key);
    }
    for (const [key, entry] of this.draftSubmissionIdempotency) {
      if (entry.createdAt < cutoff || this.draftSubmissionIdempotency.size > 1_000)
        this.draftSubmissionIdempotency.delete(key);
    }
  }
}

/** Appends a connector's post-delivery warning to a success line. */
function withWarning(line: string, receipt: SendReceipt): string {
  return receipt.warning ? `${line}\n⚠️ ${receipt.warning}` : line;
}
