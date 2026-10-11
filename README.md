<p align="center">
  <img src="https://raw.githubusercontent.com/metaneutrons/eule-mcp/main/assets/logo.svg" alt="Eule" width="200">
</p>

<p align="center">
  <strong>MCP server for an office assistant — E-Mail/Calendar integration, tasks & resource planning</strong>
</p>

<p align="center">
  <a href="https://github.com/metaneutrons/eule-mcp/actions"><img src="https://img.shields.io/github/actions/workflow/status/metaneutrons/eule-mcp/ci.yml?branch=main&style=flat-square" alt="CI"></a>
  <a href="https://github.com/metaneutrons/eule-mcp/blob/main/LICENSE"><img src="https://img.shields.io/github/license/metaneutrons/eule-mcp?style=flat-square" alt="License"></a>
  <a href="https://github.com/metaneutrons/eule-mcp"><img src="https://img.shields.io/github/stars/metaneutrons/eule-mcp?style=flat-square" alt="Stars"></a>
  <img src="https://img.shields.io/badge/status-WIP-orange?style=flat-square" alt="Status: WIP">
</p>

---

> [!WARNING]
> **This project is under active development.** Things will break, APIs will change, and features may be incomplete until v1.0. Use at your own risk — and feel free to contribute!
>
> Versioning follows that: while the major version is 0, a breaking change bumps
> the **minor** (`0.3.0` → `0.4.0`), it does not promote the project to `1.0.0`.
> Reaching 1.0 will be a deliberate decision, not a side effect of a
> `BREAKING CHANGE` footer.

---

## Why "Eule"?

**Eule** is the German word for **owl** — a symbol of wisdom, sharp vision, and the ability to see clearly in the dark. Like an owl surveying its territory, Eule gives your AI assistant a clear view across your entire office landscape: emails, calendars, tasks, and contacts — all through a single, unified interface.

## Concept

Eule is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that turns any MCP-compatible AI assistant into a full office agent. Instead of switching between Outlook, task managers, and calendars, your AI assistant connects to all of them through Eule.

