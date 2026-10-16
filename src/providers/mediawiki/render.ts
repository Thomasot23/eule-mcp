import TurndownService from "turndown";

/** The part of turndown's DOM nodes these rules use (the project has no DOM lib). */
interface DomNode {
  readonly nodeName: string;
  readonly parentNode: DomNode | null;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): DomNode | null;
  querySelectorAll(selector: string): { readonly length: number };
}

const dom = (node: unknown) => node as DomNode;

/**
 * Markdown for rendered wiki pages. Unlike the mail renderer it keeps tables
 * (process descriptions in intranets live in them) and names links whose
 * only content is an image, such as embedded files.
 */
const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
});

turndown.remove(["style", "script", "noscript"]);
turndown.addRule("dropImages", { filter: "img", replacement: () => "" });

turndown.addRule("namedImageLinks", {
  filter: (node) => {
    const element = dom(node);
    return (
      element.nodeName === "A" &&
      (element.textContent ?? "").trim() === "" &&
      !!element.getAttribute("href")
    );
  },
  replacement: (_content, node) => {
    const element = dom(node);
    const href = element.getAttribute("href") ?? "";
    const label = [
      element.getAttribute("title"),
      element.querySelector("img")?.getAttribute("alt"),
      decodeURIComponent(href.split(/[/=]/).pop() ?? "").replaceAll("_", " "),
    ].find((candidate) => candidate?.trim());
    return label ? `[${label.trim()}](${href})` : "";
  },
});

const cellText = (content: string) =>
  content.replace(/\n+/g, " ").replaceAll("|", "\\|").replace(/\s+/g, " ").trim();

turndown.addRule("tableCell", {
  filter: ["th", "td"],
  replacement: (content) => ` ${cellText(content)} |`,
});

turndown.addRule("tableRow", {
  filter: "tr",
  replacement: (content, node) => {
    const row = `|${content}\n`;
    const parent = dom(node).parentNode;
    const table = parent?.nodeName === "TABLE" ? parent : parent?.parentNode;
    if (table?.querySelector("tr") !== dom(node)) return row;
    const cells = dom(node).querySelectorAll("th, td").length;
    return `${row}|${" --- |".repeat(Math.max(cells, 1))}\n`;
  },
});

turndown.addRule("table", {
  filter: "table",
  replacement: (content) => `\n\n${content.replace(/\n{2,}/g, "\n").trim()}\n\n`,
});

turndown.addRule("tableSections", {
  filter: ["thead", "tbody", "tfoot", "caption"],
  replacement: (content, node) =>
    dom(node).nodeName === "CAPTION" ? `**${content.trim()}**\n\n` : content,
});

/** Converts the HTML of action=parse to Markdown. */
export function wikiHtmlToMarkdown(html: string): string {
  return turndown
    .turndown(html.replace(/<!--[\s\S]*?-->/g, ""))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
