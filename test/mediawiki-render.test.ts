import { describe, expect, it } from "vitest";
import { wikiHtmlToMarkdown } from "../src/providers/mediawiki/render.js";

describe("wikiHtmlToMarkdown", () => {
  it("keeps wiki tables as Markdown tables", () => {
    const html = `<table class="wikitable"><tbody>
      <tr><th>Reiseart</th><th>Genehmigung</th></tr>
      <tr><td>Inland</td><td>Dekanat</td></tr>
      <tr><td>Ausland</td><td>Präsidium | Kanzlerin</td></tr>
    </tbody></table>`;
    expect(wikiHtmlToMarkdown(html)).toBe(
      [
        "| Reiseart | Genehmigung |",
        "| --- | --- |",
        "| Inland | Dekanat |",
        "| Ausland | Präsidium \\| Kanzlerin |",
      ].join("\n"),
    );
  });

  it("puts multi-line cell content on one row", () => {
    const html = `<table><tr><th>Schritt</th></tr><tr><td><p>Antrag</p><ul><li>online</li></ul></td></tr></table>`;
    expect(wikiHtmlToMarkdown(html)).toBe("| Schritt |\n| --- |\n| Antrag - online |");
  });

  it("names links that only wrap an image, such as embedded files", () => {
    const html = `<p>Formular: <a href="https://wiki.test/wiki/Datei:Reiseantrag_2026.pdf" class="internal"><img src="x.png" alt=""></a>, Plan: <a href="/wiki/Datei:Plan.png" title="Datei:Plan.png"><img src="p.png"></a></p>`;
    expect(wikiHtmlToMarkdown(html)).toBe(
      "Formular: [Datei:Reiseantrag 2026.pdf](https://wiki.test/wiki/Datei:Reiseantrag_2026.pdf), Plan: [Datei:Plan.png](/wiki/Datei:Plan.png)",
    );
  });

  it("drops scripts, styles and comments", () => {
    expect(wikiHtmlToMarkdown("<style>p{}</style><script>x()</script><!-- c --><p>Text</p>")).toBe(
      "Text",
    );
  });
});