```
┌─────────────────────────────────────────────┐
│  AI Assistant (Kiro, Claude, Cursor, ...)   │
└──────────────────┬──────────────────────────┘
                   │ MCP Protocol
┌──────────────────▼──────────────────────────┐
│            Eule MCP Server                  │
│                                             │
│  ┌─────────┐ ┌──────────┐ ┌─────────────┐   │
│  │  Mail   │ │ Calendar │ │    Tasks    │   │
│  └────┬────┘ └────┬─────┘ └──────┬──────┘   │
│  ┌────┴──┐ ┌──────┴──┐ ┌────────┴───────┐   │
│  │ Chat  │ │  Files  │ │   Contacts     │   │
│  └───┬───┘ └────┬────┘ └───────┬────────┘   │
│      │          │              │             │
│  ┌───▼──────────▼──────────────▼─────────┐   │
│  │          Provider Layer               │   │
│  │  M365 (Graph/EWS) · IMAP · CalDAV ·  │   │
│  │  CardDAV · iCal · Signal · Google     │   │
│  └───────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

**Key design decisions:**

- **Multi-provider architecture** — M365, Google Workspace, CalDAV, CardDAV, IMAP, iCal, Signal
- **Tiered API access** — Graph API → EWS → IMAP/SMTP, auto-detected per tenant
- **Native webview login** — cross-platform helper with opt-in password/TOTP autofill, TOTP optionally from a YubiKey
- **Role-based context** — map accounts and connectors to professional roles
- **LLM-optimized output** — HTML emails rendered as clean Markdown with thread splitting

## Tools (63)

### 🔐 Auth (5)

| Tool | Description |
|---|---|
| `auth_status` | Show authentication status and configuration |
| `auth_login` | Authenticate an account; M365 can use the local Eule webview with opt-in password/TOTP autofill |
| `auth_probe` | Test which API tier works for an account |
| `auth_accounts` | List token health without exposing credentials |
| `auth_logout` | Remove locally stored tokens for an account |

### 👤 Roles, accounts & configuration (18)

Eule can be configured end-to-end by an LLM without the user editing YAML.
**No MCP tool accepts a secret**: a write that needs a password, API token,
Google client secret, TOTP seed, or opt-in M365 password opens a branded local
Eule window. The helper validates and writes the value directly to the OS
credential store; MCP receives only success/failure and an opaque reference is
committed to `config.yaml`.

| Tool | Description |
|---|---|
| `role_list` | List all configured roles with connectors and weekly hours |
| `account_list` | SSOT inventory of accounts and every role/connector binding |
| `config_get` | Full config (roles, connectors, oauth, autoAuth) — secrets redacted |
| `role_upsert` | Create/update a role's metadata `[WRITES]` |
| `role_remove` | Remove a role and its connectors `[WRITES]` |
| `connector_capabilities` | Discover valid connector/domain combinations, fields, credential mode, and next step |
| `connector_configure` | Create/update a connector; capture any required secret locally `[WRITES]` |
| `account_add` | Deprecated compatibility alias for `connector_configure` `[WRITES]` |
| `account_remove` | Remove a connector from a role `[WRITES]` |
| `config_set_oauth` | Set the M365 client id / tenant / API version / webview redirect `[WRITES]` |
| `credential_status` | Report configured/missing/unavailable bindings without exposing values |
| `credential_rotate` | Atomically rotate a connector password or token `[WRITES]` |
| `google_oauth_configure` | Set the client id and capture the Google client secret locally `[WRITES]` |
| `google_oauth_remove` | Remove Google OAuth config and its local secret `[DESTRUCTIVE]` |
| `totp_configure` | Capture/rotate a validated TOTP seed locally or on a YubiKey `[WRITES]` |
| `totp_remove` | Remove a TOTP binding and local secret `[DESTRUCTIVE]` |
| `m365_password_configure` | Opt in to local M365 webview password autofill `[WRITES]` |
| `m365_password_remove` | Remove an M365 password-autofill binding `[DESTRUCTIVE]` |

Roles can define an enforceable `policy` with `enabled`, `readOnly`, and
`allowedConnectorKinds`. Policy checks happen centrally in the connector
registry, including account-specific routing, so a disabled/read-only context
cannot be bypassed by selecting an account directly. These are work-context
policies; stdio transport does not authenticate distinct human callers and is
therefore not a substitute for multi-user RBAC.

Writes never pick an account on their own. `mail_send`, `mail_draft`,
`calendar_create`, `calendar_update`, `calendar_delete`, `task_add` and
`file_upload` require `account`; without it the call fails and the error lists
the accounts that would have been accepted. `contact_add` requires it as soon as
a remote address book is configured (`local: true` stores locally). Document
writes (`doc_upload`, `doc_tag`, `doc_bulk`) fail when the role leaves more than
one writable Paperless instance.

> **Configuration validation:** startup now fails closed on unknown keys,
> malformed or insecure URLs/ports, invalid IDs, unsupported connector/domain
> combinations, missing required fields, duplicate role IDs, and duplicate
> connector IDs within a role. `connector_capabilities` exposes the same SSOT
> catalog used by validation.

### 📧 Mail (9)

| Tool | Description |
|---|---|
| `mail_list` | List emails from any folder (inbox, sentitems, archive, ...) |
| `mail_read` | Read email as Markdown, listing real attachments and inline images separately |
| `mail_search` | Search emails in every folder, or in one folder when given |
| `mail_send` | Send, reply, or forward an email, with optional file attachments |
| `mail_draft` | Create an email draft (with optional attachments), saved to Drafts |
| `mail_send_draft` | Send an existing draft |
| `mail_update` | Mark read/unread, move to folder, or delete — one message or a batch via `ids` |
| `mail_bulk_update` | Apply one action to every search hit, preview-first |
| `mail_attachment_get` | Fetch an attachment: save to disk, extract its text, or view an image inline |

> **Attachments.** Outgoing files are read from `~/Downloads`, `~/Documents`, or
> `~/Desktop` only (never `~/.eule`), capped at 25 MB. `mail_attachment_get`'s
> `mode` selects `save` (default), `text` (PDF/Office → Markdown via
> pymupdf4llm/pandoc), or `inline` (return an image so the model can see it).
> Saved downloads may additionally use a `~/.eule` subdirectory or the
> platform temporary directory (`/tmp` on POSIX, `%TEMP%` on Windows).
> Attachments on **reply/forward** are supported on Graph, Gmail and IMAP; on the
> EWS fallback tier, attach via a new message or draft instead.
> `mail_send` and `mail_send_draft` accept an optional `idempotency_key` to
> prevent duplicate submission within the running server process.

> **Bulk updates.** `mail_update` takes either `id` or `ids` (up to 200) and
> applies the same action to all of them in one call. The result names the
> **subject and sender** of every message touched, not just a count, because a
> bare "moved to Deleted Items" looks identical whether the id was right or
> wrong. Up to 30 results are listed individually; larger batches are grouped by
> sender with one example subject each (`23× notification@example.com — e.g.
> "…"`) and still carry the exact ids, so a wrong sender is obvious and a
> targeted undo stays possible. A failing id is reported on its own and does not
> abandon the rest of the batch.
>
> **Deleting always moves to the trash folder**, on every provider, and never
> purges. On IMAP this resolves the server's `\Trash` special-use folder (or a
> conventional name such as `Deleted Messages`); only a server with no trash at
> all falls back to setting the `\Deleted` flag.

> **Query-driven bulk actions.** `mail_bulk_update` applies one action to every
> message matching a search. It is **preview-first**: without `confirm_token` it
> reports what *would* be affected and changes nothing. Confirming acts on
> **exactly the previewed messages**, never on a re-run of the query, because
> mail keeps arriving between the two calls and the provider search syntaxes
> differ (Graph `$search`, IMAP `SEARCH`, Gmail `q`), so a re-run can match a
> different set than the one you reviewed. A confirmation token is single-use and
> expires after 15 minutes. Above 50 matches the call additionally requires
> `acknowledge_large: true`. For deletes, prefer an exact sender address over
> free-text: sender filters are far less prone to false matches than subject
> text, and a too-broad filter fails quietly and in breadth. Unlike
> `mail_search`, which covers every folder unless one is given, a bulk action
> searches the inbox unless `folder` names another one.

### 💬 Messenger (3)

| Tool | Description |
|---|---|
| `chat_list` | List recent conversations (Signal, Teams) |
| `chat_read` | Read messages from a conversation |
| `chat_send` | Send a message to a conversation |

### 📁 Files (5)

| Tool | Description |
|---|---|
| `file_search` | Search files in OneDrive/SharePoint/Google Drive |
| `file_read` | Read file content (text extraction) |
| `file_list` | List recently modified files |
| `file_upload` | Upload a file to OneDrive or Google Drive |
| `file_download` | Download a file from OneDrive or Google Drive |

### 📅 Calendar (6)

| Tool | Description |
|---|---|
| `calendar_calendars` | List available calendars across all sources |
| `calendar_list` | List upcoming events from all sources (M365, Google, CalDAV, iCal) |
| `calendar_today` | Today's schedule with attendees and locations |
| `calendar_create` | Create event with optional calendar selection |
| `calendar_update` | Update an existing event |
| `calendar_delete` | Delete an event |

### ✅ Tasks (7)

Tasks live in **your** task system. Eule keeps no task database of its own, so
everything it creates is immediately visible in To Do, Reminders or Nextcloud on
every device, and anything you add there shows up here.

| Tool | Description |
|---|---|
| `task_lists` | List the available task lists across backends |
| `task_list` | List tasks (open by default) |
| `task_search` | Search tasks by title and notes |
| `task_add` | Create a task |
| `task_update` | Update title, notes, due date, priority or completion |
| `task_complete` | Mark a task as done |
| `task_delete` | Delete a task permanently |

Backends:

- **Microsoft To Do** via Graph (`type: m365`). Needs the `Tasks.ReadWrite`
  scope, which is **opt-in** through `oauth.extraScopes` because Thunderbird's
  default registration does not consent it. Point `clientId` at an app that has
  the permission, otherwise every graph login for that client will fail.
  Delegated `/me/todo` has no shared-mailbox form, so `mailbox:` is ignored here.
- **Apple Reminders / Nextcloud Tasks** as VTODO over CalDAV (`type: caldav`).
  Reuses the CalDAV credentials; for iCloud use an app-specific password. Only
  collections that advertise VTODO are treated as task lists.

### 👤 Contacts (3)

| Tool | Description |
|---|---|
| `contact_add` | Add contact to remote address book (Graph, EWS, Google) or locally |
| `contact_list` | List contacts from all sources |
| `contact_search` | Search contacts across all sources |

### 📄 Documents (7)

| Tool | Description |
|---|---|
| `doc_search` | Full-text search across documents (Paperless-NGX) |
| `doc_list` | List recent documents with metadata |
| `doc_read` | Read document metadata and content (OCR text or Markdown via pymupdf4llm) |
| `doc_download` | Download a document file |
| `doc_upload` | Upload a document (with title, tags, correspondent, type) |
| `doc_tag` | Update document metadata (title, tags, correspondent, type) |
| `doc_bulk` | Bulk operations (add/remove tag, set type, delete, merge, reprocess) |

## Provider Matrix

| | Mail | Calendar | Contacts | Tasks | Chat | Files | Documents |
|---|---|---|---|---|---|---|---|
| **M365 Graph** | ✅ rw | ✅ rw | ✅ rw | ✅ rw¹ | ✅ Teams | ✅ rw | — |
| **M365 EWS** | ✅ rw | ✅ rw | ✅ rw | — | — | — | — |
| **Google** | ✅ rw | ✅ rw | ✅ rw | — | — | ✅ rw | — |
| **IMAP/SMTP** | ✅ rw | — | — | — | — | — | — |
| **CalDAV** | — | ✅ rw | — | ✅ rw² | — | — | — |
| **CardDAV** | — | — | ✅ rw | — | — | — | — |
| **iCal Feed** | — | ro | — | — | — | — | — |
| **Signal** | — | — | — | — | ✅ rw | — | — |
| **Paperless-NGX** | — | — | — | — | — | — | ✅ rw |

¹ Microsoft To Do; requires the opt-in `Tasks.ReadWrite` scope.
² VTODO collections: Apple Reminders (iCloud), Nextcloud Tasks.

## Quickstart

### Prerequisites

- Node.js 24+
- An M365 or Google Workspace account
- For native M365 webview login (`auth_login` with `method: webview`, or
  `login --capture`): a desktop session (the `eule-helper` GUI is fetched on
  first use — no manual install)

### Install

```bash
git clone https://github.com/metaneutrons/eule-mcp.git
cd eule-mcp
pnpm install
pnpm run build
```

### Setup

```bash
# Recommended: create a role and connector through the local wizard.
node dist/cli/index.js configure

