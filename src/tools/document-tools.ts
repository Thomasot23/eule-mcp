import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DocumentService } from "../services/document-service.js";
import type { DocDocument } from "../types/index.js";
import { SAVE_PATH_HINT } from "../utils/path-sandbox.js";
import { executeTool, textResult } from "./tool-runtime.js";

const formatDoc = (d: DocDocument) => {
  const tags = d.tags.map((t) => t.name).join(", ");
  return [
    `#${String(d.id)} ${d.title}${d.correspondent ? ` | ${d.correspondent.name}` : ""}${d.documentType ? ` [${d.documentType.name}]` : ""}${tags ? ` {${tags}}` : ""}${d.created ? ` (${d.created.slice(0, 10)})` : ""}`,
    ...(d.warnings ?? []).map((warning) => `⚠️ ${warning}`),
  ].join("\n");
};
const bulkMethod = z.enum([
  "add_tag",
  "remove_tag",
  "set_correspondent",
  "set_document_type",
  "delete",
  "reprocess",
  "merge",
]);

export function registerDocumentTools(server: McpServer, docs: DocumentService): void {
  server.registerTool(
    "doc_search",
    {
      description: "Full-text search across documents",
      inputSchema: { query: z.string(), limit: z.number().optional(), role: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit, role }) =>
      executeTool("doc_search", async () => {
        const r = await docs.search(query, role, limit);
        return textResult(
          [
            ...r.values.map(formatDoc),
            ...r.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
          ].join("\n") || "No documents matched the search in the configured connector(s).",
        );
      }),
  );
  server.registerTool(
    "doc_list",
    {
      description: "List recent documents",
      inputSchema: {
        page: z.number().optional(),
        page_size: z.number().optional(),
        role: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ page, page_size, role }) =>
      executeTool("doc_list", async () => {
        const r = await docs.list(role, page, page_size);
        return textResult(
          [
            ...r.values.map(formatDoc),
            ...r.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
          ].join("\n") || "No documents found in the configured connector(s).",
        );
      }),
  );
  server.registerTool(
    "doc_read",
    {
      description: "Read document metadata and OCR content",
      inputSchema: {
        id: z.number(),
        format: z.enum(["text", "markdown"]).optional(),
        role: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ id, format, role }) =>
      executeTool("doc_read", async () => {
        const d = await docs.read(id, role);
        let content = d.content?.slice(0, 4000) ?? "";
        if (format === "markdown") {
          try {
            content = await docs.readMarkdown(id, role);
          } catch (error) {
            content = `⚠️ Markdown conversion unavailable: ${error instanceof Error ? error.message : String(error)}\n\n${content}`;
          }
        }
        return textResult(
          [
            formatDoc(d),
            d.originalFileName ? `File: ${d.originalFileName}` : "",
            d.archiveSerialNumber ? `ASN: ${String(d.archiveSerialNumber)}` : "",
            content ? `\n---\n\n${content}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }),
  );
  server.registerTool(
    "doc_download",
    {
      description: "Download a document file",
      inputSchema: {
        id: z.number(),
        original: z.boolean().optional(),
        path: z.string().optional().describe(SAVE_PATH_HINT),
        role: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, original, path, role }) =>
      executeTool("doc_download", async () => {
        const r = await docs.download(id, role, original, path);
        return textResult(`📄 Downloaded: ${r.dest} (${String(Math.round(r.size / 1024))}KB)`);
      }),
  );
  server.registerTool(
    "doc_upload",
    {
      description: "Upload a document to Paperless-NGX",
      inputSchema: {
        path: z.string(),
        title: z.string().optional(),
        correspondent: z.number().optional(),
        document_type: z.number().optional(),
        tags: z.array(z.number()).optional(),
        role: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ path, title, correspondent, document_type, tags, role }) =>
      executeTool("doc_upload", async () => {
        const d = await docs.upload(path, role, {
          title,
          correspondent,
          documentType: document_type,
          tags,
        });
        return textResult(`📄 Uploaded: ${d.title} — document is being processed by Paperless`);
      }),
  );
  server.registerTool(
    "doc_tag",
    {
      description: "Update document metadata",
      inputSchema: {
        id: z.number(),
        title: z.string().optional(),
        correspondent: z.number().nullable().optional(),
        document_type: z.number().nullable().optional(),
        tags: z.array(z.number()).optional(),
        role: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, title, correspondent, document_type, tags, role }) =>
      executeTool("doc_tag", async () =>
        textResult(
          `✅ Updated: ${formatDoc(await docs.update(id, role, { title, correspondent, documentType: document_type, tags }))}`,
        ),
      ),
  );
  server.registerTool(
    "doc_bulk",
    {
      description: "Bulk operations on documents",
      inputSchema: {
        ids: z.array(z.number()).min(1),
        method: bulkMethod,
        tag: z.number().optional(),
        correspondent: z.number().optional(),
        document_type: z.number().optional(),
        role: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ ids, method, tag, correspondent, document_type, role }) =>
      executeTool("doc_bulk", async () => {
        await docs.bulk(ids, method, role, { tag, correspondent, document_type });
        return textResult(`✅ Bulk ${method} applied to ${String(ids.length)} documents`);
      }),
  );
}
