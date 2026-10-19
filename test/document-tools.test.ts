import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DocumentService } from "../src/services/document-service.js";
import { registerDocumentTools } from "../src/tools/document-tools.js";

describe("document tool metadata degradation", () => {
  it.each(["doc_search", "doc_list", "doc_read", "doc_tag"])(
    "%s shows unresolved IDs and warnings instead of hiding them",
    async (tool) => {
      const document = {
        id: 42,
        title: "Invoice",
        content: "OCR text",
        tags: [{ id: 1269, name: "tag #1269" }],
        warnings: ["Paperless tag names could not be resolved; raw IDs are shown."],
      };
      const handlers = new Map<
        string,
        (args: Record<string, unknown>) => Promise<CallToolResult>
      >();
      const server = {
        registerTool(
          name: string,
          _schema: unknown,
          handler: (args: Record<string, unknown>) => Promise<CallToolResult>,
        ) {
          handlers.set(name, handler);
        },
      } as unknown as McpServer;
      const docs = {
        search: async () => ({ values: [document], failures: [] }),
        list: async () => ({ values: [document], failures: [] }),
        read: async () => document,
        update: async () => document,
      } as unknown as DocumentService;
      registerDocumentTools(server, docs);
      const result = await handlers.get(tool)!({ id: 42, query: "invoice" });
      expect(result.isError).not.toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("tag #1269"),
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining(
          "⚠️ Paperless tag names could not be resolved; raw IDs are shown.",
        ),
      });
    },
  );
});
