/** Connector configuration for a single mail or calendar account. */
export interface ConnectorConfig {
  readonly id: string;
  readonly type:
    | "m365"
    | "imap"
    | "caldav"
    | "carddav"
    | "ical"
    | "signal"
    | "google"
    | "paperless"
    | "mediawiki";
  readonly account: string;
  /** For shared/delegate mailboxes. Auth uses `account`, access targets `mailbox`. */
  readonly mailbox?: string;
  // IMAP-specific fields (type: "imap").
  readonly host?: string;
  readonly port?: number;
  readonly smtpHost?: string;
  readonly smtpPort?: number;
  /**
   * File a copy of sent mail in the Sent mailbox over IMAP. Defaults to true,
   * except for SMTP services that do this themselves (Gmail, Microsoft).
   */
  readonly saveSentCopy?: boolean;
  /**
   * IMAP mailbox that holds sent mail. Only needed where the server flags no
   * Sent mailbox, or flags one that the mail client does not use.
   */
  readonly sentMailbox?: string;
  readonly auth?: "oauth" | "password";
  readonly password?: string;
  /** Opaque key in the OS credential store. Preferred over inline secrets. */
  readonly credentialRef?: string;
  // CalDAV/CardDAV/iCal fields.
  readonly url?: string;
  // Paperless-NGX fields (type: "paperless").
  readonly token?: string;
  // Signal fields (type: "signal").
  readonly signalCliUrl?: string;
}

/** A TOTP credential held in a YubiKey's OATH applet rather than the OS credential store. */
export interface YubikeyTotpConfig {
  /** Credential name on the key, e.g. "eule:you@example.com" (at most 64 bytes). */
  readonly credential: string;
  /** Require a touch for every code. Applied when Eule writes the credential to the key. */
  readonly touch?: boolean;
}

/** Optional per-account autofill bindings for the native Eule webview. */
export interface AutoAuthConfig {
  readonly account: string;
  /** Legacy inline base32 TOTP seed. Migration-only; not forwarded to autofill. */
  readonly totpSecret?: string;
  /** Preferred OS credential-store reference for the TOTP seed. */
  readonly totpSecretRef?: string;
  /** TOTP codes from a YubiKey instead of a stored seed. Excludes the two above. */
  readonly totpYubikey?: YubikeyTotpConfig;
  /** Opt-in OS credential-store reference for the Microsoft 365 password. */
  readonly passwordSecretRef?: string;
  /** Sign in through Safari (security keys, Safari's session); Eule then also
   *  renews a dead sign-in that way on its own. */
  readonly login?: "safari";
}

/** Connectors grouped by domain. */
export interface RoleConnectors {
  readonly mail?: readonly ConnectorConfig[];
  readonly calendar?: readonly ConnectorConfig[];
  readonly contacts?: readonly ConnectorConfig[];
  readonly messenger?: readonly ConnectorConfig[];
  readonly files?: readonly ConnectorConfig[];
  readonly documents?: readonly ConnectorConfig[];
  /** Task backends: Microsoft To Do via Graph, or VTODO over CalDAV
   *  (Apple Reminders, Nextcloud Tasks). */
  readonly tasks?: readonly ConnectorConfig[];
  /** Wikis and intranets (MediaWiki, BlueSpice): pages and attached files, read-only. */
  readonly wiki?: readonly ConnectorConfig[];
}

/** A single role definition. */
export interface RoleConfig {
  readonly id: string;
  readonly name: string;
  readonly weeklyHours: number;
  readonly contexts?: readonly string[];
  readonly connectors: RoleConnectors;
  /** HTML signature appended to outgoing emails. Inline HTML or path to .html file. */
  readonly signature?: string;
  /** Display name for outgoing emails, e.g. "Dr. Fabian Schmieder". */
  readonly displayName?: string;
  /** Enforceable policy for this work context. Omitted means enabled, read/write,
   *  with every connector domain allowed (backwards compatible). */
  readonly policy?: RolePolicy;
}

export type ConnectorKind = keyof RoleConnectors;

export interface RolePolicy {
  readonly enabled?: boolean;
  readonly readOnly?: boolean;
  readonly allowedConnectorKinds?: readonly ConnectorKind[];
}

/** OAuth configuration with sensible defaults. */
export interface OAuthConfig {
  readonly clientId: string;
  readonly tenant: string;
  /** Azure AD endpoint generation. Some older public-client app registrations
   *  (e.g. Thunderbird's) are only consented for the legacy v1 endpoint
   *  (`resource=`) and behave unpredictably against the v2.0 endpoint
   *  (`scope=`) even with an identical client ID. Default: "v2". */
  readonly apiVersion?: "v1" | "v2";
  /** Broker/custom redirect registered for this public client. When present,
   *  `auth_login(method: auto)` selects the native Eule webview. */
  readonly redirectUri?: string;
  /**
   * Extra v2 scopes appended to the tier defaults, e.g.
   * `https://graph.microsoft.com/Tasks.ReadWrite` for Microsoft To Do.
   * Opt-in on purpose: requesting a scope the client's app registration does
   * not consent makes every login for that client fail, so this is only added
   * when you point `clientId` at an app that actually has the permission.
   */
  readonly extraScopes?: readonly string[];
}

/** Partial structural update accepted by the OAuth configuration control plane. */
export interface OAuthConfigPatch {
  readonly clientId?: string;
  readonly tenant?: string;
  readonly apiVersion?: "v1" | "v2";
  /** `null` removes a previously configured webview redirect. */
  readonly redirectUri?: string | null;
}

export interface GoogleOAuthConfig {
  readonly clientId: string;
  /** Legacy inline client secret. */
  readonly clientSecret?: string;
  /** Preferred OS credential-store reference for the client secret. */
  readonly clientSecretRef?: string;
}

export interface ResolvedGoogleOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Root application configuration loaded from config.yaml. */
export interface AppConfig {
  readonly language: "de" | "en";
  readonly oauth: OAuthConfig;
  readonly google?: GoogleOAuthConfig;
  readonly autoAuth?: readonly AutoAuthConfig[];
  /** Daily check for a newer Eule release (on unless `check: false`). */
  readonly updates?: { readonly check: boolean };
  readonly roles: readonly RoleConfig[];
}

/** API tier determined by the auth probe. */
export type ApiTier = "graph" | "ews" | "imap" | "google";

/** Stored token data for a single account. */
export interface AccountToken {
  readonly account: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly tier: ApiTier;
  readonly icalUrl?: string;
  readonly provider?: "m365" | "google";
  /** OAuth app that issued this token, when it differs from the configured
   *  default (e.g. a tenant only consents one public-client app per tier —
   *  Thunderbird for IMAP, Apple Internet Accounts for EWS). Refreshes must
   *  reuse this client ID; a mismatched one is rejected by Microsoft. */
  readonly clientId?: string;
  /** Azure AD endpoint generation this token was minted with. The v1-vs-v2
   *  choice is a property of the issuing client (Thunderbird/Apple are v1-only),
   *  NOT of global config — so refresh must reuse it, or a mixed v1+v2 store
   *  breaks. Falls back to the global oauth.apiVersion when absent. */
  readonly apiVersion?: "v1" | "v2";
}

/** Persisted token store (all accounts). */
export interface TokenStore {
  accounts: Record<string, AccountToken>;
}
