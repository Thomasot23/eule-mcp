import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FileService } from "../services/file-service.js";
import { SAVE_PATH_HINT } from "../utils/path-sandbox.js";
import { executeTool, textResult } from "./tool-runtime.js";

const render = (f: {
  name: string;
  size: number;
  lastModified: string;
  id: string;
  path?: string;
  webUrl?: string;
}) =>
  `${f.name} (${String(Math.round(f.size / 1024))}KB, ${f.lastModified.slice(0, 16)})${f.path ? `\n  ${f.path}` : ""}${f.webUrl ? `\n  ${f.webUrl}` : ""}\n  ID: ${f.id}`;

export function registerFileTools(server: McpServer, files: FileService): void {
  server.registerTool(
    "file_search",
    {
      description: "Search files in SharePoint/OneDrive/Google Drive",
      inputSchema: { query: z.string(), role: z.string().optional(), limit: z.number().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query, role, limit }) =>
      executeTool("file_search", async () => {
        const result = await files.search(query, role, limit);
        return textResult(
          [
            ...result.files.map(render),
            ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
          ].join("\n\n") || "No files found.",
        );
      }),
  );
  server.registerTool(
    "file_list",
    {
      description: "List recently modified files",
      inputSchema: { role: z.string().optional(), limit: z.number().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ role, limit }) =>
      executeTool("file_list", async () => {
        const result = await files.list(role, limit);
        return textResult(
          [
            ...result.files.map(render),
            ...result.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
          ].join("\n\n") || "No recent files.",
        );
      }),
  );
  server.registerTool(
    "file_read",
    {
      description: "Read file content with optional line range",
      inputSchema: {
        id: z.string(),
        account: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, account, offset, limit }) =>
      executeTool("file_read", async () => {
        const file = await files.read(id, account, offset, limit);
        return textResult(
          `📄 ${file.name}${file.converted ? " (converted via pandoc)" : ""}\nLines ${String(file.start)}-${String(file.end - 1)} of ${String(file.total)}\n\n${file.content}`,
        );
      }),
  );
  server.registerTool(
    "file_upload",
    {
      description: "Upload a file to OneDrive/Google Drive",
      inputSchema: {
        path: z.string(),
        name: z.string().optional(),
        parentId: z.string().optional(),
        role: z.string().optional(),
        account: z.string().min(1).describe("Account to act on (see account_list)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ path, name, parentId, role, account }) =>
      executeTool("file_upload", async () => {
        const result = await files.upload(path, role, account, name, parentId);
        return textResult(
          `📁 Uploaded: ${result.name}${result.webUrl ? `\n${result.webUrl}` : ""}\nID: ${result.id}`,
        );
      }),
  );
  server.registerTool(
    "file_download",
    {
      description: "Download a file to local disk",
      inputSchema: {
        id: z.string(),
        account: z.string(),
        path: z.string().optional().describe(SAVE_PATH_HINT),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, account, path }) =>
      executeTool("file_download", async () => {
        const result = await files.download(id, account, path);
        return textResult(
          `📥 Downloaded: ${result.name} (${String(Math.round(result.size / 1024))}KB)\n→ ${result.dest}`,
        );
      }),
  );
}
