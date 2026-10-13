import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { UpdateService } from "../services/update-service.js";
import { executeTool, textResult } from "./tool-runtime.js";

export function registerUpdateTools(server: McpServer, updates: UpdateService): void {
  server.registerTool(
    "eule_update",
    {
      description:
        'Check for a newer Eule release ("status") or download its verified extension bundle to ~/Downloads ("download"). Installing the bundle is up to the user (double-click it); Eule never replaces itself.',
      inputSchema: { action: z.enum(["status", "download"]).optional() },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ action }, extra) =>
      executeTool(
        "eule_update",
        async () => {
          if (action === "download") {
            const { path, version } = await updates.download();
            return textResult(
              `✅ Eule ${version} saved to ${path} (SHA-256 verified). Double-click it to install the update in Claude Desktop, then start a new session.`,
            );
          }
          const status = await updates.status(true);
          if (!status.latest)
            return textResult(
              `Installed: Eule ${status.current}. The latest release could not be determined (offline?).`,
            );
          return textResult(
            [
              `Installed: Eule ${status.current}`,
              `Latest release: ${status.latest.version} (${status.latest.url})`,
              status.updateAvailable
                ? 'Update available. Use action "download" to fetch the bundle.'
                : "Eule is up to date.",
            ].join("\n"),
          );
        },
        { signal: extra.signal, timeoutMs: 120_000 },
      ),
  );
}
