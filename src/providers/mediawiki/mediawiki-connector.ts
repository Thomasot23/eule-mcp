import type {
  WikiConnector,
  WikiFileInfo,
  WikiListOptions,
  WikiPage,
  WikiPageListing,
  WikiPageRef,
  WikiSearchHit,
} from "../../types/index.js";
import { assertResponseSize, assertSecureUrl, fetchWithTimeout } from "../../utils/security.js";
import {
  CookieJar,
  isBotPasswordAccount,
  loginErrorMessage,
  mediaWikiExceptionMessage,
  parseLoginForm,
  secretFingerprint,
  sessionFetch,
  stripTags,
} from "./session.js";
import { wikiHtmlToMarkdown } from "./render.js";

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
  /** Local name of the file namespace (6), e.g. "Datei". */
  readonly fileNamespace: string;
  /** BlueSpice ExtendedSearch is installed; it also indexes file contents. */
  readonly extendedSearch: boolean;
}

/** A hit of BlueSpice's bs-extendedsearch-query, as its formatters return it. */
interface ExtendedSearchResult {
  readonly type?: string;
  readonly prefixed_title?: string;
  readonly filename?: string;
  readonly namespace?: number;
  readonly namespace_text?: string;
  readonly highlight?: string;
  readonly rendered_content_snippet?: string;
  readonly size?: number;
  readonly is_redirect?: boolean | number;
  readonly redirects_to?: string;
}

interface ExtendedSearchResponse extends ApiResponse {
  readonly results?: readonly ExtendedSearchResult[];
  readonly exception?: number;
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

/** The wiki refused the username or password (as opposed to an outage). */
class SignInRejected extends Error {}

/** The wiki failed while signing in (HTTP 5xx, exception page); worth one retry. */
class WikiServerError extends Error {}

const SERVER_ERROR_RETRY_MS = 1500;

/** An error the MediaWiki API reported, with its machine-readable code. */
class WikiApiError extends Error {
  constructor(
    readonly code: string,
    info?: string,
  ) {
    super(`Wiki API: ${info ?? code}`);
  }
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
const EXTENDED_SEARCH_MODULE = "bs-extendedsearch-query";

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
        this.session.signedIn = false;
        const attempt = async () => {
          this.session.jar.clear();
          if (isBotPasswordAccount(this.account)) await this.botPasswordSignIn();
          else await this.formSignIn();
        };
        try {
          await attempt();
        } catch (error) {
          // A server failure (seen when two clients sign in at the same time)
          // says nothing about the password: wait briefly and try once more.
          if (!(error instanceof WikiServerError)) throw error;
          await new Promise((resolve) => setTimeout(resolve, SERVER_ERROR_RETRY_MS));
          await attempt();
        }
        this.session.signedIn = true;
        this.session.failure = undefined;
      } catch (error) {
        // Only a rejected credential pauses retries; an outage or a changed
        // login page must not keep the connector down for ten minutes.
        if (error instanceof SignInRejected)
          this.session.failure = { message: error.message, at: Date.now() };
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
    if (res.status >= 500)
      throw new WikiServerError(`The wiki failed while signing in (HTTP ${String(res.status)}).`);
    const data = (await res.json()) as ApiResponse;
    if (data.login?.result !== "Success")
      throw new SignInRejected(
        `Wiki sign-in with bot password failed: ${data.login?.reason ?? data.error?.info ?? data.login?.result ?? String(res.status)}`,
      );
  }

