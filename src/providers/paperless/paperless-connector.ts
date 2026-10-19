import type {
  DocumentConnector,
  DocDocument,
  DocTag,
  DocCorrespondent,
  DocDocumentType,
  DocBulkMethod,
} from "../../types/index.js";
import { assertResponseSize, assertSecureUrl, fetchWithTimeout } from "../../utils/security.js";
import { LookupCache } from "./lookup-cache.js";

interface PaperlessDoc {
  id: number;
  title: string;
  content?: string;
  correspondent?: number | null;
  document_type?: number | null;
  tags?: number[];
  created?: string;
  modified?: string;
  added?: string;
  archive_serial_number?: number | null;
  original_file_name?: string;
}
interface PaperlessTag {
  id: number;
  name: string;
  colour?: number;
  color?: string;
  match?: string;
  matching_algorithm?: number;
}
interface PaperlessCorrespondent {
  id: number;
  name: string;
  match?: string;
  matching_algorithm?: number;
}
interface PaperlessDocType {
  id: number;
  name: string;
  match?: string;
  matching_algorithm?: number;
}
interface PaperlessPage<T> {
  count: number;
  results: T[];
  next?: string | null;
}

const ALGO_MAP: Record<string, number> = {
  any: 1,
  all: 2,
  exact: 3,
  "regular expression": 4,
  fuzzy: 5,
};

export class PaperlessConnector implements DocumentConnector {
  readonly tier = "paperless";

