import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AuthService } from "../services/auth-service.js";
import { executeTool, textResult } from "./tool-runtime.js";

export function registerAuthTools(
  server: McpServer,
  auth: AuthService,
  updateNotice: () => string | undefined = () => undefined,
): void {
  server.registerTool(
    "auth_status",
    {
      description: "Show authentication and configuration status",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_input, extra) =>
      executeTool(
        "auth_status",
        () => {
          const status = auth.status();
          const notice = updateNotice();
          const roles = status.roles.map(
            (r) =>
              `  ${r.id}: ${r.name} (${String(r.weeklyHours)}h/week, ${String(r.mail)} mail, ${String(r.calendar)} cal)`,
          );
          const accounts = status.accounts.map(
            (a) =>
              `  ${a.account}: ${a.provider}/${a.tier}, ${a.health}, expires ${new Date(a.expiresAt).toISOString()}`,
          );
          return textResult(
            [
              `Language: ${status.language}`,
              `Roles (${String(status.roles.length)}):`,
              ...roles,
              "",
              `Authenticated accounts (${String(accounts.length)}):`,
              ...(accounts.length
                ? accounts
                : ["  none — use auth_login (or run 'eule-mcp login') to add an account"]),
              "",
              `Data: ${status.dataPath}`,
              ...(notice ? ["", notice] : []),
            ].join("\n"),
          );
        },
        { signal: extra.signal },
      ),
  );
  server.registerTool(
    "auth_accounts",
    {
      description: "List authenticated accounts without exposing tokens",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_input, extra) =>
      executeTool(
        "auth_accounts",
        () =>
          textResult(
            auth
              .inventory()
              .map(
                (a) =>
                  `${a.account} [${a.provider}/${a.tier}] ${a.health}\n  Expires: ${new Date(a.expiresAt).toISOString()}`,
              )
              .join("\n\n") || "No authenticated accounts.",
          ),
        { signal: extra.signal },
      ),
  );
  server.registerTool(
    "auth_login",
    {
      description:
        "Authenticate an M365 or Google account. For M365, auto uses the native Eule webview when a registered redirectUri is configured and locally fills any opt-in password/TOTP bindings; otherwise it opens browser OAuth. Without tier, the tier already stored for the account is reused (default graph). Existing refresh tokens are renewed automatically.",
      inputSchema: {
        account: z.email().optional(),
        tier: z
          .enum(["graph", "ews", "imap", "google"])
          .optional()
          .describe("Defaults to the tier already stored for the account, otherwise graph."),
        method: z
          .enum(["auto", "browser", "webview", "safari"])
          .optional()
          .describe(
            "Login UI. auto (default) selects the Eule webview when a registered redirectUri is configured or supplied; webview is M365-only. safari (M365, macOS) signs in through the user's Safari, which supports security keys such as a YubiKey and reuses Safari's Microsoft session; afterwards a dead sign-in for the account is renewed through Safari automatically.",
          ),
        redirectUri: z
          .url()
          .optional()
          .describe(
            "M365 webview only: broker/custom redirect URI registered for the configured OAuth client.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account, tier, method, redirectUri }, extra) =>
      executeTool(
        "auth_login",
        async () => {
          const token = await auth.login({
            tier,
            account,
            method,
            redirectUri,
          });
          return textResult(
            `✅ Authenticated: ${token.account}\nTier: ${token.tier}\nExpires: ${new Date(token.expiresAt).toISOString()}`,
          );
        },
        { timeoutMs: 10 * 60 * 1000, signal: extra.signal },
      ),
  );
  server.registerTool(
    "auth_probe",
    {
      description: "Probe the configured API tier for an account",
      inputSchema: { account: z.email() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account }, extra) =>
      executeTool(
        "auth_probe",
        async () => {
          const result = await auth.probe(account);
          return textResult(
            `Account: ${account.toLowerCase()}\nCurrent tier: ${result.tier}\nProbe result: ${result.result}`,
          );
        },
        { signal: extra.signal },
      ),
  );
  server.registerTool(
    "auth_logout",
    {
      description: "Remove locally stored tokens for an account; remote grants are not revoked",
      inputSchema: { account: z.email() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ account }, extra) =>
      executeTool(
        "auth_logout",
        () =>
          textResult(
            auth.logout(account)
              ? `✅ Removed local tokens for ${account.toLowerCase()}`
              : `No stored tokens for ${account.toLowerCase()}`,
          ),
        { signal: extra.signal },
      ),
  );
}
