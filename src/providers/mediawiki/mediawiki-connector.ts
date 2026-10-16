import type {
  WikiConnector,
  WikiFileInfo,
  WikiListOptions,
  WikiPage,
  WikiPageListing,
  WikiPageRef,
  WikiSearchHit,
} from "../../types/index.js";
import { htmlToMarkdown } from "../../renderer/markdown-renderer.js";
import { assertResponseSize, assertSecureUrl, fetchWithTimeout } from "../../utils/security.js";
import {
  CookieJar,
  isBotPasswordAccount,
  loginErrorMessage,
  parseLoginForm,
  secretFingerprint,
  sessionFetch,
  stripTags,
} from "./session.js";

type Params = Record<string, string | number | boolean | undefined>;

interface ApiError {
  readonly code: string;
  readonly info?: string;
}

interface ApiResponse {
  readonly error?: ApiError;
  readonly continue?: Record<string, string>;
  readonly query?: Record<string, unknown>;
  readonly parse?: Record<string, unknown>;
  readonly login?: { readonly result: string; readonly reason?: string };
}

interface Endpoints {
  readonly api: string;
  readonly index: string;
}

interface SiteInfo {
  readonly searchNamespaces: readonly number[];
}

interface Session {
  readonly jar: CookieJar;
  readonly secret: string;
  endpoints?: Endpoints;
  site?: SiteInfo;
  signedIn: boolean;
  signingIn?: Promise<void>;
  /** A rejected sign-in is not retried with the same password for a while,
   *  so repeated tool calls cannot lock the account (LDAP lockout). */
  failure?: { readonly message: string; readonly at: number };
}

/** Sessions outlive connector objects, which the registry builds per call. */
const sessions = new Map<string, Session>();
const FAILED_SIGN_IN_PAUSE_MS = 10 * 60 * 1000;
const SESSION_LOST = new Set([
  "assertuserfailed",
  "assertnameduserfailed",
  "readapidenied",
  "notloggedin",
  "badtoken",
]);
// Namespaces of wiki internals that only add noise to a knowledge search.
const NOISE_NAMESPACES = new Set([8, 10, 828]);

/** Strips a "File:"/"Datei:"/"Image:"/"Bild:" prefix. */
export function fileName(name: string): string {
  return name.trim().replace(/^(?:file|datei|image|bild)\s*:\s*/i, "");
}

function afterNamespace(title: string): string {
  const colon = title.indexOf(":");
  return colon >= 0 ? title.slice(colon + 1) : title;
}

function encodeContinue(value: Record<string, string> | undefined): string | undefined {
  return value ? Buffer.from(JSON.stringify(value)).toString("base64url") : undefined;
}

function decodeContinue(token: string | undefined): Record<string, string> {
  if (!token) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
  } catch {
    /* fall through */
  }
  throw new Error("Invalid continue_from token");
}

/**
 * Read-only MediaWiki/BlueSpice connector. Signs in with the user's own
 * account through the wiki's login form (this also covers LDAP/SSO accounts
 * behind PluggableAuth, which the API's action=login refuses), or with a bot
 * password through action=login. Only reads; the only POST is the sign-in.
 */
export class MediaWikiConnector implements WikiConnector {
  readonly tier = "mediawiki";
  private readonly session: Session;
  private readonly password: string;

  constructor(
    readonly account: string,
    private readonly baseUrl: string,
    password: string,
  ) {
    const origin = new URL(assertSecureUrl(baseUrl, "Wiki URL")).origin;
    const key = `${baseUrl}\n${account}`;
    const secret = secretFingerprint(password);
    let session = sessions.get(key);
    if (session?.secret !== secret) {
      session = { jar: new CookieJar(origin), secret, signedIn: false };
      sessions.set(key, session);
    }
    this.session = session;
    this.password = password;
  }

  // --- endpoints and session ---

  private async endpoints(): Promise<Endpoints> {
    if (this.session.endpoints) return this.session.endpoints;
    const base = this.baseUrl.replace(/\/+$/, "");
    const candidates = /\/api\.php$/i.test(base)
      ? [base]
      : [`${base}/api.php`, `${base}/w/api.php`];
    for (const api of candidates) {
      // Not followed: a private wiki redirects a wrong path to its login page.
      const res = await fetchWithTimeout(`${api}?action=query&format=json`, { redirect: "manual" });
      const type = res.headers.get("content-type") ?? "";
      await res.body?.cancel();
      if (res.ok && type.includes("json")) {
        this.session.endpoints = { api, index: api.replace(/api\.php$/i, "index.php") };
        return this.session.endpoints;
      }
    }
    throw new Error(
      `No MediaWiki API found at ${base} (tried ${candidates.join(", ")}). Configure the wiki's script path, e.g. https://wiki.example.org/w.`,
    );
  }

