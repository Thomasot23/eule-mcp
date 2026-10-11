import type {
  MailConnector,
  CalendarConnector,
  ContactConnector,
  MessengerConnector,
  FileConnector,
  DocumentConnector,
  TaskConnector,
  RoleConfig,
  ConnectorConfig,
} from "../types/index.js";
import type { ConfigManager } from "../config/index.js";
import type { M365Reauth } from "../auth/m365-reauth.js";
import type { OAuthConfig } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { loadTokens, getAccessToken } from "../providers/m365/index.js";
import { GraphMailConnector } from "../providers/m365/graph-mail.js";
import { EwsMailConnector } from "../providers/m365/ews-mail.js";
import { ImapMailConnector } from "../providers/imap/index.js";
import { EwsCalendarConnector } from "../providers/m365/ews-calendar.js";
import { GraphCalendarConnector } from "../providers/m365/graph-calendar.js";
import { GraphContactConnector } from "../providers/m365/graph-contacts.js";
import { EwsContactConnector } from "../providers/m365/ews-contacts.js";
import { CalDavCalendarConnector } from "../providers/caldav/index.js";
import { CardDavContactConnector } from "../providers/caldav/index.js";
import { CalDavTaskConnector } from "../providers/caldav/index.js";
import { GraphTaskConnector } from "../providers/m365/graph-tasks.js";
import { ICalFeedConnector } from "../providers/ical/index.js";
import { GraphTeamsConnector } from "../providers/m365/graph-teams.js";
import { GraphFileConnector } from "../providers/m365/graph-files.js";
import { SignalMessengerConnector } from "../providers/signal/index.js";
import { getGoogleAccessToken } from "../providers/google/index.js";
import { GoogleMailConnector } from "../providers/google/google-mail.js";
import { GoogleCalendarConnector } from "../providers/google/google-calendar.js";
import { GoogleContactConnector } from "../providers/google/google-contacts.js";
import { GoogleDriveConnector } from "../providers/google/google-drive.js";
import { PaperlessConnector } from "../providers/paperless/index.js";
import { RolePolicyService, type AccessMode } from "../config/index.js";
import { ConfiguredCredentialResolver } from "../helper/configured-credential-resolver.js";

export class ConnectorRegistry {
  private readonly policy: RolePolicyService;

  constructor(
    private readonly config: ConfigManager,
    private readonly secrets: ConfiguredCredentialResolver = new ConfiguredCredentialResolver(
      config,
    ),
    private readonly reauth?: M365Reauth,
  ) {
    this.policy = new RolePolicyService(() => this.config.get());
  }

  /** M365 token source; renews a dead sign-in through Safari where configured. */
  private m365Token(account: string, oauth: OAuthConfig): () => Promise<string | null> {
    const getToken = () => getAccessToken(account, oauth);
    return this.reauth ? this.reauth.tokenSource(account, getToken) : getToken;
  }

  /** Get all mail connectors, optionally filtered by role. */
  getMailConnectors(role?: string, mode: AccessMode = "read"): MailConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: MailConnector[] = [];

    const roles = this.policy.select(role, "mail", mode);

    for (const r of roles) {
      const sig = r.signature;
      const startIdx = connectors.length;
      for (const mc of r.connectors.mail ?? []) {
        if (mc.type === "imap") {
          // Generic IMAP provider — host/auth from config.
          connectors.push(
            new ImapMailConnector(mc.account, {
              account: mc.account,
              host: mc.host ?? "localhost",
              smtpHost: mc.smtpHost ?? "localhost",
              port: mc.port,
              smtpPort: mc.smtpPort,
              saveSentCopy: mc.saveSentCopy,
              auth: mc.auth ?? "password",
              password: this.secrets.connector(mc),
            }),
          );
          continue;
        }

        if (mc.type === "google") {
          const gcfg = this.secrets.googleOAuth();
          if (!gcfg) continue;
          connectors.push(
            new GoogleMailConnector(mc.account, () => getGoogleAccessToken(mc.account, gcfg)),
          );
          continue;
        }

        // M365 provider — tier-based routing.
        const token = tokens.accounts[mc.account];
        if (!token) continue;

        const getToken = this.m365Token(mc.account, oauth);
        const target = mc.mailbox ?? mc.account;
        const isShared = !!mc.mailbox;

        switch (token.tier) {
          case "graph":
            connectors.push(new GraphMailConnector(target, getToken, isShared));
            break;
          case "ews":
            connectors.push(new EwsMailConnector(target, getToken, isShared));
            break;
          case "imap":
            connectors.push(
              new ImapMailConnector(mc.account, {
                account: mc.account,
                host: "outlook.office365.com",
                smtpHost: "smtp.office365.com",
                auth: "oauth",
                getToken,
              }),
            );
            break;
        }
      }
      if (sig)
        for (let i = startIdx; i < connectors.length; i++) {
          const c = connectors[i];
          if (c) c.signature = sig;
        }
      if (r.displayName)
        for (let i = startIdx; i < connectors.length; i++) {
          const c = connectors[i];
          if (c) c.displayName = r.displayName;
        }
    }

