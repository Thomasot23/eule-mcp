import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { AccessMode } from "../config/index.js";
import type { ConnectorRegistry } from "../connectors/index.js";
import type { DocBulkMethod, DocDocument, DocumentConnector } from "../types/index.js";
import { securePath, secureReadPath } from "../utils/path-sandbox.js";
import { collectProviderResults } from "./provider-orchestration.js";

export class DocumentService {
  constructor(private readonly registry: ConnectorRegistry) {}

  private connectors(
    role?: string,
    mode: AccessMode = "read",
  ): [DocumentConnector, ...DocumentConnector[]] {
    const connectors = this.registry.getDocumentConnectors(role, mode);
    const [first, ...rest] = connectors;
    if (!first) {
      const scope = role ? ` for role "${role}"` : "";
      throw new Error(
        `No usable document connector is configured${scope}. Configure a Paperless connector with connector_configure and verify its credential with credential_status.`,
      );
    }
    return [first, ...rest];
  }

  /**
   * Document tools address Paperless by role, not by account. A write may not
   * pick the first of several instances, so it needs a role that leaves one.
   */
  private writeConnector(role?: string): DocumentConnector {
    const connectors = this.connectors(role, "write");
    if (connectors.length > 1)
      throw new Error(
        `Several document connectors are writable (${connectors.map((c) => c.account).join(", ")}). Pass a role that selects exactly one.`,
      );
    return connectors[0];
  }

  async search(query: string, role?: string, limit = 20) {
    return collectProviderResults(this.connectors(role), (c) => c.searchDocuments(query, limit));
  }
  async list(role?: string, page = 1, pageSize = 25) {
    return collectProviderResults(this.connectors(role), (c) => c.listDocuments(page, pageSize));
  }
  async read(id: number, role?: string): Promise<DocDocument> {
    const c = this.connectors(role)[0];
    return c.getDocument(id);
  }
  async readMarkdown(id: number, role?: string): Promise<string> {
    const connector = this.connectors(role)[0];
    const directory = mkdtempSync(join(tmpdir(), "eule-doc-"));
    const source = join(directory, `${String(id)}.pdf`);
    try {
      writeFileSync(source, await connector.downloadDocument(id));
      return execFileSync(
        "python3",
        ["-c", "import pymupdf4llm,sys; print(pymupdf4llm.to_markdown(sys.argv[1]))", source],
        { maxBuffer: 10 * 1024 * 1024 },
      ).toString();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  async download(id: number, role?: string, original?: boolean, savePath?: string) {
    const c = this.connectors(role)[0];
    const doc = await c.getDocument(id);
    const data = await c.downloadDocument(id, original);
    const name = doc.originalFileName ?? `document-${String(id)}.pdf`;
    const { dir, dest } = securePath(savePath, name, "attachments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, data);
    return { dest, size: data.length };
  }
  async upload(
    path: string,
    role?: string,
    metadata: {
      title?: string;
      correspondent?: number;
      documentType?: number;
      tags?: number[];
    } = {},
  ) {
    const safe = secureReadPath(path);
    if (!existsSync(safe)) throw new Error(`File not found: ${path}`);
    const c = this.writeConnector(role);
    return c.uploadDocument(readFileSync(safe), basename(safe), metadata);
  }
  async update(
    id: number,
    role: string | undefined,
    patch: {
      title?: string;
      correspondent?: number | null;
      documentType?: number | null;
      tags?: number[];
    },
  ) {
    const c = this.writeConnector(role);
    return c.updateDocument(id, patch);
  }
  async bulk(
    ids: number[],
    method: DocBulkMethod,
    role?: string,
    options: { tag?: number; correspondent?: number; document_type?: number } = {},
  ) {
    const c = this.writeConnector(role);
    await c.bulkEdit(ids, method, options);
  }
}
