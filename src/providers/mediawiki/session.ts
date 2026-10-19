import { createHash } from "node:crypto";
import { fetchWithTimeout } from "../../utils/security.js";

/**
 * Cookies of one wiki origin. MediaWiki keeps the signed-in session in
 * cookies only, so this is the whole session state. Cookies are only ever
 * sent back to the origin that set them.
 */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(readonly origin: string) {}

  header(url: string): string | undefined {
    if (new URL(url).origin !== this.origin || this.cookies.size === 0) return undefined;
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  store(url: string, res: Response): void {
    if (new URL(url).origin !== this.origin) return;
    for (const line of res.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => {
        const [key = "", raw = ""] = attribute.split("=").map((part) => part.trim());
        if (/^max-age$/i.test(key)) return Number(raw) <= 0;
        if (/^expires$/i.test(key)) return Date.parse(raw) <= Date.now();
        return false;
      });
      if (expired || value === "deleted") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  clear(): void {
    this.cookies.clear();
  }
}

/**
 * Sends a request with the jar's cookies and follows redirects by hand, so
 * every hop stores its cookies and none leaves the wiki's origin. A sign-in
 * that hands off to an external identity provider (SAML, OIDC) therefore
 * fails loudly instead of leaking the session.
 */
export async function sessionFetch(
  jar: CookieJar,
  url: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<{ res: Response; url: string }> {
  let current = url;
  let request = init;
  for (let hop = 0; hop < 10; hop++) {
    const headers = new Headers(request.headers);
    const cookie = jar.header(current);
    if (cookie) headers.set("Cookie", cookie);
    const res = await fetchWithTimeout(
      current,
      { ...request, headers, redirect: "manual" },
      timeoutMs,
    );
    jar.store(current, res);
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) return { res, url: current };
    await res.body?.cancel();
    const next = new URL(location, current);
    if (next.origin !== jar.origin)
      throw new Error(
        `The wiki redirected to ${next.host}. Sign-ins through an external identity provider are not supported; use a wiki account or a bot password.`,
      );
    current = next.toString();
    // A redirected POST continues as GET (303, and 301/302 in practice).
    if (res.status !== 307 && res.status !== 308) request = { headers: init.headers };
  }
  throw new Error(`Too many redirects from ${url}`);
}

/** Bot passwords are "User@BotName"; an e-mail address is a normal account. */
export function isBotPasswordAccount(account: string): boolean {
  return /^[^@\s]+@[^@\s.]+$/.test(account);
}

export function secretFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X"))
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const [, name = "", doubleQuoted, singleQuoted] = match;
    result[name.toLowerCase()] = decodeEntities(doubleQuoted ?? singleQuoted ?? "");
  }
  return result;
}

export interface LoginForm {
  readonly action: string;
  readonly fields: Record<string, string>;
  readonly usernameField: string;
  readonly passwordField: string;
}

/**
 * Reads Special:UserLogin. Works for the stock form (wpName/wpPassword) and
 * for PluggableAuth/LDAP forms (username/password plus a provider button):
 * hidden inputs and the submit button are taken as the page sends them.
 */
export function parseLoginForm(html: string, pageUrl: string): LoginForm {
  const form = /<form\b[^>]*\bname=["']userlogin["'][^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) throw new Error("The wiki's sign-in page has no login form.");
  const formAttributes = attributes(form[0].slice(0, form[0].indexOf(">") + 1));
  const body = form[1] ?? "";
  const fields: Record<string, string> = {};
  let usernameField: string | undefined;
  let passwordField: string | undefined;
  for (const [tag] of body.matchAll(/<input\b[^>]*>/gi)) {
    const input = attributes(tag);
    if (!input.name) continue;
    const type = (input.type ?? "text").toLowerCase();
    if (type === "hidden") fields[input.name] = input.value ?? "";
    else if (type === "password") passwordField ??= input.name;
    else if (input.id === "wpName1" || (type === "text" && !usernameField))
      usernameField = input.name;
  }
  const submit =
    /<button\b[^>]*\btype=["']submit["'][^>]*>/i.exec(body) ??
    /<input\b[^>]*\btype=["']submit["'][^>]*>/i.exec(body);
  if (submit) {
    const button = attributes(submit[0]);
    if (button.name) fields[button.name] = button.value ?? "1";
  }
  if (!usernameField || !passwordField)
    throw new Error(
      "The wiki's sign-in form asks for something other than a username and password.",
    );
  return {
    action: new URL(formAttributes.action ?? pageUrl, pageUrl).toString(),
    fields,
    usernameField,
    passwordField,
  };
}

/** The first error/warning box of a MediaWiki page, as plain text. */
export function loginErrorMessage(html: string): string | undefined {
  const box =
    /<div\b[^>]*class=["'][^"']*(?:errorbox|cdx-message--error|warningbox|cdx-message--warning)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(
      html,
    );
  const text = box ? stripTags(box[1] ?? "") : "";
  return text || undefined;
}

/**
 * The message of a MediaWiki exception page ("[<request id>] <timestamp>:
 * Fatal exception of type …", localized), or undefined. Such a page is a
 * server failure, not a verdict on the credentials.
 */
export function mediaWikiExceptionMessage(html: string): string | undefined {
  const text = stripTags(html);
  const match = /\[[0-9a-f]{20,}\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}: [^\n]{0,200}/i.exec(text);
  return match?.[0].trim();
}
