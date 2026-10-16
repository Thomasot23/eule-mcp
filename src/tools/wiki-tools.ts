import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WikiService } from "../services/wiki-service.js";
import type { WikiPage, WikiPageRef } from "../types/index.js";
import { SAVE_PATH_HINT } from "../utils/path-sandbox.js";
import { executeTool, textResult } from "./tool-runtime.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
const role = z.string().optional();
const wiki = z
  .string()
  .optional()
  .describe("Account of the wiki connector to use; only needed when several wikis are configured");

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[...truncated at ${String(maxChars)} chars; pass a larger max_chars or a section]`;
}

const date = (timestamp?: string) => (timestamp ? ` (${timestamp.slice(0, 10)})` : "");
const formatRef = (p: WikiPageRef) =>
  `- ${p.title}${date(p.timestamp)}${p.user ? ` by ${p.user}` : ""}${p.comment ? ` — ${p.comment}` : ""}`;

function formatPage(page: WikiPage, maxChars: number): string {
  return [
    `# ${page.title}`,
    page.redirectedFrom ? `(redirected from ${page.redirectedFrom})` : "",
    `URL: ${page.url}`,
    page.timestamp ? `Last edited: ${page.timestamp}` : "",
    page.categories.length ? `Categories: ${page.categories.join(", ")}` : "",
    page.files.length ? `Files: ${page.files.join(", ")}` : "",
    page.sections.length
      ? `Sections: ${page.sections.map((s) => `${s.index} ${s.title}`).join(" | ")}`
      : "",
    `\n---\n\n${truncate(page.content, maxChars)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function registerWikiTools(server: McpServer, wikis: WikiService): void {
  server.registerTool(
    "wiki_search",
    {
      description:
        "Full-text search in the configured wikis/intranets (MediaWiki, BlueSpice): pages and uploaded files. Returns titles with excerpts; read hits with wiki_read or wiki_file_read.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        namespaces: z
          .array(z.number().int().min(0))
          .optional()
          .describe(
            "Namespace IDs to search (0 = pages, 6 = files). Default: all content namespaces",
          ),
        titles_only: z.boolean().optional(),
        role,
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit, namespaces, titles_only, role }) =>
      executeTool("wiki_search", async () => {
        const r = await wikis.search(query, { role, limit, namespaces, titlesOnly: titles_only });
        const several = new Set(r.values.map((hit) => hit.wiki)).size > 1;
        return textResult(
          [
            ...r.values.map(
              (hit) =>
                `- ${hit.title}${several ? ` [${hit.wiki}]` : ""}${date(hit.timestamp)}${hit.snippet ? `\n  ${hit.snippet}` : ""}`,
            ),
            ...r.failures.map((f) => `⚠️ [${f.account}] ${f.message}`),
          ].join("\n") || "No wiki pages matched the search.",
        );
      }),
  );

  server.registerTool(
    "wiki_read",
    {
      description:
        "Read a wiki page as Markdown (default) or raw wikitext, with its sections, categories and attached files",
      inputSchema: {
        title: z.string().min(1).describe("Page title, including namespace prefix if any"),
        format: z.enum(["markdown", "wikitext"]).optional(),
        section: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Read only this section (index from the Sections line)"),
        max_chars: z.number().int().min(0).optional().describe("Default 20000; 0 = no limit"),
        wiki,
        role,
      },
      annotations: READ_ONLY,
    },
    async ({ title, format, section, max_chars, wiki, role }) =>
      executeTool("wiki_read", async () =>
        textResult(
          formatPage(await wikis.read(title, { role, wiki, format, section }), max_chars ?? 20_000),
        ),
      ),
  );

  server.registerTool(
    "wiki_list",
    {
      description:
        "List wiki pages: members of a category, pages by title prefix, or recently changed pages",
      inputSchema: {
        category: z.string().optional().describe('Category name, with or without "Category:"'),
        prefix: z.string().optional().describe("Title prefix (within namespace)"),
        namespace: z.number().int().min(0).optional(),
        recent: z.boolean().optional().describe("List recently changed pages"),
        limit: z.number().int().min(1).max(500).optional(),
        continue_from: z
          .string()
          .optional()
          .describe("Token from a previous call for the next page"),
        wiki,
        role,
      },
      annotations: READ_ONLY,
    },
    async ({ category, prefix, namespace, recent, limit, continue_from, wiki, role }) =>
      executeTool("wiki_list", async () => {
        const r = await wikis.list({
          category,
          prefix,
          namespace,
          recent,
          limit,
          continueFrom: continue_from,
          role,
          wiki,
        });
        return textResult(
          [
            r.pages.map(formatRef).join("\n") || "No pages found.",
            r.continueFrom ? `\nMore: continue_from="${r.continueFrom}"` : "",
          ].join(""),
        );
      }),
  );

  server.registerTool(
    "wiki_file_read",
    {
      description:
        "Read the text of a file uploaded to the wiki (PDF, Word, Excel, PowerPoint, text). Name with or without File:/Datei: prefix",
      inputSchema: {
        name: z.string().min(1),
        max_chars: z.number().int().min(0).optional().describe("Default 20000; 0 = no limit"),
        wiki,
        role,
      },
      annotations: READ_ONLY,
    },
    async ({ name, max_chars, wiki, role }) =>
      executeTool("wiki_file_read", async () => {
        const { info, text, method } = await wikis.readFile(name, { role, wiki });
        const header = [
          `# ${info.title}`,
          `Type: ${info.mime}, ${String(Math.round(info.size / 1024))}KB${date(info.timestamp)}`,
          `URL: ${info.descriptionUrl}`,
        ].join("\n");
        if (method === "utf-8-fallback" && !info.mime.startsWith("text/"))
          return textResult(
            `${header}\n\n⚠️ No text extraction for ${info.mime}. Use wiki_file_download to save the file.`,
          );
        return textResult(`${header}\n\n---\n\n${truncate(text, max_chars ?? 20_000)}`);
      }),
  );

  server.registerTool(
    "wiki_file_download",
    {
      description: "Save a file uploaded to the wiki to a local folder",
      inputSchema: {
        name: z.string().min(1),
        path: z.string().optional().describe(SAVE_PATH_HINT),
        wiki,
        role,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ name, path, wiki, role }) =>
      executeTool("wiki_file_download", async () => {
        const r = await wikis.download(name, { role, wiki, savePath: path });
        return textResult(`📄 Downloaded: ${r.dest} (${String(Math.round(r.size / 1024))}KB)`);
      }),
  );
}