  constructor(
    readonly account: string,
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** Validated base URL — the API token must never traverse cleartext. */
  private get root(): string {
    return assertSecureUrl(this.baseUrl.replace(/\/+$/, ""), "Paperless URL");
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const url = `${this.root}/api${path}`;
    const hdrs: Record<string, string> = {
      Authorization: `Token ${this.token}`,
      "Content-Type": "application/json",
    };
    if (init?.headers) Object.assign(hdrs, init.headers);
    const res = await fetchWithTimeout(url, { ...init, headers: hdrs });
    if (!res.ok)
      throw new Error(
        `Paperless ${init?.method ?? "GET"} ${path}: ${String(res.status)} ${await res.text()}`,
      );
    assertResponseSize(res);
    return (await res.json()) as T;
  }

  private readonly tagCache = new LookupCache<DocTag[]>();
  private readonly corrCache = new LookupCache<DocCorrespondent[]>();
  private readonly typeCache = new LookupCache<DocDocumentType[]>();

  /** Follow only this lookup endpoint's pages; never forward the token elsewhere. */
  private async lookupPages<T>(path: string): Promise<T[]> {
    const apiRoot = new URL(`${this.root}/api`).href;
    const first = new URL(`${apiRoot}${path}?page_size=200`);
    const seen = new Set<string>();
    const results: T[] = [];
    // Bound the entire chain, not each page: metadata must not consume the tool timeout.
    const signal = AbortSignal.timeout(5_000);
    let next: URL | undefined = first;
    while (next) {
      if (
        next.origin !== first.origin ||
        next.pathname !== first.pathname ||
        next.username ||
        next.password ||
        seen.has(next.href) ||
        seen.size >= 1_000
      ) {
        throw new Error("Paperless returned an unsafe or cyclic lookup pagination URL");
      }
      seen.add(next.href);
      const page: PaperlessPage<T> = await this.req(next.href.slice(apiRoot.length), {
        signal,
        redirect: "error",
      });
      results.push(...page.results);
      next = page.next ? new URL(page.next, next) : undefined;
    }
    return results;
  }

  async listTags(): Promise<DocTag[]> {
    return this.tagCache.get(async () =>
      (await this.lookupPages<PaperlessTag>("/tags/")).map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color ?? (t.colour != null ? `#${String(t.colour)}` : undefined),
        match: t.match,
      })),
    );
  }

  async createTag(
    name: string,
    opts?: { color?: string; match?: string; matchingAlgorithm?: string },
  ): Promise<DocTag> {
    const body: Record<string, unknown> = { name };
    if (opts?.color) body.color = opts.color;
    if (opts?.match) body.match = opts.match;
    if (opts?.matchingAlgorithm) body.matching_algorithm = ALGO_MAP[opts.matchingAlgorithm] ?? 1;
    const t = await this.req<PaperlessTag>("/tags/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    this.tagCache.invalidate();
    return { id: t.id, name: t.name, color: t.color, match: t.match };
  }

  async listCorrespondents(): Promise<DocCorrespondent[]> {
    return this.corrCache.get(async () =>
      (await this.lookupPages<PaperlessCorrespondent>("/correspondents/")).map((c) => ({
        id: c.id,
        name: c.name,
        match: c.match,
      })),
    );
  }

  async createCorrespondent(name: string, opts?: { match?: string }): Promise<DocCorrespondent> {
    const body: Record<string, unknown> = { name };
    if (opts?.match) body.match = opts.match;
    const c = await this.req<PaperlessCorrespondent>("/correspondents/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    this.corrCache.invalidate();
    return { id: c.id, name: c.name, match: c.match };
  }

  async listDocumentTypes(): Promise<DocDocumentType[]> {
    return this.typeCache.get(async () =>
      (await this.lookupPages<PaperlessDocType>("/document_types/")).map((d) => ({
        id: d.id,
        name: d.name,
        match: d.match,
      })),
    );
  }

  async createDocumentType(name: string, opts?: { match?: string }): Promise<DocDocumentType> {
    const body: Record<string, unknown> = { name };
    if (opts?.match) body.match = opts.match;
    const d = await this.req<PaperlessDocType>("/document_types/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    this.typeCache.invalidate();
    return { id: d.id, name: d.name, match: d.match };
  }

  async searchDocuments(query: string, limit = 20): Promise<DocDocument[]> {
    const data = await this.req<PaperlessPage<PaperlessDoc>>(
      `/documents/?query=${encodeURIComponent(query)}&page_size=${String(limit)}`,
    );
    return this.resolveDocuments(data.results);
  }

  async listDocuments(page = 1, pageSize = 25): Promise<DocDocument[]> {
    const data = await this.req<PaperlessPage<PaperlessDoc>>(
      `/documents/?page=${String(page)}&page_size=${String(pageSize)}&ordering=-added`,
    );
    return this.resolveDocuments(data.results);
  }

  async getDocument(id: number): Promise<DocDocument> {
    const d = await this.req<PaperlessDoc>(`/documents/${String(id)}/`);
    return this.resolve(d);
  }

  async downloadDocument(id: number, original = false): Promise<Buffer> {
    const url = `${this.root}/api/documents/${String(id)}/download/${original ? "?original=true" : ""}`;
    const res = await fetchWithTimeout(url, { headers: { Authorization: `Token ${this.token}` } });
    if (!res.ok) throw new Error(`Paperless download: ${String(res.status)}`);
    assertResponseSize(res);
    return Buffer.from(await res.arrayBuffer());
  }

  async uploadDocument(
    file: Buffer,
    filename: string,
    meta?: { title?: string; correspondent?: number; documentType?: number; tags?: number[] },
  ): Promise<DocDocument> {
    const form = new FormData();
    form.append("document", new Blob([new Uint8Array(file)]), filename);
    if (meta?.title) form.append("title", meta.title);
    if (meta?.correspondent) form.append("correspondent", String(meta.correspondent));
    if (meta?.documentType) form.append("document_type", String(meta.documentType));
    for (const t of meta?.tags ?? []) form.append("tags", String(t));
    const url = `${this.root}/api/documents/post_document/`;
    // A POST's fetch resolves only after the whole body is sent, so the default
    // 30s cap would abort large scans mid-upload. Use a generous 10-minute cap:
    // still bounds a truly hung connection, but accommodates big documents.
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { Authorization: `Token ${this.token}` },
        body: form,
      },
      600_000,
    );
    if (!res.ok) throw new Error(`Paperless upload: ${String(res.status)} ${await res.text()}`);
    // post_document returns task ID, not the document. Return a stub.
    return {
      id: 0,
      title: meta?.title ?? filename,
      tags: [],
      content: undefined,
      correspondent: null,
      documentType: null,
    };
  }

  async updateDocument(
    id: number,
    updates: {
      title?: string;
      correspondent?: number | null;
      documentType?: number | null;
      tags?: number[];
    },
  ): Promise<DocDocument> {
    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.correspondent !== undefined) body.correspondent = updates.correspondent;
    if (updates.documentType !== undefined) body.document_type = updates.documentType;
    if (updates.tags !== undefined) body.tags = updates.tags;
    const d = await this.req<PaperlessDoc>(`/documents/${String(id)}/`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return this.resolve(d);
  }

  async bulkEdit(
    ids: number[],
    method: DocBulkMethod,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const body: Record<string, unknown> = { documents: ids, method, ...params };
    await this.req<unknown>("/documents/bulk_edit/", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  private async resolve(d: PaperlessDoc): Promise<DocDocument> {
    const [document] = await this.resolveDocuments([d]);
    if (!document) throw new Error("Paperless returned no document");
    return document;
  }

  private async resolveDocuments(documents: PaperlessDoc[]): Promise<DocDocument[]> {
    if (documents.length === 0) return [];
    const [tags, corrs, types] = await Promise.allSettled([
      this.listTags(),
      this.listCorrespondents(),
      this.listDocumentTypes(),
    ]);
    const index = <T extends { id: number }>(result: PromiseSettledResult<T[]>) =>
      new Map((result.status === "fulfilled" ? result.value : []).map((item) => [item.id, item]));
    const tagIndex = index(tags);
    const corrIndex = index(corrs);
    const typeIndex = index(types);
    return documents.map((d) => {
      const warnings = new Set<string>();
      const lookup = <T extends { id: number; name: string }>(
        items: Map<number, T>,
        id: number,
        label: string,
      ): T | { id: number; name: string } => {
        const item = items.get(id);
        if (item) return item;
        warnings.add(`Paperless ${label} names could not be resolved; raw IDs are shown.`);
        return { id, name: `${label} #${String(id)}` };
      };
      return {
        id: d.id,
        title: d.title,
        content: d.content,
        correspondent:
          d.correspondent != null ? lookup(corrIndex, d.correspondent, "correspondent") : null,
        documentType:
          d.document_type != null ? lookup(typeIndex, d.document_type, "document type") : null,
        tags: (d.tags ?? []).map((id) => lookup(tagIndex, id, "tag")),
        ...(warnings.size ? { warnings: [...warnings] } : {}),
        created: d.created,
        modified: d.modified,
        added: d.added,
        archiveSerialNumber: d.archive_serial_number,
        originalFileName: d.original_file_name,
      };
    });
  }
}
