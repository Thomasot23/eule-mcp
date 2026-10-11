import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { ConnectorRegistry } from "../connectors/index.js";
import type { FileResult } from "../types/index.js";
import { cachedFileRead } from "../utils/file-cache.js";
import { securePath, secureReadPath } from "../utils/path-sandbox.js";
import {
  collectProviderResults,
  requireConnector,
  selectConnector,
  type ProviderFailure,
} from "./provider-orchestration.js";

export class FileService {
  constructor(private readonly registry: ConnectorRegistry) {}

  async search(
    query: string,
    role?: string,
    limit = 20,
  ): Promise<{ files: FileResult[]; failures: ProviderFailure[] }> {
    const result = await collectProviderResults(
      this.registry.getFileConnectors(role),
      (connector) => connector.search(query, limit),
    );
    return { files: result.values, failures: result.failures };
  }

  async list(
    role?: string,
    limit = 20,
  ): Promise<{ files: FileResult[]; failures: ProviderFailure[] }> {
    const result = await collectProviderResults(
      this.registry.getFileConnectors(role),
      (connector) => connector.listRecent(limit),
    );
    return { files: result.values, failures: result.failures };
  }

  async read(id: string, account: string, offset = 0, limit?: number) {
    const connector = selectConnector(this.registry.getFileConnectors(), account);
    if (!connector) throw new Error(`No file connector for ${account}`);
    const file = await cachedFileRead(connector, id);
    const lines = file.content.split("\n");
    const end = limit === undefined ? lines.length : Math.min(offset + limit, lines.length);
    return {
      ...file,
      content: lines.slice(offset, end).join("\n"),
      start: offset,
      end,
      total: lines.length,
    };
  }

  async upload(
    path: string,
    role?: string,
    account?: string,
    name?: string,
    parentId?: string,
  ): Promise<FileResult> {
    const safe = secureReadPath(path);
    if (!existsSync(safe)) throw new Error(`File not found: ${path}`);
    const connector = requireConnector(
      this.registry.getFileConnectors(role, "write"),
      account,
      "file",
      (candidate) => candidate.uploadFile != null,
    );
    if (!connector.uploadFile) throw new Error("No writable file connector found.");
    return connector.uploadFile(name ?? basename(safe), readFileSync(safe), parentId);
  }

  async download(
    id: string,
    account: string,
    savePath?: string,
  ): Promise<{ dest: string; name: string; size: number }> {
    const connector = selectConnector(
      this.registry.getFileConnectors(),
      account,
      (candidate) => candidate.downloadFile != null,
    );
    if (!connector?.downloadFile) throw new Error("No file connector with download support found.");
    const meta = (await connector.search(id, 1)).find((item) => item.id === id);
    const name = meta?.name ?? id;
    const data = await connector.downloadFile(id);
    const { dir, dest } = securePath(savePath, name, "attachments");
    mkdirSync(dir, { recursive: true });
    writeFileSync(dest, data);
    return { dest, name, size: data.length };
  }
}