# Authenticate your M365 account (pick a login method below)
node dist/cli/index.js login --device --tier ews
```

The wizard collects structural settings in the terminal. When a password or API
token is required, a native window carrying the Eule logo opens so it is clear
which application is requesting the credential. The secret is stored in macOS
Keychain, Windows Credential Manager, or Linux Secret Service; `config.yaml`
contains only an opaque `credentialRef`. Existing inline YAML secrets remain
supported for migration, but new setups should use MCP configuration tools or
the wizard.

#### Configure through the AI assistant

For a local desktop MCP client, no YAML setup is required. Ask the assistant to
configure Eule; it can perform this sequence itself:

1. Read `connector_capabilities` and `config_get`.
2. Create a work context with `role_upsert`.
3. Call `connector_configure` for each account/domain binding.
4. If prompted, enter the requested secret in the native Eule window.
5. Use `google_oauth_configure`, `totp_configure`, or the explicitly opt-in
   `m365_password_configure` when applicable, then
   `auth_login` for OAuth providers. When the M365 OAuth client has a registered
   `redirectUri`, the default `method: auto` opens the local Eule webview and
   fills configured password/TOTP values without exposing them to MCP or Node.
6. Verify local secret bindings with `credential_status` and OAuth tokens with
   `auth_accounts`.

Secret capture is a deliberate local-consent boundary: it requires an active
desktop session and cannot be completed silently by the model. Configuration
writes are atomic; rotations use revisioned references, commit the new binding
before deleting the old credential, compensate failed writes, and reject a
configuration changed while the prompt was open.

`credential_status: unavailable` means the native helper or the platform
credential service could not be reached. On Linux, ensure a Secret Service
provider is installed, running, and unlocked; then retry the configure action.

> The old `setup` subcommand is a deprecated alias for `login` — prefer `login`.

#### Login methods

From an MCP client, `auth_login` defaults to `method: auto`. For M365 it selects
the native Eule webview when a registered `redirectUri` is configured or passed
to the call; otherwise it uses browser OAuth. Set `method: browser` or
`method: webview` to choose explicitly. Webview login needs the account email,
an interactive desktop session, and a redirect registered for the configured
OAuth client.

- **Default (no flag):** `node dist/cli/index.js login --tier ews` picks the
  best flow this machine can run. On a desktop session it opens the native
  login window and points it at the ordinary `nativeclient` redirect, so you
  sign in once and nothing has to be copied by hand. Over SSH or without a
  display it uses device code instead. If the helper binary cannot be obtained
  at all (no release for this platform, download blocked), it degrades to
  device code automatically.
- **Device code (cross-platform, no browser redirect):**
  `node dist/cli/index.js login --device --tier ews` — prints a URL + code you
  open on any device. Pure HTTP, works over SSH/headless. Note: a tenant can
  block the device-code flow via Conditional Access (a common anti-phishing
  control) — if the poll never completes, use `--capture`.
- **Browser paste-the-redirect (legacy):** `node dist/cli/index.js login
  --browser --tier graph` — opens a browser and asks you to paste the redirect
  URL back. Superseded by the default flow, which does the same thing without
  the copy-paste. Kept for environments where no helper binary may run *and*
  the tenant blocks device code.
- **Webview capture (cross-platform GUI):**
  `node dist/cli/index.js login --capture --tier ews` — opens a native login
  window via the `eule-helper` binary and intercepts a broker-bound redirect
  (`urn:ietf:wg:oauth:2.0:oob` / custom scheme) that no browser can navigate to.
  The only path that works for clients like "Apple Internet Accounts" when
  device code is CA-blocked. Passing `--capture` explicitly keeps the helper's
  broker default (`oob`) unless you override it with `--redirect-uri`; the
  automatic path above instead targets `nativeclient`, which is what the default
  client registers. The helper writes the token itself — it never
  returns through the MCP/LLM. Configured `autoAuth` password and TOTP bindings
  are resolved directly by the native helper and auto-filled only on Microsoft's
  HTTPS login origin. Pass `--no-password` or `--no-totp` to disable either one
  for a login.
- **Safari (macOS, security keys):**
  `node dist/cli/index.js login --safari --account you@example.com` — signs in
  through your own Safari, which can use security keys and passkeys (the
  embedded webview cannot) and keeps your Microsoft session. See
  [Sign-in through Safari](#sign-in-through-safari).
- **Flags:** `--account <email>`, `--client-id <id>`, `--api-version v1|v2`,
  `--tier graph|ews|imap`, `--redirect-uri <uri>`. Flow overrides: `--capture`,
  `--device`, `--browser`, `--safari`; autofill overrides: `--no-password`,
  `--no-totp`.

The `eule-helper` binary (Rust + `wry` = WKWebView/WebView2/WebKitGTK) is
resolved without making local development depend on an already published
release. Eule uses the first available source in this order:

1. An absolute, explicitly trusted `EULE_HELPER_PATH`.
2. `helper/target/release/eule-helper` (then `debug`) in a source checkout.
3. The GitHub release matching the installed Eule version, checksum-verified
   and cached `0700` in `~/.eule/bin/`.

For example, before the first release exists:

```bash
cargo build --release --manifest-path helper/Cargo.toml
# Automatic in this checkout, or explicit for another installation:
EULE_HELPER_PATH="$PWD/helper/target/release/eule-helper" node dist/cli/index.js login
```

`EULE_HELPER_PATH` must be absolute and executable. It is an explicit local
trust override and is not verified against a GitHub checksum. Prebuilt release
assets for macOS (universal), Linux (x64/arm64), and Windows (x64/arm64) are
created by `.github/workflows/release.yml`. See `helper/` for the source.

#### Locked-down tenants (only a legacy public client is consentable)

Some tenants only consent specific first-party public clients. If Graph is
blocked, EWS via a legacy client on the **v1** endpoint often works. The
"Apple Internet Accounts" client (`f8d98a96-0999-43f5-8af3-69971c7bb423`)
yields `EWS.AccessAsUser.All`; its only redirect URIs are broker-bound
(`urn:ietf:wg:oauth:2.0:oob`), so a plain browser paste won't work:

```
login --capture --tier ews --client-id f8d98a96-… --api-version v1
```

If the tenant permits device code, `login --device …` also works. (A macOS-only
`scripts/apple-oauth-capture.swift` remains as a legacy reference; the Rust
`eule-helper` supersedes it cross-platform.)

The `clientId` and `apiVersion` are stored per token so refresh reuses the
exact app + endpoint that issued it (a mixed v1+v2 store is supported).

The MCP tools or local wizard are the recommended configuration paths. For
unattended or advanced deployments, structural settings can still be managed
directly in `~/.eule/config.yaml`:

```yaml
language: de