  private async formSignIn(): Promise<void> {
    const { index } = await this.endpoints();
    const page = await sessionFetch(this.session.jar, `${index}?title=Special:UserLogin`);
    if (page.res.status >= 500)
      throw new WikiServerError(`The wiki's sign-in page answered ${String(page.res.status)}.`);
    if (!page.res.ok)
      throw new Error(`The wiki's sign-in page answered ${String(page.res.status)}.`);
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
    const exception = mediaWikiExceptionMessage(html);
    if (res.status >= 500 || exception)
      throw new WikiServerError(
        `The wiki failed while signing in (HTTP ${String(res.status)})${exception ? `: ${exception}` : "."}`,
      );
    const user = await this.call({ action: "query", meta: "userinfo" }, false);
    const info = user.query?.userinfo as { anon?: boolean; id?: number } | undefined;
    if (!info || info.anon || !info.id)
      throw new SignInRejected(
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
    if (data.error) throw new WikiApiError(data.error.code, data.error.info);
    return data;
  }

  private async site(): Promise<SiteInfo> {
    if (this.session.site) return this.session.site;
    const [data, modules] = await Promise.all([
      this.api({ action: "query", meta: "siteinfo", siprop: "namespaces" }),
      this.api({ action: "paraminfo", modules: EXTENDED_SEARCH_MODULE }),
    ]);
    const entries = Object.values(
      (data.query?.namespaces ?? {}) as Record<string, { id: number; name?: string }>,
    );
    const namespaces = entries.map((ns) => ns.id);
    const paraminfo = (modules as { paraminfo?: { modules?: { name?: string }[] } }).paraminfo;
    this.session.site = {
      // Talk namespaces are odd; Special/Media are negative.
      searchNamespaces: namespaces.filter(
        (id) => id >= 0 && id % 2 === 0 && !NOISE_NAMESPACES.has(id),
      ),
      extendedSearch: (paraminfo?.modules ?? []).some((m) => m.name === EXTENDED_SEARCH_MODULE),
      fileNamespace: entries.find((ns) => ns.id === 6)?.name ?? "File",
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
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const site = await this.site();
    // Namespace and title filters are MediaWiki search features; without
    // them BlueSpice's own search is preferred because it reads file contents.
    if (site.extendedSearch && !options.namespaces?.length && !options.titlesOnly) {
      const hits = await this.extendedSearch(query, limit, site.fileNamespace);
      if (hits) return hits;
    }
    const namespaces = options.namespaces?.length ? options.namespaces : site.searchNamespaces;
    const data = await this.api({
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: limit,
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

  /**
   * BlueSpice ExtendedSearch (Elasticsearch/OpenSearch). Built like its
   * SearchCenter: a JSON lookup with an AND query string. Returns undefined
   * when the backend fails, so the caller falls back to MediaWiki search.
   */
  private async extendedSearch(
    query: string,
    limit: number,
    fileNamespace: string,
  ): Promise<WikiSearchHit[] | undefined> {
    const lookup = {
      query: { bool: { must: [{ query_string: { query, default_operator: "AND" } }] } },
      size: limit,
      from: 0,
    };
    let data: ExtendedSearchResponse;
    try {
      data = await this.api({ action: EXTENDED_SEARCH_MODULE, q: JSON.stringify(lookup) });
    } catch {
      return undefined;
    }
    if (data.exception || !Array.isArray(data.results)) return undefined;
    const results = data.results as readonly ExtendedSearchResult[];
    const hits = new Map<string, WikiSearchHit>();
    for (const result of results) {
      // Uploaded files ("repofile") come with their extracted text; external
      // file shares and special pages are not reachable through this API.
      const found =
        result.type === "wikipage"
          ? result.prefixed_title
          : // A file's page is always in the file namespace; the index may
            // label it otherwise (BlueSpice reports "(Seiten)" for some).
            result.type === "repofile" && result.filename
            ? `${fileNamespace}:${result.filename}`
            : undefined;
      if (!found) continue;
      // BlueSpice lists a redirect as a hit of its own; report its target.
      const redirect = result.is_redirect && result.redirects_to ? found : undefined;
      const title = redirect ? (result.redirects_to ?? found) : found;
      const snippet = stripTags(result.highlight ?? result.rendered_content_snippet ?? "");
      const hit: WikiSearchHit = {
        title,
        namespace: result.type === "repofile" ? 6 : (result.namespace ?? 0),
        snippet: snippet || undefined,
        size: redirect ? undefined : result.size,
        url: await this.pageUrl(title),
        redirectFrom: redirect,
      };
      // The target itself replaces an earlier redirect hit, keeping its rank;
      // without an excerpt of its own the redirect still explains the match.
      const known = hits.get(title);
      if (!known) hits.set(title, hit);
      else if (known.redirectFrom && !redirect)
        hits.set(title, { ...hit, redirectFrom: hit.snippet ? undefined : known.redirectFrom });
    }
    return [...hits.values()];
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
    }).catch((error: unknown) => {
      if (error instanceof WikiApiError && error.code === "missingtitle")
        throw new Error(`Wiki page not found: ${title}`);
      throw error;
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
      content: wikiHtmlToMarkdown(
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
