import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import { WikiService } from "../src/services/wiki-service.js";
import { registerWikiTools } from "../src/tools/wiki-tools.js";
import type { WikiConnector, WikiFileInfo } from "../src/types/index.js";

type Handler = (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

function tools(service: WikiService): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
  } as unknown as McpServer;
  registerWikiTools(server, service);
  return handlers;
}

async function call(handlers: Map<string, Handler>, name: string, input: Record<string, unknown>) {
  const handler = handlers.get(name);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return (await handler(input)).content.map((c) => c.text).join("\n");
}

const fileInfo = (name: string, mime: string): WikiFileInfo => ({
  name,
  title: `Datei:${name}`,
  size: 2048,
  mime,
  timestamp: "2026-09-01T10:00:00Z",
  url: `https://wiki.test/images/${name}`,
  descriptionUrl: `https://wiki.test/w/index.php?title=Datei:${name}`,
});

function connector(account: string, overrides: Partial<WikiConnector> = {}): WikiConnector {
  return {
    account,
    tier: "mediawiki",
    search: vi.fn(async () => [
      { title: "Dienstreise", namespace: 0, snippet: "Antrag", url: "https://wiki.test/x" },
    ]),
    readPage: vi.fn(async () => ({
      title: "Dienstreise",
      pageId: 1,
      url: "https://wiki.test/w/index.php?title=Dienstreise",
      content: "x".repeat(50),
      format: "markdown" as const,
      sections: [{ index: "1", title: "Antrag" }],
      categories: ["Personal"],
      files: ["Antrag.pdf"],
    })),
    listPages: vi.fn(async () => ({
      pages: [{ title: "Dienstreise", namespace: 0, url: "u", user: "Tester", comment: "neu" }],
      continueFrom: "tok",
    })),
    fileInfo: vi.fn(),
    downloadFile: vi.fn(async (name: string) => ({
      info: fileInfo(name, name.endsWith(".png") ? "image/png" : "text/plain"),
      data: Buffer.from("Kostenstelle angeben"),
    })),
    ...overrides,
  };
}

const serviceWith = (...connectors: WikiConnector[]) =>
  new WikiService({ getWikiConnectors: () => connectors } as unknown as ConnectorRegistry);

describe("wiki tools", () => {
  it("names the wiki of each hit only when several wikis answer", async () => {
    const one = await call(tools(serviceWith(connector("intranet"))), "wiki_search", {
      query: "Dienstreise",
    });
    expect(one).toBe("- Dienstreise\n  Antrag");
    const two = await call(
      tools(serviceWith(connector("intranet"), connector("lehre"))),
      "wiki_search",
      { query: "Dienstreise" },
    );
    expect(two).toContain("- Dienstreise [intranet]");
    expect(two).toContain("- Dienstreise [lehre]");
  });

  it("reports a failing wiki next to the hits of the others", async () => {
    const broken = connector("lehre", {
      search: vi.fn(async () => {
        throw new Error("Wiki sign-in failed: nope");
      }),
    });
    const text = await call(tools(serviceWith(connector("intranet"), broken)), "wiki_search", {
      query: "x",
    });
    expect(text).toContain("- Dienstreise");
    expect(text).toContain("⚠️ [lehre] Wiki sign-in failed: nope");
  });

  it("prints page metadata and truncates long content", async () => {
    const text = await call(tools(serviceWith(connector("intranet"))), "wiki_read", {
      title: "Dienstreise",
      max_chars: 10,
    });
    expect(text).toContain("Categories: Personal");
    expect(text).toContain("Files: Antrag.pdf");
    expect(text).toContain("Sections: 1 Antrag");
    expect(text).toContain("[...truncated at 10 chars");
  });

  it("points to wiki_file_read when a page has no text of its own", async () => {
    const filePage = connector("intranet", {
      readPage: vi.fn(async () => ({
        title: "Datei:Plan.pdf",
        pageId: 2,
        url: "u",
        content: "",
        format: "markdown" as const,
        sections: [],
        categories: [],
        files: [],
      })),
    });
    const text = await call(tools(serviceWith(filePage)), "wiki_read", { title: "Datei:Plan.pdf" });
    expect(text).toContain("use wiki_file_read");
  });

  it("hands out a continue token for the next page of a listing", async () => {
    const text = await call(tools(serviceWith(connector("intranet"))), "wiki_list", {
      recent: true,
    });
    expect(text).toBe('- Dienstreise by Tester — neu\nMore: continue_from="tok"');
  });

  it("reads text files and declines binary formats it cannot extract", async () => {
    const handlers = tools(serviceWith(connector("intranet")));
    expect(await call(handlers, "wiki_file_read", { name: "Hinweise.txt" })).toContain(
      "Kostenstelle angeben",
    );
    const image = await call(handlers, "wiki_file_read", { name: "Plan.png" });
    expect(image).toContain("No text extraction for image/png");
    expect(image).not.toContain("Kostenstelle");
  });
});

describe("WikiService file download", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("saves the file under its wiki name in the chosen folder", async () => {
    directory = mkdtempSync(join(tmpdir(), "eule-wiki-"));
    const result = await serviceWith(connector("intranet")).download("Datei:Hinweise.txt", {
      savePath: directory,
    });
    expect(result.dest.endsWith("Hinweise.txt")).toBe(true);
    expect(readFileSync(result.dest, "utf-8")).toBe("Kostenstelle angeben");
  });

  it("names the configured wikis when the requested one is unknown", async () => {
    await expect(
      serviceWith(connector("intranet")).download("x.txt", { wiki: "lehre" }),
    ).rejects.toThrow(/No wiki connector for "lehre". Configured: intranet/);
  });
});