roles:
  - id: work
    name: "My Work Role"
    weeklyHours: 40
    connectors:
      mail:
        - id: work-mail
          type: m365
          account: "you@example.com"
      calendar:
        - id: work-cal
          type: m365
          account: "you@example.com"
      messenger:
        - id: teams
          type: m365
          account: "you@example.com"
      files:
        - id: sharepoint
          type: m365
          account: "you@example.com"
```

**Generic IMAP** (iCloud, Gmail, Fastmail, any mail server):

```yaml
google:
  clientId: "123456.apps.googleusercontent.com"
  clientSecretRef: "oauth/google/client-secret.a1b2c3d4"

roles:
  - id: personal
    name: "Personal"
    weeklyHours: 0
    connectors:
      mail:
        - id: gmail
          type: google
          account: "you@gmail.com"
        - id: icloud
          type: imap
          account: "you@icloud.com"
          host: "imap.mail.me.com"
          smtpHost: "smtp.mail.me.com"
          auth: password
          credentialRef: "connector/personal/mail/icloud.a1b2c3d4"
      calendar:
        - id: gcal
          type: google
          account: "you@gmail.com"
      files:
        - id: gdrive
          type: google
          account: "you@gmail.com"
      messenger:
        - id: signal
          type: signal
          account: "+491234567890"
          signalCliUrl: "http://localhost:8080"
      documents:
        - id: paperless
          type: paperless
          account: "paperless.local"
          url: "https://paperless.example.com"
          credentialRef: "connector/personal/documents/paperless.a1b2c3d4"
