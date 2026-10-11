import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ContactService } from "../services/contact-service.js";
import { executeTool, textResult } from "./tool-runtime.js";

export function registerContactTools(server: McpServer, contacts: ContactService): void {
  server.registerTool(
    "contact_add",
    {
      description: "Add a contact to a remote address book or locally",
      inputSchema: {
        name: z.string(),
        email: z.string().optional(),
        phone: z.string().optional(),
        organization: z.string().optional(),
        jobTitle: z.string().optional(),
        role: z.string().optional(),
        account: z
          .string()
          .optional()
          .describe("Address book account; required unless local is true or none is configured"),
        local: z.boolean().optional(),
        notes: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      executeTool("contact_add", async () => {
        const result = await contacts.add(input);
        return result.kind === "remote"
          ? textResult(
              `👤 Contact added to ${result.account} (${result.tier}): ${result.contact.displayName}`,
            )
          : textResult(
              `👤 Contact #${String(result.contact.id)} added locally: ${result.contact.name}`,
            );
      }),
  );

  server.registerTool(
    "contact_list",
    {
      description: "List contacts from all sources",
      inputSchema: { role: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ role }) =>
      executeTool("contact_list", async () => {
        const result = await contacts.list(role);
        const lines = [
          ...result.remote.map(
            (c) =>
              `${c.displayName}${c.email ? ` <${c.email}>` : ""}${c.organization ? ` @ ${c.organization}` : ""}${c.jobTitle ? ` (${c.jobTitle})` : ""}`,
          ),
          ...result.local.map(
            (c) =>
              `[local] ${c.name}${c.email ? ` <${c.email}>` : ""}${c.organization ? ` @ ${c.organization}` : ""}${c.notes ? ` — ${c.notes}` : ""}`,
          ),
          ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
        ];
        return textResult(lines.join("\n") || "No contacts found.");
      }),
  );

  server.registerTool(
    "contact_search",
    {
      description: "Search contacts across all sources",
      inputSchema: { query: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) =>
      executeTool("contact_search", async () => {
        const result = await contacts.search(query);
        const lines = [
          ...result.remote.map(
            (c) =>
              `${c.displayName}${c.email ? ` <${c.email}>` : ""}${c.organization ? ` @ ${c.organization}` : ""}`,
          ),
          ...result.local.map(
            (c) =>
              `[local] ${c.name}${c.email ? ` <${c.email}>` : ""}${c.notes ? ` — ${c.notes}` : ""}`,
          ),
          ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
        ];
        return textResult(lines.join("\n") || "No contacts found.");
      }),
  );
}
