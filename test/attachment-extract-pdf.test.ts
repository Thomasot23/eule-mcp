import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractAttachmentText, tidyPdfMarkdown } from "../src/utils/attachment-extract.js";

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

describe("tidyPdfMarkdown", () => {
  it("removes pymupdf4llm's picture-text markers and line-break tags", () => {
    const raw =
      "\n\n\n<!-- Start of picture text -->\nStand: 12/2025<br><!-- End of picture text -->\n\n\n\n\n" +
      "<!-- Start of picture text -->\nMobilität<br>165 Out / 99 In<br/><!-- End of picture text -->\n";
    expect(tidyPdfMarkdown(raw)).toBe("Stand: 12/2025\n\nMobilität\n165 Out / 99 In");
  });

  it("leaves ordinary Markdown alone", () => {
    expect(tidyPdfMarkdown("# Titel\n\nText mit <b>Fett</b>.")).toBe(
      "# Titel\n\nText mit <b>Fett</b>.",
    );
  });
});