```

Opaque references are generated and maintained by Eule. Do not invent or copy
them between machines; use `connector_configure`, `credential_rotate`, and
`google_oauth_configure` so the referenced OS credential exists.

### Register with your AI assistant

**Kiro CLI:**

```bash
kiro-cli mcp add --name eule --command node --args "/path/to/eule-mcp/dist/server/index.js"
```

**Claude Desktop / Cursor** — add to your MCP config:

```json
{
  "mcpServers": {
    "eule": {
      "command": "node",
      "args": ["/path/to/eule-mcp/dist/server/index.js"]
    }
  }
}
```

### Optional: M365 password and TOTP autofill

When you log in via the native webview (`auth_login` with `method: auto` or
`webview`, or CLI `login --capture`), Eule can fill a stored password and TOTP
code. Each is a separate opt-in. Capture them via the MCP configuration tools
or CLI credential window:

```bash
node dist/cli/index.js secret totp --account you@example.com
node dist/cli/index.js secret password --account you@example.com
```

The helper validates the base32 seed and stores it directly in the OS credential
store. YAML contains only its generated reference:

```yaml
autoAuth:
  - account: "you@example.com"
    totpSecretRef: "totp/0123456789abcdef.a1b2c3d4"
    passwordSecretRef: "oauth/m365/password/0123456789abcdef.a1b2c3d4"