  private async signIn(): Promise<void> {
    const failure = this.session.failure;
    if (failure && Date.now() - failure.at < FAILED_SIGN_IN_PAUSE_MS)
      throw new Error(
        `${failure.message} (not retried for 10 minutes to avoid locking the account; rotate the credential to try again now)`,
      );
    this.session.signingIn ??= (async () => {
      try {
        this.session.jar.clear();
        this.session.signedIn = false;
        if (isBotPasswordAccount(this.account)) await this.botPasswordSignIn();
        else await this.formSignIn();
        this.session.signedIn = true;
        this.session.failure = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.session.failure = { message, at: Date.now() };
        throw error;
      } finally {
        this.session.signingIn = undefined;
      }
    })();
    return this.session.signingIn;
  }

  private async botPasswordSignIn(): Promise<void> {
    const tokens = await this.call({ action: "query", meta: "tokens", type: "login" }, false);
    const token = (tokens.query?.tokens as { logintoken?: string } | undefined)?.logintoken;
    if (!token) throw new Error("The wiki returned no login token.");
    const { api } = await this.endpoints();
    const { res } = await sessionFetch(this.session.jar, api, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "login",
        format: "json",
        formatversion: "2",
        lgname: this.account,
        lgpassword: this.password,
        lgtoken: token,
      }),
    });
    const data = (await res.json()) as ApiResponse;
    if (data.login?.result !== "Success")
      throw new Error(
        `Wiki sign-in with bot password failed: ${data.login?.reason ?? data.error?.info ?? data.login?.result ?? String(res.status)}`,
      );
  }

  private async formSignIn(): Promise<void> {
    const { index } = await this.endpoints();
    const page = await sessionFetch(this.session.jar, `${index}?title=Special:UserLogin`);
    const form = parseLoginForm(await page.res.text(), page.url);
    const body = new URLSearchParams(form.fields);
    body.set(form.usernameField, this.account);
    body.set(form.passwordField, this.password);
    const { res } = await sessionFetch(this.session.jar, form.action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const html = await res.text();
    const user = await this.call({ action: "query", meta: "userinfo" }, false);
    const info = user.query?.userinfo as { anon?: boolean; id?: number } | undefined;
    if (!info || info.anon || !info.id)
      throw new Error(
        `Wiki sign-in failed: ${loginErrorMessage(html) ?? "the wiki did not accept the username or password"}`,
      );
  }

  /** One API request without sign-in handling. */
  private async call(params: Params, assertUser: boolean): Promise<ApiResponse> {
    const { api } = await this.endpoints();
    const query = new URLSearchParams({ format: "json", formatversion: "2" });
    if (assertUser) query.set("assert", "user");
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) query.set(key, String(value));
    const { res } = await sessionFetch(this.session.jar, `${api}?${query.toString()}`);
    if (!res.ok) throw new Error(`Wiki API ${String(res.status)}`);
    assertResponseSize(res);
    return (await res.json()) as ApiResponse;
  }

  /** A signed-in API read; a lost session is renewed once. */
  private async api(params: Params): Promise<ApiResponse> {
    if (!this.session.signedIn) await this.signIn();
    let data = await this.call(params, true);
    if (data.error && SESSION_LOST.has(data.error.code)) {
      this.session.signedIn = false;
      await this.signIn();
      data = await this.call(params, true);
    }
    if (data.error) throw new Error(`Wiki API: ${data.error.info ?? data.error.code}`);
    return data;
  }

  private async site(): Promise<SiteInfo> {
    if (this.session.site) return this.session.site;
    const data = await this.api({ action: "query", meta: "siteinfo", siprop: "namespaces" });
    const namespaces = Object.values(
      (data.query?.namespaces ?? {}) as Record<string, { id: number }>,
    ).map((ns) => ns.id);
    this.session.site = {
      // Talk namespaces are odd; Special/Media are negative.
      searchNamespaces: namespaces.filter(
        (id) => id >= 0 && id % 2 === 0 && !NOISE_NAMESPACES.has(id),
      ),
    };
    return this.session.site;
  }

  private async pageUrl(title: string): Promise<string> {
    const { index } = await this.endpoints();
    return `${index}?title=${encodeURIComponent(title.replaceAll(" ", "_"))}`;
  }

  // --- WikiConnector ---

  async search(
    query: string,
    options: { limit?: number; namespaces?: readonly number[]; titlesOnly?: boolean } = {},
  ): Promise<WikiSearchHit[]> {
    const namespaces = options.namespaces?.length
      ? options.namespaces
      : (await this.site()).searchNamespaces;
    const data = await this.api({
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: Math.min(Math.max(options.limit ?? 20, 1), 50),
      srnamespace: namespaces.join("|"),
      srwhat: options.titlesOnly ? "title" : undefined,
      srprop: "snippet|timestamp|size",
    });
    const hits = (data.query?.search ?? []) as {
      title: string;
      ns: number;
      snippet?: string;
      timestamp?: string;
      size?: number;
    }[];
    return Promise.all(
      hits.map(async (hit) => ({
        title: hit.title,
        namespace: hit.ns,
        // The database backend returns raw wikitext around the match.
        snippet: hit.snippet
          ? stripTags(hit.snippet).replace(/'{2,}/g, "") || undefined
          : undefined,
        timestamp: hit.timestamp,
        size: hit.size,
        url: await this.pageUrl(hit.title),
      })),
    );
  }

  async readPage(
    title: string,
    options: { format?: "markdown" | "wikitext"; section?: number } = {},
  ): Promise<WikiPage> {
    return options.format === "wikitext"
      ? this.readWikitext(title, options.section)
      : this.readRendered(title, options.section);
  }

  private async readRendered(title: string, section?: number): Promise<WikiPage> {
    const data = await this.api({
      action: "parse",
      page: title,
      prop: "text|sections|categories|images|revid",
      redirects: true,
      disableeditsection: true,
      disablelimitreport: true,
      section,
    });
    const parsed = data.parse as {
      title: string;
      pageid: number;
      revid?: number;
      text: string;
      sections?: { index: string; line: string }[];
      categories?: { category: string; hidden?: boolean }[];
      images?: string[];
      redirects?: { from: string; to: string }[];
    };
    const info = await this.api({
      action: "query",
      prop: "revisions",
      rvprop: "timestamp",
      pageids: parsed.pageid,
    });
    const revision = (
      info.query?.pages as { revisions?: { timestamp?: string }[] }[] | undefined
    )?.[0]?.revisions?.[0];
    return {
      title: parsed.title,
      pageId: parsed.pageid,
      revisionId: parsed.revid,
      timestamp: revision?.timestamp,
      url: await this.pageUrl(parsed.title),
      // Root-relative links would be dead outside the wiki.
      content: htmlToMarkdown(
        parsed.text.replace(/\b(href|src)="\/(?!\/)/g, `$1="${this.session.jar.origin}/`),
      ),
      format: "markdown",
      sections: (parsed.sections ?? []).map((s) => ({ index: s.index, title: stripTags(s.line) })),
      categories: (parsed.categories ?? [])
        .filter((c) => !c.hidden)
        .map((c) => c.category.replaceAll("_", " ")),
      files: (parsed.images ?? []).map((name) => name.replaceAll("_", " ")),
      redirectedFrom: parsed.redirects?.[0]?.from,
    };
  }

  private async readWikitext(title: string, section?: number): Promise<WikiPage> {
    const data = await this.api({
      action: "query",
      titles: title,
      redirects: true,
      prop: "revisions|categories|images",
      rvprop: "content|ids|timestamp",
      rvslots: "main",
      rvsection: section,
      cllimit: "max",
      imlimit: "max",
    });
    const page = (data.query?.pages as Record<string, unknown>[] | undefined)?.[0] as
      | {
          title: string;
          pageid?: number;
          missing?: boolean;
          invalid?: boolean;
          revisions?: { revid: number; timestamp: string; slots: { main: { content: string } } }[];
          categories?: { title: string }[];
          images?: { title: string }[];
        }
      | undefined;
    if (!page || page.missing || page.invalid || !page.pageid)
      throw new Error(`Wiki page not found: ${title}`);
    const revision = page.revisions?.[0];
    const redirects = data.query?.redirects as { from: string }[] | undefined;
    return {
      title: page.title,
      pageId: page.pageid,
      revisionId: revision?.revid,
      timestamp: revision?.timestamp,
      url: await this.pageUrl(page.title),
      content: revision?.slots.main.content ?? "",
      format: "wikitext",
      sections: [],
      categories: (page.categories ?? []).map((c) => afterNamespace(c.title)),
      files: (page.images ?? []).map((f) => afterNamespace(f.title)),
      redirectedFrom: redirects?.[0]?.from,
    };
  }

  async listPages(options: WikiListOptions): Promise<WikiPageListing> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    const resume = decodeContinue(options.continueFrom);
    let data: ApiResponse;
    let rows: { title: string; ns: number; timestamp?: string; user?: string; comment?: string }[];
    if (options.recent) {
      data = await this.api({
        action: "query",
        list: "recentchanges",
        rcprop: "title|timestamp|user|comment",
        rctype: "edit|new",
        rctoponly: true,
        rcnamespace: options.namespace,
        rclimit: limit,
        ...resume,
      });
      rows = (data.query?.recentchanges ?? []) as typeof rows;
    } else if (options.category) {
      const category = options.category.includes(":")
        ? options.category
        : `Category:${options.category}`;
      data = await this.api({
        action: "query",
        list: "categorymembers",
        cmtitle: category,
        cmprop: "title|timestamp",
        cmnamespace: options.namespace,
        cmlimit: limit,
        ...resume,
      });
      rows = (data.query?.categorymembers ?? []) as typeof rows;
    } else {
      data = await this.api({
        action: "query",
        list: "allpages",
        apprefix: options.prefix,
        apnamespace: options.namespace ?? 0,
        apfilterredir: "nonredirects",
        aplimit: limit,
        ...resume,
      });
      rows = (data.query?.allpages ?? []) as typeof rows;
    }
    const pages: WikiPageRef[] = await Promise.all(
      rows.map(async (row) => ({
        title: row.title,
        namespace: row.ns,
        timestamp: row.timestamp,
        user: row.user,
        comment: row.comment,
        url: await this.pageUrl(row.title),
      })),
    );
    return { pages, continueFrom: encodeContinue(data.continue) };
  }

  async fileInfo(name: string): Promise<WikiFileInfo> {
    const data = await this.api({
      action: "query",
      titles: `File:${fileName(name)}`,
      prop: "imageinfo",
      iiprop: "url|size|mime|timestamp|user",
    });
    const page = (data.query?.pages as Record<string, unknown>[] | undefined)?.[0] as
      | {
          title: string;
          imageinfo?: {
            url: string;
            descriptionurl: string;
            size: number;
            mime: string;
            timestamp?: string;
            user?: string;
          }[];
        }
      | undefined;
    const info = page?.imageinfo?.[0];
    if (!page || !info) throw new Error(`Wiki file not found: ${name}`);
    const { index } = await this.endpoints();
    return {
      name: afterNamespace(page.title),
      title: page.title,
      size: info.size,
      mime: info.mime,
      timestamp: info.timestamp,
      user: info.user,
      url: new URL(info.url, index).toString(),
      descriptionUrl: new URL(info.descriptionurl, index).toString(),
    };
  }

  async downloadFile(name: string): Promise<{ info: WikiFileInfo; data: Buffer }> {
    const info = await this.fileInfo(name);
    // The session cookie is attached only for the wiki's own origin; a file
    // served from elsewhere must at least not travel in cleartext.
    assertSecureUrl(info.url, "Wiki file URL");
    // Protected uploads (img_auth.php) answer an expired session with 403 or
    // the login page instead of the file; sign in again once.
    const isFile = (res: Response) =>
      res.ok &&
      (info.mime.includes("html") ||
        !(res.headers.get("content-type") ?? "").includes("text/html"));
    let { res } = await sessionFetch(this.session.jar, info.url, {}, 120_000);
    if (!isFile(res)) {
      await res.body?.cancel();
      await this.signIn();
      ({ res } = await sessionFetch(this.session.jar, info.url, {}, 120_000));
    }
    if (!isFile(res)) throw new Error(`Wiki file download failed: ${String(res.status)}`);
    assertResponseSize(res);
    return { info, data: Buffer.from(await res.arrayBuffer()) };
  }
}

/** Test hook: forget all signed-in sessions. */
export function resetMediaWikiSessions(): void {
  sessions.clear();
}
