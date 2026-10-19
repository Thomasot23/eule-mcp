import { afterEach, describe, expect, it, vi } from "vitest";
import { PaperlessConnector } from "../src/providers/paperless/paperless-connector.js";
import { executeTool, textResult } from "../src/tools/tool-runtime.js";

const document = {
  id: 42,
  title: "Invoice",
  content: "OCR text",
  tags: [1269],
  correspondent: 267,
  document_type: 215,
};
const lookups: Record<string, { id: number; name: string }[]> = {
  tags: [{ id: 1269, name: "Finance" }],
  correspondents: [{ id: 267, name: "Supplier" }],
  document_types: [{ id: 215, name: "Invoice type" }],
};

function mockApi(
  lookup: (kind: string, url: URL, init?: RequestInit) => Response | Promise<Response> = (kind) =>
    Response.json({ results: lookups[kind], next: null }),
) {
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const kind = url.pathname.split("/").filter(Boolean).at(-1)!;
    if (url.pathname.endsWith("/documents/"))
      return Response.json({ results: Array.from({ length: 50 }, () => document) });
    if (url.pathname.endsWith("/documents/42/")) return Response.json(document);
    return lookup(kind, url, init);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const connector = (url = "https://paperless.example.com") =>
  new PaperlessConnector("work", url, "synthetic-token");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Paperless lookup reliability (#78)", () => {
  it("shares lookup requests across 50 search results, list and concurrent reads", async () => {
    const fetch = mockApi();
    const paperless = connector();
    const [search, list, ...reads] = await Promise.all([
      paperless.searchDocuments("invoice", 50),
      paperless.listDocuments(),
      ...Array.from({ length: 3 }, () => paperless.getDocument(42)),
    ]);
    expect(search).toHaveLength(50);
    expect(list).toHaveLength(50);
    expect(reads).toHaveLength(3);
    for (const kind of Object.keys(lookups)) {
      expect(
        fetch.mock.calls.filter(([url]) => String(url).includes(`/api/${kind}/`)),
      ).toHaveLength(1);
    }
    await paperless.getDocument(42);
    expect(fetch).toHaveBeenCalledTimes(9); // Six document requests, three lookup requests.
    expect(search[0]).toMatchObject({
      tags: [{ id: 1269, name: "Finance" }],
      correspondent: { id: 267, name: "Supplier" },
      documentType: { id: 215, name: "Invoice type" },
    });
    expect(search[0]?.warnings).toBeUndefined();
  });

  it("does not cancel shared lookups when the first tool caller disconnects", async () => {
    const pendingLookups: (() => void)[] = [];
    const fetch = mockApi(
      (kind, _url, init) =>
        new Promise<Response>((resolve, reject) => {
          pendingLookups.push(() => resolve(Response.json({ results: lookups[kind] })));
          init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const paperless = connector();
    const cancelled = new AbortController();
    const read = () =>
      executeTool("doc_read", async () =>
        textResult(JSON.stringify(await paperless.getDocument(42))),
      );
    const first = executeTool(
      "doc_read",
      async () => textResult(JSON.stringify(await paperless.getDocument(42))),
      { signal: cancelled.signal },
    );
    await vi.waitFor(() => expect(pendingLookups).toHaveLength(3));
    const second = read();
    // Let the second document request subscribe before cancelling the first tool.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
    cancelled.abort();
    expect((await first).isError).toBe(true);
    for (const finish of pendingLookups) finish();
    const result = await second;
    expect(result.isError).not.toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining('"name":"Finance"'),
    });
    expect(JSON.stringify(result)).not.toContain("warnings");
    expect(fetch).toHaveBeenCalledTimes(5);
    // Cancellation must not leave a rejected, backed-off cache for later callers.
    expect((await paperless.getDocument(42)).warnings).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("follows every lookup page, including reverse-proxy paths and relative next links", async () => {
    const counts: Record<string, number> = { tags: 1269, correspondents: 267, document_types: 215 };
    const fetch = mockApi((kind, url) => {
      const page = Number(url.searchParams.get("page") ?? 1);
      const total = counts[kind]!;
      const end = Math.min(page * 200, total);
      const results = Array.from({ length: end - (page - 1) * 200 }, (_, offset) => {
        const id = (page - 1) * 200 + offset + 1;
        return { id, name: `${kind} ${id}` };
      });
      return Response.json({
        count: total,
        results,
        next:
          end === total
            ? null
            : kind === "tags"
              ? `?page=${page + 1}&page_size=200`
              : `${url.origin}${url.pathname}?page=${page + 1}&page_size=200`,
      });
    });
    const result = await connector("https://paperless.example.com:443/paperless/").getDocument(42);
    expect(result).toMatchObject({
      tags: [{ id: 1269, name: "tags 1269" }],
      correspondent: { id: 267, name: "correspondents 267" },
      documentType: { id: 215, name: "document_types 215" },
    });
    expect(result.warnings).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(12); // Document + 7 tag + 2 correspondent + 2 type pages.
    expect(
      fetch.mock.calls.every(([url]) =>
        new URL(String(url)).pathname.startsWith("/paperless/api/"),
      ),
    ).toBe(true);
  });

  it("returns documents, OCR and raw IDs when one lookup fails without leaking its response", async () => {
    const fetch = mockApi((kind) =>
      kind === "correspondents"
        ? new Response("sensitive upstream detail", { status: 500 })
        : Response.json({ results: lookups[kind] }),
    );
    const results = await connector().searchDocuments("invoice");
    expect(results).toHaveLength(50);
    expect(results[0]).toMatchObject({
      content: "OCR text",
      correspondent: { id: 267, name: "correspondent #267" },
      tags: [{ id: 1269, name: "Finance" }],
      warnings: ["Paperless correspondent names could not be resolved; raw IDs are shown."],
    });
    expect(JSON.stringify(results)).not.toContain("sensitive upstream detail");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("preserves every raw reference when all lookups fail or omit IDs", async () => {
    mockApi(() => Promise.reject(new Error("offline")));
    const failed = await connector().getDocument(42);
    expect(failed).toMatchObject({
      tags: [{ id: 1269, name: "tag #1269" }],
      correspondent: { id: 267, name: "correspondent #267" },
      documentType: { id: 215, name: "document type #215" },
    });
    expect(failed.warnings).toHaveLength(3);
    mockApi(() => Response.json({ results: [] }));
    expect(await connector().getDocument(42)).toEqual(failed);
  });

  it("still rejects document-fetch failures rather than returning an empty search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    await expect(connector().searchDocuments("invoice")).rejects.toThrow("503");
  });

  it("does not fetch metadata for empty search results", async () => {
    const fetch = vi.fn(async () => Response.json({ results: [] }));
    vi.stubGlobal("fetch", fetch);
    await expect(connector().searchDocuments("nothing")).resolves.toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes successful caches after 60 seconds", async () => {
    vi.useFakeTimers();
    const fetch = mockApi();
    const paperless = connector();
    await paperless.getDocument(42);
    await vi.advanceTimersByTimeAsync(59_999);
    await paperless.getDocument(42);
    expect(fetch).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1);
    await paperless.getDocument(42);
    expect(fetch).toHaveBeenCalledTimes(9);
  });

  it("backs off failed lookups briefly, then retries instead of poisoning the cache", async () => {
    vi.useFakeTimers();
    let failing = true;
    const fetch = mockApi((kind) => {
      if (kind === "tags" && failing) return new Response("unavailable", { status: 500 });
      return Response.json({ results: lookups[kind] });
    });
    const paperless = connector();
    expect((await paperless.getDocument(42)).warnings).toHaveLength(1);
    failing = false;
    expect((await paperless.getDocument(42)).warnings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await paperless.getDocument(42)).warnings).toBeUndefined();
    expect(fetch.mock.calls.filter(([url]) => String(url).includes("/tags/"))).toHaveLength(2);
  });

  it("degrades hung lookup requests after a shared five-second budget", async () => {
    vi.useFakeTimers();
    // Node's native AbortSignal.timeout is not driven by Vitest's fake clock.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    mockApi(
      (_kind, _url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const pending = connector().getDocument(42);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).warnings).toHaveLength(3);
    expect(timeout.mock.calls).toEqual([[5_000], [5_000], [5_000]]);
  });

  it("does not return a silently truncated list if a later page fails", async () => {
    mockApi((_kind, url) =>
      url.searchParams.has("page")
        ? new Response("failed page", { status: 500 })
        : Response.json({ results: [{ id: 1269, name: "Finance" }], next: "?page=2" }),
    );
    const paperless = connector();
    await expect(paperless.listTags()).rejects.toThrow("500");
    const result = await paperless.getDocument(42);
    expect(result.tags).toEqual([{ id: 1269, name: "tag #1269" }]);
    expect(result.warnings).toHaveLength(3);
  });

  it.each([
    "https://attacker.example/api/tags/?page=2",
    "http://paperless.example.com/api/tags/?page=2",
    "https://paperless.example.com/api/documents/",
    "https://user:pass@paperless.example.com/api/tags/?page=2",
    "?page_size=200",
  ])("rejects unsafe or cyclic pagination before forwarding credentials: %s", async (next) => {
    const fetch = mockApi(() => Response.json({ results: [], next }));
    await expect(connector().listTags()).rejects.toThrow(/unsafe or cyclic/);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it.each([
    ["tags", "createTag"],
    ["correspondents", "createCorrespondent"],
    ["document_types", "createDocumentType"],
  ] as const)("invalidates only %s after a successful create", async (kind, method) => {
    const fetch = mockApi((lookup, _url, init) =>
      init?.method === "POST"
        ? Response.json({ id: 9999, name: "New" })
        : Response.json({ results: lookups[lookup] }),
    );
    const paperless = connector();
    await paperless.getDocument(42);
    switch (method) {
      case "createTag":
        await paperless.createTag("New");
        break;
      case "createCorrespondent":
        await paperless.createCorrespondent("New");
        break;
      case "createDocumentType":
        await paperless.createDocumentType("New");
        break;
    }
    await paperless.getDocument(42);
    for (const lookup of Object.keys(lookups)) {
      const gets = fetch.mock.calls.filter(
        ([url, init]) => String(url).includes(`/api/${lookup}/`) && init?.method !== "POST",
      );
      expect(gets).toHaveLength(lookup === kind ? 2 : 1);
    }
  });
});
