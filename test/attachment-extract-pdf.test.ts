import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractAttachmentText } from "../src/utils/attachment-extract.js";

const hasPymupdf = (() => {
  try {
    execFileSync("python3", ["-c", "import pymupdf4llm"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPymupdf)("PDF text extraction", () => {
  it("returns only the Markdown, not pymupdf4llm's parser messages", () => {
    const { text, method } = extractAttachmentText(
      readFileSync("test/fixtures/two-pages.pdf"),
      "two-pages.pdf",
    );
    expect(method).toBe("pymupdf4llm");
    expect(text).toContain("Kostenstelle");
    expect(text).not.toMatch(/Document parser messages|Tesseract/);
  });
});
