import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertWithPandoc, ext, hasPandoc, PANDOC_FORMATS } from "./file-cache.js";

/** Extensions we treat as plain UTF-8 text (no conversion needed). */
const TEXT_EXTS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".log",
  ".json",
  ".xml",
  ".yaml",
  ".yml",
  ".csv",
  ".tsv",
  ".ics",
  ".eml",
  ".srt",
]);

/**
 * PDF to Markdown via pymupdf4llm. PyMuPDF writes its notes ("Document parser
 * messages", OCR hints) to file descriptor 1 directly, so fd 1 points at
 * stderr while converting; only the Markdown reaches stdout.
 */
export const PDF_TO_MARKDOWN_SCRIPT = [
  "import os, sys",
  "stdout = os.dup(1)",
  "os.dup2(2, 1)",
  "try:",
  "    import pymupdf4llm",
  "    markdown = pymupdf4llm.to_markdown(sys.argv[1])",
  "finally:",
  "    sys.stdout.flush()",
  "    os.dup2(stdout, 1)",
  "sys.stdout.write(markdown)",
].join("\n");

/**
 * pymupdf4llm frames OCR'd picture text with HTML comments and breaks lines
 * with <br>; both are noise for a reader of the text.
 */
export function tidyPdfMarkdown(markdown: string): string {
  return markdown
    .replace(/<!--\s*(?:Start|End) of picture text\s*-->/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ExtractResult {
  text: string;
  /** How the text was produced: pymupdf4llm | pandoc | utf-8 | utf-8-fallback. */
  method: string;
}

/**
 * Extract readable text from attachment bytes. PDFs go through pymupdf4llm,
 * office/markup formats through pandoc (both reused from the file-read pipeline),
 * plain-text formats are decoded directly, and anything else falls back to a
 * best-effort UTF-8 decode. Temp files are named with random bytes and passed to
 * child processes as literal arguments (never interpolated into shell/Python
 * source) so an attacker-chosen filename cannot inject code.
 */
export function extractAttachmentText(buf: Buffer, filename: string): ExtractResult {
  const e = ext(filename);

  if (TEXT_EXTS.has(e)) return { text: buf.toString("utf-8"), method: "utf-8" };

  const isPdf = e === ".pdf";
  const pandocFormat = hasPandoc() ? PANDOC_FORMATS[e] : undefined;
  if (!isPdf && !pandocFormat) return { text: buf.toString("utf-8"), method: "utf-8-fallback" };

  const tmp = join(tmpdir(), `eule-att-${randomBytes(8).toString("hex")}${e}`);
  try {
    writeFileSync(tmp, buf);
    if (isPdf) {
      const out = execFileSync("python3", ["-c", PDF_TO_MARKDOWN_SCRIPT, tmp], {
        maxBuffer: 20 * 1024 * 1024,
      }).toString();
      return { text: tidyPdfMarkdown(out), method: "pymupdf4llm" };
    }
    if (pandocFormat) return { text: convertWithPandoc(tmp, pandocFormat), method: "pandoc" };
    return { text: buf.toString("utf-8"), method: "utf-8-fallback" };
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp file may not exist — ignore */
    }
  }
}
