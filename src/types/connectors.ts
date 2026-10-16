/** Minimal mail message representation returned by connectors. */
export interface MailMessage {
  readonly id: string;
  readonly account: string;
  readonly role?: string;
  readonly subject: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly receivedAt: string;
  readonly snippet: string;
  readonly isRead: boolean;
}

/** Full mail message with body. */
export interface MailMessageFull extends MailMessage {
  readonly body: string;
  readonly bodyType: "text" | "html";
  readonly attachments: readonly MailAttachment[];
}

/** Attachment metadata. */
export interface MailAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly contentType: string;
  /** True for inline (cid:) parts such as embedded images, not real file attachments. */
  readonly isInline?: boolean;
  /** RFC 2392 Content-ID (angle brackets stripped), when present. */
  readonly contentId?: string;
}

/**
 * A file to attach to an outgoing message. The tool layer resolves the bytes
 * (e.g. from a sandboxed disk path) before handing this to a connector.
 */
export interface OutgoingAttachment {
  readonly filename: string;
  readonly content: Buffer;
  readonly contentType?: string;
  /**
   * When set, the part is embedded inline and can be referenced as `cid:<cid>`
   * in the HTML body (e.g. for images) instead of shown as a file attachment.
   */
  readonly cid?: string;
}

/** Calendar event representation. */
/** Calendar info. */
export interface CalendarInfo {
  readonly id: string;
  readonly name: string;
  readonly account: string;
  readonly color?: string;
  readonly isDefault?: boolean;
}

export interface CalendarEvent {
  readonly id: string;
  readonly account: string;
  readonly role?: string;
  readonly calendarId?: string;
  readonly calendarName?: string;
  readonly subject: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly isAllDay: boolean;
  readonly attendees: readonly string[];
}

/** Input for creating a calendar event. */
export interface CalendarEventInput {
  readonly subject: string;
  readonly start: string;
  readonly end: string;
  readonly location?: string;
  readonly body?: string;
  readonly attendees?: readonly string[];
  readonly calendarId?: string;
}

/**
 * What a connector reports about a send beyond "it went out". A warning never
 * means the message failed: it was delivered, but something after delivery
 * (such as filing the copy in the Sent folder) did not work.
 */
export interface SendReceipt {
  readonly warning?: string;
}

/**
 * Submits a finished MIME message for delivery, without a mailbox of its own.
 *
 * Without an envelope, the recipients are read from the message headers.
 */
export interface RawMailSubmitter {
  submitRaw(raw: Buffer, envelope?: { from: string; to: readonly string[] }): Promise<void>;
}

/** Mail connector interface — implemented per API tier. */
export interface MailConnector {
  readonly account: string;
  readonly tier: string;
  /** HTML signature for outgoing mail. Set by registry from role config. */
  signature?: string;
  /** Display name for From header, e.g. "Dr. Fabian Schmieder". Set by registry from role config. */
  displayName?: string;
  listMessages(folder?: string, limit?: number): Promise<MailMessage[]>;
  getMessage(id: string): Promise<MailMessageFull>;
  /**
   * Headline metadata for specific ids, without fetching bodies or attachments.
   *
   * Exists so a bulk action can name what it is about to touch. `getMessage` is
   * far too heavy for that (full body, `$expand=attachments`), and after a move
   * or delete the id may no longer resolve, so callers read summaries *before*
   * mutating. Optional: callers must degrade gracefully when a connector does
   * not implement it. Unknown ids are omitted rather than throwing.
   */
  getSummaries?(ids: readonly string[]): Promise<MailMessage[]>;
  /**
   * Newest matches first. Without a folder the search covers every mail folder
   * of the mailbox; with one, only that folder. Implementations must honour
   * `folder`: TypeScript accepts an override that leaves it out, which once
   * let a provider silently search the whole mailbox.
   */
  searchMessages(query: string, limit?: number, folder?: string): Promise<MailMessage[]>;
  sendMessage(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt>;
  createDraft?(
    to: string[],
    subject: string,
    body: string,
    opts?: MailSendOpts,
  ): Promise<MailMessage>;
  sendDraft?(id: string): Promise<SendReceipt>;
  replyToMessage(id: string, body: string, opts?: MailSendOpts): Promise<SendReceipt>;
  forwardMessage(
    id: string,
    to: string[],
    body?: string,
    opts?: MailSendOpts,
  ): Promise<SendReceipt>;
  downloadAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
  markRead(id: string, isRead: boolean): Promise<void>;
  moveMessage(id: string, folder: string): Promise<void>;
  deleteMessage(id: string): Promise<void>;
}

export interface MailSendOpts {
  cc?: string[];
  bcc?: string[];
  /** Files to attach to the outgoing message. */
  attachments?: OutgoingAttachment[];
}

/** Calendar connector interface — implemented per API tier. */
export interface CalendarConnector {
  readonly account: string;
  readonly tier: string;
  readonly readOnly: boolean;
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(start: string, end: string): Promise<CalendarEvent[]>;
  createEvent(event: CalendarEventInput): Promise<CalendarEvent>;
  updateEvent(id: string, updates: Partial<CalendarEventInput>): Promise<CalendarEvent>;
  deleteEvent(id: string): Promise<void>;
}

/** Contact from a remote provider (Graph, EWS, CardDAV). */
export interface RemoteContact {
  readonly id: string;
  readonly account: string;
  readonly displayName: string;
  readonly email?: string;
  readonly phone?: string;
  readonly organization?: string;
  readonly jobTitle?: string;
}

/** Input for creating a contact. */
export interface ContactInput {
  readonly displayName: string;
  readonly email?: string;
  readonly phone?: string;
  readonly organization?: string;
  readonly jobTitle?: string;
}

/** Contact connector interface — implemented per API tier. */
export interface ContactConnector {
  readonly account: string;
  readonly tier: string;
  readonly readOnly: boolean;
  listContacts(limit?: number): Promise<RemoteContact[]>;
  searchContacts(query: string, limit?: number): Promise<RemoteContact[]>;
  createContact(contact: ContactInput): Promise<RemoteContact>;
}

/** Chat conversation from a messenger. */
export interface Conversation {
  readonly id: string;
  readonly account: string;
  readonly platform: string;
  readonly title: string;
  readonly lastMessage?: string;
  readonly lastTimestamp?: string;
  readonly participants: readonly string[];
}

/** Single chat message. */
export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly account: string;
  readonly platform: string;
  readonly from: string;
  readonly body: string;
  readonly timestamp: string;
}

