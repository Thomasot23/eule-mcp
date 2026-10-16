import { mkdirSync, writeFileSync } from "node:fs";
import type { ConnectorRegistry } from "../connectors/index.js";
import type { WikiConnector, WikiFileInfo, WikiListOptions } from "../types/index.js";
import { extractAttachmentText } from "../utils/attachment-extract.js";
import { securePath } from "../utils/path-sandbox.js";
import { collectProviderResults } from "./provider-orchestration.js";

/** Read-only access to configured wikis and intranets (MediaWiki, BlueSpice). */
export class WikiService {
  constructor(private readonly registry: ConnectorRegistry) {}

  private connectors(role?: string): [WikiConnector, ...WikiConnector[]] {
    const [first, ...rest] = this.registry.getWikiConnectors(role);
    if (!first) {
      const scope = role ? ` for role "${role}"` : "";
      throw new Error(
        `No usable wiki connector is configured${scope}. Configure a mediawiki connector with connector_configure and verify its credential with credential_status.`,
      );
    }
    return [first, ...rest];
  }

  /**
   * A page or file lives in one wiki. With several, `wiki` (the connector's
   * account) picks it; without it the call would silently read the first.
   */
  private connector(role?: string, wiki?: string): WikiConnector {
    const connectors = this.connectors(role);
    if (wiki) {
      const match = connectors.find((c) => c.account.toLowerCase() === wiki.toLowerCase());
      if (!match)
        throw new Error(
          `No wiki connector for "${wiki}". Configured: ${connectors.map((c) => c.account).join(", ")}`,
        );
      return match;
    }
    if (connectors.length > 1)
      throw new Error(
        `Several wikis are configured (${connectors.map((c) => c.account).join(", ")}). Pass wiki or a role that selects exactly one.`,
      );
    return connectors[0];
  }

  async search(
    query: string,
    options: { role?: string; limit?: number; namespaces?: number[]; titlesOnly?: boolean } = {},
  ) {
    return collectProviderResults(this.connectors(options.role), async (c) =>
      (await c.search(query, options)).map((hit) => ({ ...hit, wiki: c.account })),
    );
  }

  async read(
    title: string,
    options: {
      role?: string;
      wiki?: string;
      format?: "markdown" | "wikitext";
      section?: number;
    } = {},
  ) {
    return this.connector(options.role, options.wiki).readPage(title, options);
  }

  async list(options: WikiListOptions & { role?: string; wiki?: string }) {
    return this.connector(options.role, options.wiki).listPages(options);
  }

  async readFile(
    name: string,
    options: { role?: string; wiki?: string } = {},
  ): Promise<{ info: WikiFileInfo; text: string; method: string }> {
    const { info, data } = await this.connector(options.role, options.wiki).downloadFile(name);
    const extracted = extractAttachmentText(data, info.name);
    return { info, ...extracted };
  }

  async download(name: string, options: { role?: string; wiki?: string; savePath?: string } = {}) {
    const { info, data } = await this.connector(options.role, options.wiki).downloadFile(name);
    const { dir, dest } = securePath(options.savePath, info.name, "attachments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, data);
    return { dest, size: data.length, info };
  }
}
