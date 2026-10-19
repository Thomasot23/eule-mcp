import { describe, expect, it } from "vitest";
import { MediaWikiConnector } from "../src/providers/mediawiki/index.js";
import { WikiService } from "../src/services/wiki-service.js";
import type { ConnectorRegistry } from "../src/connectors/index.js";

/**
 * Opt-in check against a real wiki, e.g. a local MediaWiki container or the
 * production intranet. Set EULE_MW_LIVE_URL, EULE_MW_LIVE_USER and
 * EULE_MW_LIVE_PASSWORD; EULE_MW_LIVE_QUERY, _PAGE, _CATEGORY and _FILE pick
 * content that exists there (the page defaults to the first search hit).
 * Read-only: it only signs in and reads.
 */
const env = process.env;
const url = env.EULE_MW_LIVE_URL;
const user = env.EULE_MW_LIVE_USER;
const password = env.EULE_MW_LIVE_PASSWORD;

describe.skipIf(!url || !user || !password)("MediaWiki live", () => {
  const connector = () => new MediaWikiConnector(user ?? "", url ?? "", password ?? "");

  // A production wiki answers slower than the 5 s vitest default.
  const timeout = 60_000;

  it("signs in and finds pages", { timeout }, async () => {
    const hits = await connector().search(env.EULE_MW_LIVE_QUERY ?? "Dienstreise");
    expect(hits.length).toBeGreaterThan(0);
  });

  it("reads a page as Markdown and as wikitext", { timeout }, async () => {
    // The first hit that is a page, not an uploaded file.
    const title =
      env.EULE_MW_LIVE_PAGE ??
      (await connector().search(env.EULE_MW_LIVE_QUERY ?? "Dienstreise")).find(
        (hit) => hit.namespace !== 6,
      )?.title ??
      "";
    const markdown = await connector().readPage(title);
    expect(markdown.content.length).toBeGreaterThan(0);
    const wikitext = await connector().readPage(title, { format: "wikitext" });
    expect(wikitext.pageId).toBe(markdown.pageId);
  });

  it("lists recent changes", { timeout }, async () => {
    const recent = await connector().listPages({ recent: true, limit: 5 });
    expect(recent.pages.length).toBeGreaterThan(0);
  });

  it.skipIf(!env.EULE_MW_LIVE_CATEGORY)("lists a category", { timeout }, async () => {
    const category = await connector().listPages({ category: env.EULE_MW_LIVE_CATEGORY ?? "" });
    expect(category.pages.length).toBeGreaterThan(0);
  });

  it.skipIf(!env.EULE_MW_LIVE_FILE)("reads the text of an uploaded file", { timeout }, async () => {
    const service = new WikiService({
      getWikiConnectors: () => [connector()],
    } as unknown as ConnectorRegistry);
    const file = await service.readFile(env.EULE_MW_LIVE_FILE ?? "");
    expect(file.text.trim().length).toBeGreaterThan(0);
  });
});