/** Messenger connector interface. */
export interface MessengerConnector {
  readonly account: string;
  readonly platform: string;
  listConversations(limit?: number): Promise<Conversation[]>;
  getMessages(conversationId: string, limit?: number): Promise<ChatMessage[]>;
  sendMessage(conversationId: string, body: string): Promise<void>;
}

/** File search result. */
export interface FileResult {
  readonly id: string;
  readonly account: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly lastModified: string;
  readonly webUrl?: string;
}

/** File connector interface (SharePoint, OneDrive, Google Drive, etc.). */
export interface FileConnector {
  readonly account: string;
  readonly readOnly?: boolean;
  search(query: string, limit?: number): Promise<FileResult[]>;
  getContent(id: string): Promise<string>;
  listRecent(limit?: number): Promise<FileResult[]>;
  uploadFile?(name: string, content: Buffer, parentId?: string): Promise<FileResult>;
  downloadFile?(id: string): Promise<Buffer>;
  /** Lightweight metadata-only call (no content download). */
  getMetadata?(id: string): Promise<{ lastModified: string; name: string }>;
}

/** DMS tag. */
export interface DocTag {
  readonly id: number;
  readonly name: string;
  readonly color?: string;
  readonly match?: string;
  readonly matchingAlgorithm?: string;
}

/** DMS correspondent. */
export interface DocCorrespondent {
  readonly id: number;
  readonly name: string;
  readonly match?: string;
}

/** DMS document type. */
export interface DocDocumentType {
  readonly id: number;
  readonly name: string;
  readonly match?: string;
}

/** DMS document. */
export interface DocDocument {
  readonly id: number;
  readonly title: string;
  readonly content?: string;
  readonly correspondent?: DocCorrespondent | null;
  readonly documentType?: DocDocumentType | null;
  readonly tags: readonly DocTag[];
  readonly created?: string;
  readonly modified?: string;
  readonly added?: string;
  readonly archiveSerialNumber?: number | null;
  readonly originalFileName?: string;
  /** Best-effort metadata failures; raw IDs remain available in the document. */
  readonly warnings?: readonly string[];
}

/** Bulk edit method. */
export type DocBulkMethod =
  | "add_tag"
  | "remove_tag"
  | "set_correspondent"
  | "set_document_type"
  | "delete"
  | "reprocess"
  | "merge";

/** Document management connector (Paperless-NGX, etc.). */
export interface DocumentConnector {
  readonly account: string;
  readonly tier: string;
  searchDocuments(query: string, limit?: number): Promise<DocDocument[]>;
  listDocuments(page?: number, pageSize?: number): Promise<DocDocument[]>;
  getDocument(id: number): Promise<DocDocument>;
  downloadDocument(id: number, original?: boolean): Promise<Buffer>;
  uploadDocument(
    file: Buffer,
    filename: string,
    meta?: { title?: string; correspondent?: number; documentType?: number; tags?: number[] },
  ): Promise<DocDocument>;
  updateDocument(
    id: number,
    updates: {
      title?: string;
      correspondent?: number | null;
      documentType?: number | null;
      tags?: number[];
    },
  ): Promise<DocDocument>;
  bulkEdit(ids: number[], method: DocBulkMethod, params?: Record<string, unknown>): Promise<void>;
  listTags(): Promise<DocTag[]>;
  createTag(
    name: string,
    opts?: { color?: string; match?: string; matchingAlgorithm?: string },
  ): Promise<DocTag>;
  listCorrespondents(): Promise<DocCorrespondent[]>;
  createCorrespondent(name: string, opts?: { match?: string }): Promise<DocCorrespondent>;
  listDocumentTypes(): Promise<DocDocumentType[]>;
  createDocumentType(name: string, opts?: { match?: string }): Promise<DocDocumentType>;
}