```

The opaque references—not the values—pass from TypeScript to the helper. The
helper reads both secrets directly from macOS Keychain, Windows Credential
Manager, or Linux Secret Service into zeroizing memory. It never places them in
Node memory, a temporary file, an environment variable, argv, stdout, logs, MCP,
or model context. Password injection is permitted only while the current page is
exactly `https://login.microsoftonline.com`; arbitrary password characters are
JSON-encoded before the one-time field fill. Pass `--no-password` or `--no-totp`
to skip either binding for a login, or add `--remove` to the corresponding
`eule-mcp secret` command to delete it.

This is a security trade-off, not a stronger MFA mode: storing password and
TOTP seed under the same OS principal collocates both factors. Leave either or
both bindings unconfigured when tenant policy or your threat model requires
independent factors. Legacy inline `totpSecret` values are migration-only and
are not forwarded to autofill; run `totp_configure` once to migrate them.

#### TOTP from a YubiKey

The TOTP seed can live in a YubiKey's OATH application instead of the OS
credential store. Eule writes it there once and afterwards only asks the key for
the current code, so the seed no longer sits on the computer and the key stays a
separate factor:

```bash
node dist/cli/index.js secret totp --account you@example.com --yubikey [--touch]
```

The helper checks for a connected key before its window opens, writes the seed
straight to the key, and the config records only the credential name:

