# Security Policy

Eule is an MCP server that an AI assistant drives on your behalf. It holds
mail, calendar, contact, file and document credentials, so the threat model
assumes **tool arguments are untrusted** — a model can be steered by
prompt-injection embedded in an email, document or calendar item it just read.

## Reporting a vulnerability

Please report security issues privately via GitHub Security Advisories
(**Security → Report a vulnerability**) on this repository, or by email to the
maintainer, rather than opening a public issue. We aim to acknowledge reports
within a few days.

## Hardening in place

- **No mail header injection.** Recipient/subject header values are rejected or
  encoded if they contain CR/LF, so a crafted address or subject cannot smuggle
  a hidden `Bcc:` or extra headers (`src/utils/security.ts`, mail connectors).
- **No upstream injection.** EWS SOAP, Microsoft Graph OData `$filter`, Graph
  URL path segments, and iCalendar/vCard values are escaped/encoded before use.
- **Secrets at rest.** Connector passwords/API tokens, Google client secrets,
  TOTP seeds, and explicitly opted-in M365 passwords created through MCP or the
  CLI are stored in macOS Keychain,
  Windows Credential Manager, or Linux Secret Service; YAML retains only opaque,
  scoped references. Legacy inline secrets remain supported for migration.
  `~/.eule` is `0700`, while `config.yaml`, `tokens.json` and `anny-tokens.json`
  are atomically written `0600`. OAuth access/refresh tokens remain
  permission-protected in those files, not encrypted by the OS credential store.
  anny sessions live in their own file so an SSO login with the same e-mail
  address cannot overwrite a Microsoft 365 token. The same file caches the
  public OAuth client ID Eule registers at anny (RFC 7591 dynamic client
  registration, `token_endpoint_auth_method: none`, PKCE S256); it is not a
  secret. Endpoints from anny's OAuth metadata are accepted only if they are
  `https://` on the auth origin itself, so a tampered metadata document cannot
  redirect authorization codes or tokens to another host.
- **TLS enforced for credentialed connectors.** CalDAV, CardDAV, Paperless and
  anny URLs must be `https://` (loopback `http://` is allowed for local tools). SMTP
  uses `requireTLS` so a stripped-STARTTLS MITM cannot downgrade to cleartext.
- **Filesystem sandbox.** Downloads may only be written under
  `~/.eule/<subdir>`, `~/Downloads`, `~/Documents`, `~/Desktop`, or the
  operating system's temporary directory. Reserved files (`config.yaml`,
  `tokens.json`, `eule.db`) are excluded. Local files chosen for
  upload may only be read from `~/Downloads`, `~/Documents` or `~/Desktop` —
  **never** `~/.eule` or arbitrary paths — so secrets cannot be exfiltrated to
  the cloud.
- **Resource limits.** Tool calls have deadlines, multi-provider reads have
  bounded concurrency, supported HTTP providers receive cancellation signals,
  and buffered remote responses are size-capped. Some third-party protocol
  libraries cannot force-cancel in-flight socket work; see
  `FINAL_SECURITY_REVIEW.md`.
- **Auth secrets bypass the model.** Access/refresh tokens and OAuth
  authorization codes are obtained through an interactive browser, CLI, or the
  native `eule-helper`, then written directly to `tokens.json`. MCP auth tools
  return only account, provider, tier, expiry, and health metadata. The helper's
  branded `secret-prompt` window writes entered values directly to the native
  credential store without exposing them to the model, stdout, argv, or logs.
- **Transactional secret changes.** Secret-bearing MCP schemas do not exist.
  Metadata is validated before prompting; revisioned credential swaps commit
  config before old-secret deletion and remove newly captured credentials on a
  failed/stale write. The native helper's stdout is isolated from MCP stdout,
  prompts are serialized, and cancellation terminates the helper process.
- **Tool policy and routing.** Work-context policies centrally enforce enabled,
  read-only, and connector-domain restrictions. Mutations are role/account
  scoped; these controls are not multi-human RBAC because stdio has one OS
  principal.
- **Auditable execution.** Tool failures include correlation IDs; structured
  lifecycle logs exclude arguments, bodies, tokens, and provider payloads.
- **Helper integrity.** Installed releases download `eule-helper` from this
  repository's matching GitHub release, verify its published SHA-256, and cache
  it `0700` before execution. Source checkouts may use their own Cargo build;
  operators may also set an absolute `EULE_HELPER_PATH`. Those two development
  paths are local trust decisions and deliberately bypass release checksums.
  Relative overrides are rejected. The released macOS build is a Developer-ID-
  signed, notarized universal binary (hardened runtime + secure timestamp).
- **M365 autofill is explicit opt-in and helper-local.** TypeScript passes only
  scoped OS-store references to `eule-helper`; the helper reads password/TOTP
  values directly into zeroizing memory. They never traverse Node, a temporary
  file, an environment variable, argv, stdout, logs, MCP, or model context.
  Password and generated-code injection are gated twice on the exact
  `https://login.microsoftonline.com` origin, and arbitrary password bytes are
  JSON-encoded before the one-time fill. OAuth redirects require an exact base
  URI, matching OAuth state, and PKCE. Stored password and TOTP each reduce the
  security gained from independent factors, so both are disabled until
  separately configured by the user in Eule's branded local prompt.
- **A TOTP seed can stay on a YubiKey instead.** With `totpYubikey`, the seed
  goes from the helper's local window straight into the key's OATH application;
  config and Node hold only the credential name. At login the helper asks the
  key for the current code over PC/SC and keeps it in zeroizing memory until
  the gated fill. The key then remains a separate factor, and with `touch: true`
  every code needs physical presence. Eule refuses to overwrite a credential of
  the same name it is not bound to, and never deletes a credential from the key
  when a binding is removed. A password-protected OATH application is not
  unlocked; login falls back to manual code entry.
- **Safari sign-in reads only its own window.** `oauth-safari` opens the
  authorize URL in a Safari window it created and polls that window's address
  over AppleScript; arguments reach `osascript` as argv instead of being
  written into the script. It accepts only a redirect to the configured URI with the matching
  `state`, redeems the code with PKCE, and closes the window. A silent sign-in
  rides on Safari's Microsoft session and is as strong as that session.
  Automatic renewal through Safari runs only for accounts with
  `autoAuth[].login: safari`, only after Microsoft has rejected the refresh
  token, once at a time per account, and not again for ten minutes after a
  failure.
- **Auth debug artifacts** (DOM/screenshots of the login flow) are written only
  when `EULE_AUTH_DEBUG` is set, and then `0600`.

## Supported versions

This project is pre-1.0 and under active development; only the latest `main`
receives security fixes.

For the complete reviewed posture and residual risks, see
[`FINAL_SECURITY_REVIEW.md`](FINAL_SECURITY_REVIEW.md).