/** A search hit in a wiki. */
export interface WikiSearchHit {
  readonly title: string;
  readonly namespace: number;
  /** Plain-text excerpt around the match, if the wiki supplies one. */
  readonly snippet?: string;
  readonly timestamp?: string;
  readonly size?: number;
  readonly url: string;
  /** The hit was a redirect with this title; `title` is its target. */
  readonly redirectFrom?: string;
}

/** A wiki page rendered for reading. */
export interface WikiPage {
  readonly title: string;
  readonly pageId: number;
  readonly revisionId?: number;
  readonly timestamp?: string;
  readonly url: string;
  /** Markdown converted from the rendered page, or raw wikitext. */
  readonly content: string;
  readonly format: "markdown" | "wikitext";
  readonly sections: readonly { readonly index: string; readonly title: string }[];
  readonly categories: readonly string[];
  /** Files embedded in or linked from the page (file names without namespace). */
  readonly files: readonly string[];
  /** Set when the requested title redirected here. */
  readonly redirectedFrom?: string;
}

/** An entry of a page listing (category, prefix or recent changes). */
export interface WikiPageRef {
  readonly title: string;
  readonly namespace: number;
  readonly timestamp?: string;
  readonly user?: string;
  readonly comment?: string;
  readonly url: string;
}

export interface WikiPageListing {
  readonly pages: readonly WikiPageRef[];
  /** Opaque token for the next page of results. */
  readonly continueFrom?: string;
}

export interface WikiListOptions {
  readonly category?: string;
  readonly prefix?: string;
  readonly namespace?: number;
  /** List recently changed pages instead of a category or prefix. */
  readonly recent?: boolean;
  readonly limit?: number;
  readonly continueFrom?: string;
}

/** Metadata of an uploaded file. */
export interface WikiFileInfo {
  /** File name without namespace prefix. */
  readonly name: string;
  readonly title: string;
  readonly size: number;
  readonly mime: string;
  readonly timestamp?: string;
  readonly user?: string;
  readonly url: string;
  readonly descriptionUrl: string;
}

/** Read-only wiki connector (MediaWiki, BlueSpice). */
export interface WikiConnector {
  readonly account: string;
  readonly tier: string;
  search(
    query: string,
    options?: { limit?: number; namespaces?: readonly number[]; titlesOnly?: boolean },
  ): Promise<WikiSearchHit[]>;
  readPage(
    title: string,
    options?: { format?: "markdown" | "wikitext"; section?: number },
  ): Promise<WikiPage>;
  listPages(options: WikiListOptions): Promise<WikiPageListing>;
  fileInfo(name: string): Promise<WikiFileInfo>;
  downloadFile(name: string): Promise<{ info: WikiFileInfo; data: Buffer }>;
}

/** A task list / collection (a To Do list, or a CalDAV VTODO collection). */
export interface TaskListInfo {
  readonly id: string;
  readonly account: string;
  readonly name: string;
  readonly isDefault?: boolean;
}

/**
 * A task as the remote system models it.
 *
 * `id` is opaque and provider-specific: Graph encodes `${listId}/${taskId}`,
 * CalDAV uses the object URL. Callers pass it back verbatim; only the owning
 * connector interprets it.
 */
export interface RemoteTask {
  readonly id: string;
  readonly account: string;
  readonly listId: string;
  readonly listName?: string;
  readonly title: string;
  readonly notes?: string;
  readonly completed: boolean;
  /** Due date, ISO-8601 date or date-time. */
  readonly due?: string;
  readonly completedAt?: string;
  /** Provider-native importance, normalised to low | normal | high. */
  readonly importance?: "low" | "normal" | "high";
}

/** Input for creating a task. */
export interface RemoteTaskInput {
  readonly title: string;
  readonly notes?: string;
  readonly due?: string;
  readonly importance?: "low" | "normal" | "high";
  /** Target list; the connector's default list is used when omitted. */
  readonly listId?: string;
}

/** Fields that may be changed on an existing task. */
export interface RemoteTaskUpdate {
  readonly title?: string;
  readonly notes?: string;
  readonly due?: string | null;
  readonly importance?: "low" | "normal" | "high";
  readonly completed?: boolean;
}

/** Task connector interface — implemented per provider (Graph To Do, CalDAV VTODO). */
export interface TaskConnector {
  readonly account: string;
  readonly tier: string;
  readonly readOnly: boolean;
  listTaskLists(): Promise<TaskListInfo[]>;
  /** Open tasks by default; pass `includeCompleted` to get finished ones too. */
  listTasks(opts?: {
    listId?: string;
    includeCompleted?: boolean;
    limit?: number;
  }): Promise<RemoteTask[]>;
  createTask(input: RemoteTaskInput): Promise<RemoteTask>;
  updateTask(id: string, updates: RemoteTaskUpdate): Promise<RemoteTask>;
  deleteTask(id: string): Promise<void>;
}