```yaml
autoAuth:
  - account: "you@example.com"
    totpYubikey:
      credential: "eule:you@example.com"
      touch: false
```

- `touch: true` makes the key require a touch for every code; the login window
  shows a hint while the key waits. The value is applied when Eule writes the
  credential, so run the command again after changing it. Default: off.
- `--credential <name>` chooses another name. Eule overwrites only the
  credential the account is bound to or its own `eule:<account>`, never another
  credential of that name, such as one added in Yubico Authenticator.
- An existing credential can be bound by setting `totpYubikey.credential` by
  hand; `touch` then has no effect.
- When no code can be had at login (no key, credential missing, OATH
  application password-protected, touch timed out), the window stays open with a
  notice and the code can be typed in.
- `--remove`, or switching back to the OS credential store, leaves the
  credential on the key, since Eule cannot tell whether it wrote it.
- MCP: `totp_configure` with `storage: "yubikey"` and optional `credential` and
  `touch`.
- Supported on macOS and Windows. Linux builds of the helper have no PC/SC
  support and fall back to manual entry.

With `touch: false`, a plugged-in key answers without anyone present.

#### Sign-in through Safari

On macOS the embedded webview cannot reach security keys or passkeys: WebKit
grants that only to browsers Apple entitles and to apps associated with the
site. To sign in with a FIDO2 key such as a YubiKey, Eule uses your own Safari:

```bash
node dist/cli/index.js login --safari --account you@example.com
```

- The helper opens the sign-in in a Safari window of its own, in the
  background and without forcing an account picker. If Safari's Microsoft
  session still holds, Microsoft signs you in without any interaction and the
  window closes again unseen.
- Otherwise Safari comes forward after a few seconds with a notification;
  finish there, e.g. by touching your key. The window then closes and focus
  returns to where you were.
- The helper reads the address of its own window over AppleScript until
  Microsoft lands on the registered `nativeclient` page, checks `state`, and
  redeems the code with PKCE like the webview. macOS asks once whether Safari
  may be controlled; the request may name the app that started Eule.
- A successful sign-in records `login: safari` for the account in `autoAuth`.
  When Microsoft later rejects the account's refresh token, Eule renews the
  sign-in through Safari on its own: one sign-in per account at a time, outside
  the time limit of the tool call that hit it, and after a failure no new
  attempt for ten minutes. Remove `login` to turn this off. MCP:
  `auth_login` with `method: "safari"`.
- A sign-in from Safari's session is as strong as that session: whoever can
  use your unlocked Mac and its Safari can also sign in this way.


