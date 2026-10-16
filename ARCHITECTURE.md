# Architecture

## Dependency direction

Dependencies point inward. A lower layer must not import from a layer above it.

```text
server bootstrap
  -> MCP tool adapters (src/tools)
    -> application services (src/services)
      -> domain managers and connector ports (src/db, src/types)
        -> provider and persistence adapters (src/providers, src/db)
```

Configuration schemas and policies are cross-cutting domain infrastructure.
Rendering and MCP response construction remain in tool adapters, never in
providers or persistence managers.

## Tool registration standard

New tools must live in a domain registration module and use
`McpServer.registerTool`, including accurate MCP annotations:

- `readOnlyHint` describes whether external or local state can change.
- `destructiveHint` is true for deletion or difficult-to-recover changes.
- `idempotentHint` is true only when repeating the same request is safe.

Handlers run through `executeTool`. This supplies a correlation ID, structured
lifecycle logs, a 30-second default deadline, client cancellation support, and
consistent redacted MCP errors. Application and provider code can access the
active deadline/cancellation signal through the shared execution context.

Tool adapters validate MCP input and format output. Business decisions and
orchestration belong in an application service. Application services depend on
domain interfaces/managers, not MCP types.

## Current extraction status

- `config-tools.ts` -> `ConfigService` -> `ConfigManager`
- `configuration-control-tools.ts` -> `ConfigurationControlService` ->
  `ConfigManager`/`CredentialBroker`
- `task-tools.ts` -> `TaskService` -> `TaskManager`
- `contact-tools.ts` -> `ContactService` -> remote connectors/local manager
- `file-tools.ts` -> `FileService` -> file connectors/sandboxed filesystem
- `document-tools.ts` -> `DocumentService` -> document connectors
- `booking-tools.ts` -> `BookingService` -> booking connectors (anny); writes
  only through user-confirmed, single-use change plans
- `calendar-tools.ts` -> `CalendarService` -> calendar connectors
- `messenger-tools.ts` -> `MessengerService` -> messenger connectors
- `mail-tools.ts` -> `MailService`/`AttachmentService` -> mail connectors
- `auth-tools.ts` -> `AuthService` -> `TokenRepository`/OAuth providers

All tool domains are extracted. `server/index.ts` is composition and process
lifecycle only.

## Credential boundary

The native Rust helper is the credential-entry boundary. Its branded local
window stores connector passwords/API tokens, Google client secrets, TOTP
seeds, and explicitly opted-in M365 passwords in the operating-system
credential store. Secret-bearing fields do not
exist in MCP schemas. Configuration contains only scoped, revisioned references;
the helper's stdout is isolated from the stdio MCP transport. When a provider
needs a value, Node asks the helper to write it to an owner-only temporary file,
reads it, deletes the file immediately, and caches it only for the server
process lifetime. M365 webview password/TOTP values take a stricter path: Node
passes only opaque references and the native OAuth helper reads them directly
into zeroizing memory, with origin-restricted injection. Legacy inline secrets
remain a migration fallback; legacy inline TOTP is not forwarded to autofill.

Helper resolution is centralized: an absolute operator-supplied
`EULE_HELPER_PATH` or a source checkout's Cargo build is used before the
version-matched, checksum-verified release download. This keeps bootstrap and
pre-release development functional without weakening the integrity policy for
installed releases.

`ConfiguredCredentialResolver` is the SSOT for connector/Google resolution and
for selecting opaque M365 auto-auth references. It deliberately does not read
M365 password/TOTP values into Node.

`CONNECTOR_CAPABILITIES` is the single source of truth for supported
connector/domain combinations, required/optional fields, local credential mode,
and the next authentication step. Both schema validation and the read-only
`connector_capabilities` discovery tool use it.

Configuration control operations are compensating transactions:

1. Validate all non-secret metadata before opening a prompt.
2. Capture under a newly revisioned credential reference.
3. Reject the commit if configuration changed while the prompt was open.
4. Atomically persist the new reference.
5. Delete the previous credential only after commit; delete the new credential
   if commit fails.

Per-resource locks serialize conflicting control operations, while the broker
serializes native secret windows. Client cancellation terminates the helper.

## Failure behavior

Unexpected exceptions are converted into an MCP error containing a correlation
ID. Logs contain the same ID, tool name, duration, and outcome. Secrets, tool
arguments, message bodies, and provider payloads must not be included in logs.

Deadlines stop waiting for work but cannot force an external API to terminate.
Provider implementations should use `currentExecutionSignal()` or
`fetchWithExecutionContext()` so cancellation propagates into network I/O.

Execution context lives in `utils/execution-context.ts`, below both the tool and
provider layers. Graph Calendar, Teams, and Signal propagate its abort signal to
their HTTP requests.

Mail reads use bounded partial-provider orchestration. Mutations use explicit
role/account selection, optional idempotency keys, recipient and attachment
limits, and a per-connector exclusive section around legacy signature state.
Graph Mail, Gmail, and timeout-based mail transports inherit execution-context
cancellation.

Multi-provider reads use `collectProviderResults`, which applies a concurrency
limit and returns explicit account-scoped failures alongside successful values.