    return connectors;
  }

  /** Get a single mail connector by account email. */
  getMailConnectorForAccount(
    account: string,
    role?: string,
    mode: AccessMode = "read",
  ): MailConnector | undefined {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();

    // Select the connector config for this account, preferring an exact
    // PERSONAL match (auth account, no shared mailbox) over a shared-mailbox
    // connector that happens to share the same auth account. Without this
    // preference the lookup would be declaration-order-dependent and could
    // silently route a request for the auth account to its shared mailbox.
    let personal: { r: RoleConfig; mc: ConnectorConfig } | undefined;
    let sharedHit: { r: RoleConfig; mc: ConnectorConfig } | undefined;
    for (const r of this.policy.select(role, "mail", mode)) {
      for (const mc of r.connectors.mail ?? []) {
        if (mc.account === account && !mc.mailbox) personal ??= { r, mc };
        else if (mc.mailbox === account) sharedHit ??= { r, mc };
      }
    }
    const hit = personal ?? sharedHit;
    if (!hit) return undefined;
    const { r, mc } = hit;

    if (mc.type === "imap") {
      return new ImapMailConnector(mc.account, {
        account: mc.account,
        host: mc.host ?? "localhost",
        smtpHost: mc.smtpHost ?? "localhost",
        port: mc.port,
        smtpPort: mc.smtpPort,
        saveSentCopy: mc.saveSentCopy,
        auth: mc.auth ?? "password",
        password: this.secrets.connector(mc),
      });
    }

    if (mc.type === "google") {
      const gcfg = this.secrets.googleOAuth();
      if (!gcfg) return undefined;
      const c = new GoogleMailConnector(mc.account, () => getGoogleAccessToken(mc.account, gcfg));
      c.signature = r.signature;
      c.displayName = r.displayName;
      return c;
    }

    // The token is stored under the authenticating account (mc.account),
    // not the shared address; target the shared mailbox via mc.mailbox.
    const token = tokens.accounts[mc.account];
    if (!token) return undefined;
    const target = mc.mailbox ?? mc.account;
    const isShared = !!mc.mailbox;
    const getToken = this.m365Token(mc.account, oauth);

    switch (token.tier) {
      case "graph":
        return new GraphMailConnector(target, getToken, isShared);
      case "ews":
        return new EwsMailConnector(target, getToken, isShared);
      case "imap":
        return new ImapMailConnector(mc.account, {
          account: mc.account,
          host: "outlook.office365.com",
          smtpHost: "smtp.office365.com",
          auth: "oauth",
          getToken,
        });
    }
    return undefined;
  }

  /** Get all calendar connectors, optionally filtered by role. */
  getCalendarConnectors(role?: string, mode: AccessMode = "read"): CalendarConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: CalendarConnector[] = [];

    const roles = this.policy.select(role, "calendar", mode);

    for (const r of roles) {
      for (const cc of r.connectors.calendar ?? []) {
        if (cc.type === "caldav") {
          const password = this.secrets.connector(cc);
          if (cc.url && password) {
            connectors.push(
              new CalDavCalendarConnector(cc.account, {
                account: cc.account,
                url: cc.url,
                password,
              }),
            );
          }
          continue;
        }

        if (cc.type === "ical") {
          if (cc.url) connectors.push(new ICalFeedConnector(cc.account || cc.id, cc.url));
          continue;
        }

        if (cc.type === "google") {
          const gcfg = this.secrets.googleOAuth();
          if (gcfg)
            connectors.push(
              new GoogleCalendarConnector(cc.account, () => getGoogleAccessToken(cc.account, gcfg)),
            );
          continue;
        }

        // M365 provider. For a shared/delegate mailbox authenticate as the
        // configured account but TARGET cc.mailbox (else the connector returns
        // the auth user's own calendar). Mirrors getMailConnectors.
        const token = tokens.accounts[cc.account];
        if (!token) continue;
        const target = cc.mailbox ?? cc.account;
        const isShared = !!cc.mailbox;
        const getToken = this.m365Token(cc.account, oauth);
        switch (token.tier) {
          case "graph":
            connectors.push(new GraphCalendarConnector(target, getToken, isShared));
            break;
          case "ews":
            connectors.push(new EwsCalendarConnector(target, getToken, isShared));
            break;
        }
      }
    }

    return connectors;
  }

  /**
   * Get all task connectors, optionally filtered by role. Backed by real task
   * systems (Microsoft To Do, Apple Reminders, Nextcloud Tasks) rather than a
   * private store, so tasks stay visible to the user's other clients.
   */
  getTaskConnectors(role?: string, mode: AccessMode = "read"): TaskConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: TaskConnector[] = [];

    const roles = this.policy.select(role, "tasks", mode);

    for (const r of roles) {
      for (const cc of r.connectors.tasks ?? []) {
        if (cc.type === "caldav") {
          const password = this.secrets.connector(cc);
          if (cc.url && password) {
            connectors.push(
              new CalDavTaskConnector(cc.account, {
                account: cc.account,
                url: cc.url,
                password,
              }),
            );
          }
          continue;
        }

        // M365. Delegated /me/todo has no shared-mailbox form, so cc.mailbox is
        // deliberately ignored here, and only a graph-tier token can serve it.
        const token = tokens.accounts[cc.account];
        if (!token) continue;
        if (token.tier !== "graph") {
          logger.warn(
            `Task connector ${cc.id}: ${cc.account} is on tier ${token.tier}; Microsoft To Do needs a graph token with Tasks.ReadWrite.`,
          );
          continue;
        }
        connectors.push(new GraphTaskConnector(cc.account, this.m365Token(cc.account, oauth)));
      }
    }

    return connectors;
  }

  /** Get all contact connectors, optionally filtered by role. */
  getContactConnectors(role?: string, mode: AccessMode = "read"): ContactConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: ContactConnector[] = [];

    const roles = this.policy.select(role, "contacts", mode);

    for (const r of roles) {
      for (const cc of r.connectors.contacts ?? []) {
        if (cc.type === "carddav") {
          const password = this.secrets.connector(cc);
          if (cc.url && password) {
            connectors.push(
              new CardDavContactConnector(cc.account, {
                account: cc.account,
                url: cc.url,
                password,
              }),
            );
          }
          continue;
        }

        if (cc.type !== "m365" && cc.type !== "google") continue;

        if (cc.type === "google") {
          const gcfg = this.secrets.googleOAuth();
          if (gcfg)
            connectors.push(
              new GoogleContactConnector(cc.account, () => getGoogleAccessToken(cc.account, gcfg)),
            );
          continue;
        }

        const token = tokens.accounts[cc.account];
        if (!token) continue;
        const target = cc.mailbox ?? cc.account;
        const isShared = !!cc.mailbox;
        const getToken = this.m365Token(cc.account, oauth);
        switch (token.tier) {
          case "graph":
            connectors.push(new GraphContactConnector(target, getToken, isShared));
            break;
          case "ews":
            connectors.push(new EwsContactConnector(target, getToken, isShared));
            break;
        }
      }
    }

    return connectors;
  }

  /** Get all messenger connectors, optionally filtered by role. */
  getMessengerConnectors(role?: string, mode: AccessMode = "read"): MessengerConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: MessengerConnector[] = [];
    const roles = this.policy.select(role, "messenger", mode);

    for (const r of roles) {
      for (const mc of r.connectors.messenger ?? []) {
        if (mc.type === "signal") {
          if (mc.signalCliUrl)
            connectors.push(new SignalMessengerConnector(mc.account, mc.signalCliUrl));
          continue;
        }
        // M365 Teams. Delegated/shared chats are not supported (GraphTeamsConnector
        // targets /me/chats). Fail loud rather than silently using the auth user's.
        if (mc.mailbox) {
          logger.error(
            `Messenger connector '${mc.id}' sets mailbox='${mc.mailbox}' but shared/delegate ` +
              `Teams is not supported — skipping.`,
          );
          continue;
        }
        const token = tokens.accounts[mc.account];
        if (token?.tier !== "graph") continue;
        connectors.push(new GraphTeamsConnector(mc.account, this.m365Token(mc.account, oauth)));
      }
    }
    return connectors;
  }

  /** Get all file connectors, optionally filtered by role. */
  getFileConnectors(role?: string, mode: AccessMode = "read"): FileConnector[] {
    const cfg = this.config.get();
    const oauth = cfg.oauth;
    const tokens = loadTokens();
    const connectors: FileConnector[] = [];
    const roles = this.policy.select(role, "files", mode);

    for (const r of roles) {
      for (const fc of r.connectors.files ?? []) {
        if (fc.type === "google") {
          const gcfg = this.secrets.googleOAuth();
          if (gcfg)
            connectors.push(
              new GoogleDriveConnector(fc.account, () => getGoogleAccessToken(fc.account, gcfg)),
            );
          continue;
        }
        if (fc.type !== "m365") continue;
        // Delegated/shared OneDrive is not supported (GraphFileConnector targets
        // /me/drive). Fail loud rather than silently returning the auth user's
        // own files under a shared label.
        if (fc.mailbox) {
          logger.error(
            `File connector '${fc.id}' sets mailbox='${fc.mailbox}' but shared/delegate ` +
              `OneDrive is not supported — skipping (would return your OWN files).`,
          );
          continue;
        }
        const token = tokens.accounts[fc.account];
        if (token?.tier !== "graph") continue;
        connectors.push(new GraphFileConnector(fc.account, this.m365Token(fc.account, oauth)));
      }
    }
    return connectors;
  }

  /** Get all document connectors, optionally filtered by role. */
  getDocumentConnectors(role?: string, mode: AccessMode = "read"): DocumentConnector[] {
    const connectors: DocumentConnector[] = [];
    const roles = this.policy.select(role, "documents", mode);
    for (const r of roles) {
      for (const dc of r.connectors.documents ?? []) {
        const token = this.secrets.connector(dc);
        if (dc.type === "paperless" && dc.url && token) {
          connectors.push(new PaperlessConnector(dc.account || dc.id, dc.url, token));
        }
      }
    }
    return connectors;
  }
}