After the initial interactive OAuth login, normal M365 access is unattended:
Eule reuses the stored token and refreshes it before expiry. A new user action
is required only when Microsoft revokes/expires the refresh token or Conditional
Access requires a fresh sign-in. With password and TOTP autofill opted in, the
native webview can complete ordinary Microsoft login screens automatically;
Conditional Access, federated identity providers, CAPTCHA, push approval,
passkeys, changed Microsoft UI, or other interactive challenges can still
require the user. The login window may appear briefly and this is not a promise
of fully headless authentication.

## Roadmap

- [x] OAuth with PKCE + opt-in webview password/TOTP autofill
- [x] Device-code login (cross-platform, no redirect URI; CA-blockable)
- [x] Legacy v1 endpoint + per-token client-id/apiVersion (locked-down tenants)
- [x] Webview capture helper (Rust/wry) — cross-platform, signed + notarized releases
- [x] Multi-tier M365 support (Graph / EWS / IMAP)
- [x] Mail tools (list, read, search, send, reply, attachments)
- [x] HTML → Markdown rendering with thread splitting
- [x] Provider-based architecture
- [x] Calendar read/write (Graph + EWS + CalDAV)
- [x] Tasks against the user's own system (Microsoft To Do, Apple Reminders, Nextcloud Tasks)
- [x] Role & context CRUD
- [x] Contacts (local + remote write via Graph/EWS)
- [x] Graph API connectors (Mail + Calendar + Contacts)
- [x] Generic IMAP/SMTP provider (any mail server, password or OAuth)
- [x] CalDAV/CardDAV provider (iCloud, Nextcloud, any CalDAV/CardDAV server)
- [x] iCal feed subscriptions (read-only calendar feeds)
- [ ] Resource planning & capacity tracking
- [x] Paperless-ngx connector
- [ ] Apple Notes (macOS-only, AppleScript/SQLite)
- [ ] Messengers — iMessage (macOS), WhatsApp (Business API), Telegram, Discord, Slack, Matrix
- [x] Google Workspace (Gmail, Calendar, Contacts, and Drive APIs)
- [ ] Auto-auth i18n resilience
- [ ] IETF OAuth for Open Public Clients (`draft-ietf-mailmaint-oauth-public`) — provider-agnostic auth with dynamic client registration
- [ ] Exchange on-premise support (Basic/NTLM auth, configurable EWS URL)
- [ ] sqlite-vec for local semantic search

## Contributing

Contributions are welcome! This project is in early development, so there's plenty to do.

1. Fork the repo
2. Create a feature branch (`git checkout -b feat/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feat/amazing-feature`)
5. Open a Pull Request

Please follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

### Releases and versioning

`package.json` is the single source of truth for the Eule product version. Do
not edit versions or create release tags manually. Release Please watches
Conventional Commits on `main` and maintains a release PR containing the SemVer
bump, `CHANGELOG.md`, Rust helper metadata, and lockfile updates. Merging that
PR creates the `v<version>` GitHub release and builds checksum-protected helper
binaries for every supported platform.

Release publication is gated by the `release` environment. It requires the
Release Please GitHub App credentials and complete Apple signing/notarization
credentials; no unsigned or ad-hoc macOS fallback is published. Build
artefacts include SHA-256 sidecars, SPDX SBOMs, and GitHub build-provenance
attestations.

Maintainers configure `RELEASE_PLEASE_CLIENT_ID` (environment variable) and
`RELEASE_PLEASE_APP_PRIVATE_KEY` (environment secret) for the installed GitHub
App. Apple signing values belong to the same environment; they are never
stored in the repository or workflow files.

- `fix:` produces a patch release.
- `feat:` produces a minor release.
- `feat!:`/`fix!:` or a `BREAKING CHANGE:` footer produces a major release.
- Run `pnpm version:check` locally to verify all release metadata agrees.

Package-registry publication is intentionally separate and is not performed by
the release workflow.

Architecture and security details are documented in
[ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), and
[FINAL_SECURITY_REVIEW.md](FINAL_SECURITY_REVIEW.md).

## License

[GPL-3.0-or-later](LICENSE) — free as in freedom.

---

<p align="center">
  Made with ❤️ and AI in Hannover, Germany
</p>
