import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MediaWikiConnector,
  resetMediaWikiSessions,
} from "../src/providers/mediawiki/mediawiki-connector.js";
import {
  CookieJar,
  isBotPasswordAccount,
  loginErrorMessage,
  parseLoginForm,
  sessionFetch,
} from "../src/providers/mediawiki/session.js";
import { WikiService } from "../src/services/wiki-service.js";
import type { ConnectorRegistry } from "../src/connectors/index.js";
import type { WikiConnector } from "../src/types/index.js";
import { parseConnectorConfig, parseAppConfig } from "../src/config/schema.js";

const ORIGIN = "https://wiki.test";

// Shape of BlueSpice's Special:UserLogin with PluggableAuth (LDAP), as served
// by a production intranet: username/password plus a provider button.
const PLUGGABLE_AUTH_FORM = `
<form class="mw-htmlform mw-htmlform-codex" action="/wiki/Spezial:Anmelden" method="post" name="userlogin">
<input id="wpName1" name="username" size="45" class="cdx-text-input__input" required="" autofocus="">
<input id="wpPassword1" name="password" size="45" autocomplete="current-password" type="password">
<input name="wpRemember" type="checkbox" value="1" id="wpRemember" />
<button class="mw-htmlform-submit cdx-button" id="mw-input-pluggableauthlogin0" type="submit" name="pluggableauthlogin0" value="Anmeldung">Anmeldung</button>
<input id="wpEditToken" type="hidden" value="+\\" name="wpEditToken">
<input type="hidden" value="Spezial:Anmelden" name="title">
<input name="authAction" type="hidden" value="login">
<input name="force" type="hidden">
<input name="wpLoginToken" type="hidden" value="abc123+\\">
</form>`;

const ERROR_PAGE = `<div class="cdx-message cdx-message--block cdx-message--error"><span class="cdx-message__icon"></span><div class="cdx-message__content">Falscher Benutzername oder falsches Passwort.</div></div>${PLUGGABLE_AUTH_FORM}`;

interface FakeWiki {
  fetch: ReturnType<typeof vi.fn>;
  expireSessions(): void;
  posts(): string[];
}

/** A private BlueSpice wiki: /api.php redirects, /w/api.php needs a session. */
function fakeWiki(
  credentials: { user: string; password: string },
  extendedSearch: "none" | "ok" | "broken" = "none",
): FakeWiki {
  const signedIn = new Set<string>();
  const posts: string[] = [];
  let nextSession = 1;
  const html = (body: string, cookie?: string) =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/html", ...(cookie ? { "set-cookie": cookie } : {}) },
    });
  const json = (body: unknown, cookie?: string) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(cookie ? { "set-cookie": cookie } : {}),
      },
    });
  const redirect = (location: string, cookie?: string) =>
    new Response(null, {
      status: 302,
      headers: { location, ...(cookie ? { "set-cookie": cookie } : {}) },
    });

  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const session = /sess=(\w+)/.exec(headers.get("cookie") ?? "")?.[1];
    const authed = session !== undefined && signedIn.has(session);
    const freshCookie = () => `sess=s${String(nextSession++)}; path=/; HttpOnly`;
    const p = url.searchParams;
    if (url.origin !== ORIGIN) throw new Error(`unexpected host ${url.host}`);
    if (url.pathname === "/api.php") return redirect("/w/index.php?title=Spezial:Anmelden");

    if (url.pathname === "/w/index.php" && p.get("title") === "Special:UserLogin")
      return html(PLUGGABLE_AUTH_FORM, freshCookie());

    if (url.pathname === "/wiki/Spezial:Anmelden" && init.method === "POST") {
      const form = new URLSearchParams(String(init.body));
      posts.push("form");
      expect(form.get("wpLoginToken")).toBe("abc123+\\");
      expect(form.get("pluggableauthlogin0")).toBe("Anmeldung");
      if (
        form.get("username") !== credentials.user ||
        form.get("password") !== credentials.password
      )
        return html(ERROR_PAGE);
      if (session) signedIn.add(session);
      return redirect("/wiki/Spezial:PluggableAuthLogin", "wikiUserID=7; path=/");
    }
    if (url.pathname === "/wiki/Spezial:PluggableAuthLogin") return redirect("/wiki/Hauptseite");
    if (url.pathname === "/wiki/Hauptseite") return html("<h1>Hauptseite</h1>");

    if (url.pathname === "/w/api.php" && init.method === "POST") {
      const form = new URLSearchParams(String(init.body));
      posts.push("action=login");
      const ok =
        form.get("lgname") === credentials.user && form.get("lgpassword") === credentials.password;
      if (ok && session) signedIn.add(session);
      return json({
        login: ok ? { result: "Success" } : { result: "Failed", reason: "Wrong password" },
      });
    }

    if (url.pathname === "/w/api.php") {
      if (p.get("meta") === "tokens")
        return json(
          { query: { tokens: { logintoken: "tok+\\" } } },
          session ? undefined : freshCookie(),
        );
      if (p.get("meta") === "userinfo")
        return json({
          query: { userinfo: authed ? { id: 7, name: "Tester" } : { id: 0, anon: true } },
        });
      if (
        !p.get("action") ||
        (!p.get("list") && !p.get("meta") && !p.get("prop") && p.get("action") === "query")
      )
        return json({ batchcomplete: true });
      if (!authed)
        return json({
          error: { code: p.get("assert") ? "assertuserfailed" : "readapidenied", info: "denied" },
        });
      if (p.get("action") === "paraminfo")
        // An unknown module is only a warning; "modules" is then missing.
        return json(
          extendedSearch === "none"
            ? { paraminfo: { helpformat: "none" } }
            : { paraminfo: { modules: [{ name: "bs-extendedsearch-query" }] } },
        );
      if (p.get("action") === "bs-extendedsearch-query") {
        const lookup = JSON.parse(p.get("q") ?? "{}") as Record<string, unknown>;
        expect(lookup).toMatchObject({
          query: { bool: { must: [{ query_string: { default_operator: "AND" } }] } },
        });
        if (extendedSearch === "broken")
          return json({ exception: 1, exceptionType: "Elastica\\Exception\\Connection" });
        // Shaped like BlueSpiceExtendedSearch's WikiPage/RepoFile formatters.
        return json({
          total: 3,
          results: [
            {
              type: "wikipage",
              prefixed_title: "Handbuch:Dienstreise",
              namespace: 3000,
              namespace_text: "Handbuch",
              highlight: "Antrag auf <b>Dienstreise</b>",
              mtime: "16. Oktober 2026",
            },
            {
              type: "repofile",
              filename: "Reiseantrag_2026.pdf",
              namespace: 6,
              namespace_text: "Datei",
              highlight: "Formular für <b>Dienstreisen</b> &amp; Kostenstelle",
              size: 52000,
            },
            { type: "specialpage", basename: "Spezial:Hochladen" },
          ],
        });
      }
      if (p.get("meta") === "siteinfo")
        return json({
          query: {
            namespaces: {
              "-1": { id: -1 },
              "0": { id: 0 },
              "1": { id: 1 },
              "6": { id: 6 },
              "10": { id: 10 },
              "3000": { id: 3000 },
            },
          },
        });
      if (p.get("list") === "search")
        return json({
          query: {
            search: [
              {
                title: "Dienstreise",
                ns: 0,
                snippet: 'Antrag auf <span class="searchmatch">Dienstreise</span> &amp; Erstattung',
                timestamp: "2026-09-01T10:00:00Z",
              },
            ],
          },
        });
      if (p.get("action") === "parse")
        return json({
          parse: {
            title: "Dienstreise",
            pageid: 42,
            revid: 9,
            text: '<h2>Ablauf</h2><p>Antrag <b>vorher</b> mit <a href="/wiki/Datei:Antrag.pdf">Formular</a> stellen.</p>',
            sections: [{ index: "1", line: "<i>Ablauf</i>" }],
            categories: [
              { category: "Personal_und_Recht" },
              { category: "Versteckt", hidden: true },
            ],
            images: ["Reiseantrag_2026.pdf"],
          },
        });
      if (p.get("prop") === "revisions")
        return json({
          query: { pages: [{ pageid: 42, revisions: [{ timestamp: "2026-09-01T10:00:00Z" }] }] },
        });
      if (p.get("list") === "categorymembers")
        return json({
          continue: { cmcontinue: "page|abc", continue: "-||" },
          query: { categorymembers: [{ title: "Dienstreise", ns: 0 }] },
        });
    }
    throw new Error(`unhandled ${init.method ?? "GET"} ${url.toString()}`);
  });
  return {
    fetch,
    expireSessions: () => signedIn.clear(),
    posts: () => posts,
  };
}

describe("MediaWiki sign-in form parsing", () => {
  it("submits a PluggableAuth form with its hidden fields and provider button", () => {
    const form = parseLoginForm(
      PLUGGABLE_AUTH_FORM,
      `${ORIGIN}/w/index.php?title=Special:UserLogin`,
    );
    expect(form.action).toBe(`${ORIGIN}/wiki/Spezial:Anmelden`);
    expect(form.usernameField).toBe("username");
    expect(form.passwordField).toBe("password");
    expect(form.fields).toMatchObject({
      wpLoginToken: "abc123+\\",
      authAction: "login",
      title: "Spezial:Anmelden",
      pluggableauthlogin0: "Anmeldung",
    });
    // The "keep me signed in" box is not a hidden field and is not sent.
    expect(form.fields).not.toHaveProperty("wpRemember");
  });

  it("handles the stock MediaWiki form", () => {
    const form = parseLoginForm(
      `<form name="userlogin" method="post" action="/index.php?title=Special:UserLogin&amp;action=submitlogin">
       <input id="wpName1" name="wpName" type="text"><input name="wpPassword" type="password" id="wpPassword1">
       <input type="hidden" name="wpLoginToken" value="t+\\"><button type="submit" name="wploginattempt" value="Log in">Log in</button></form>`,
      `${ORIGIN}/index.php?title=Special:UserLogin`,
    );
    expect(form.action).toBe(`${ORIGIN}/index.php?title=Special:UserLogin&action=submitlogin`);
    expect([form.usernameField, form.passwordField]).toEqual(["wpName", "wpPassword"]);
    expect(form.fields.wploginattempt).toBe("Log in");
  });

  it("reads the error box of a rejected sign-in", () => {
    expect(loginErrorMessage(ERROR_PAGE)).toBe("Falscher Benutzername oder falsches Passwort.");
  });

  it("tells bot passwords from e-mail style accounts", () => {
    expect(isBotPasswordAccount("Jane@eule")).toBe(true);
    expect(isBotPasswordAccount("jane.doe@example.org")).toBe(false);
    expect(isBotPasswordAccount("abc-def-u1")).toBe(false);
  });
});

describe("MediaWiki session cookies", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never sends the session to another origin", async () => {
    const jar = new CookieJar(ORIGIN);
    jar.store(`${ORIGIN}/`, new Response(null, { headers: { "set-cookie": "sess=x; path=/" } }));
    expect(jar.header(`${ORIGIN}/w/api.php`)).toBe("sess=x");
    expect(jar.header("https://evil.test/")).toBeUndefined();
  });

  it("refuses a redirect that leaves the wiki", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { location: "https://idp.test/saml" } }),
      ),
    );
    await expect(sessionFetch(new CookieJar(ORIGIN), `${ORIGIN}/login`)).rejects.toThrow(
      /redirected to idp.test/,
    );
  });
});

describe("MediaWikiConnector", () => {
  let wiki: FakeWiki;

  beforeEach(() => {
    resetMediaWikiSessions();
    wiki = fakeWiki({ user: "tester", password: "geheim" });
    vi.stubGlobal("fetch", wiki.fetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("signs in through the login form and searches content namespaces", async () => {
    const connector = new MediaWikiConnector("tester", ORIGIN, "geheim");
    const hits = await connector.search("Dienstreise");
    expect(hits).toEqual([
      {
        title: "Dienstreise",
        namespace: 0,
        snippet: "Antrag auf Dienstreise & Erstattung",
        timestamp: "2026-09-01T10:00:00Z",
        size: undefined,
        url: `${ORIGIN}/w/index.php?title=Dienstreise`,
      },
    ]);
    const search = wiki.fetch.mock.calls
      .map(([input]) => new URL(String(input)))
      .find((u) => u.searchParams.get("list") === "search");
    // Talk (odd), Special (negative) and Template (10) namespaces are left out.
    expect(search?.searchParams.get("srnamespace")).toBe("0|6|3000");
    expect(search?.searchParams.get("assert")).toBe("user");
    expect(wiki.posts()).toEqual(["form"]);
  });

  it("reuses the session across connector instances and renews it once when lost", async () => {
    await new MediaWikiConnector("tester", ORIGIN, "geheim").search("a");
    await new MediaWikiConnector("tester", ORIGIN, "geheim").search("b");
    expect(wiki.posts()).toEqual(["form"]);
    wiki.expireSessions();
    await new MediaWikiConnector("tester", ORIGIN, "geheim").search("c");
    expect(wiki.posts()).toEqual(["form", "form"]);
  });

  it("does not retry a rejected password, so the account is not locked", async () => {
    const connector = new MediaWikiConnector("tester", ORIGIN, "falsch");
    await expect(connector.search("x")).rejects.toThrow(
      /Wiki sign-in failed: Falscher Benutzername oder falsches Passwort/,
    );
    await expect(connector.search("x")).rejects.toThrow(/not retried for 10 minutes/);
    expect(wiki.posts()).toEqual(["form"]);
    // A rotated credential is a new attempt.
    await expect(
      new MediaWikiConnector("tester", ORIGIN, "geheim").search("x"),
    ).resolves.toHaveLength(1);
  });

  it("retries at once after an outage, unlike after a rejected password", async () => {
    let down = true;
    const fetchWiki = wiki.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) =>
        down && String(input).includes("Special:UserLogin")
          ? new Response("Service Unavailable", { status: 503 })
          : (fetchWiki(input, init) as Promise<Response>),
      ),
    );
    const connector = new MediaWikiConnector("tester", ORIGIN, "geheim");
    await expect(connector.search("x")).rejects.toThrow(/sign-in page answered 503/);
    down = false;
    await expect(connector.search("x")).resolves.toHaveLength(1);
  });

  it("signs in with a bot password through action=login", async () => {
    resetMediaWikiSessions();
    wiki = fakeWiki({ user: "tester@eule", password: "botsecret" });
    vi.stubGlobal("fetch", wiki.fetch);
    await new MediaWikiConnector("tester@eule", `${ORIGIN}/w`, "botsecret").search("x");
    expect(wiki.posts()).toEqual(["action=login"]);
  });

  it("reads a rendered page as Markdown with sections, categories and files", async () => {
    const page = await new MediaWikiConnector("tester", ORIGIN, "geheim").readPage("Dienstreise");
    expect(page).toMatchObject({
      title: "Dienstreise",
      pageId: 42,
      revisionId: 9,
      timestamp: "2026-09-01T10:00:00Z",
      format: "markdown",
      sections: [{ index: "1", title: "Ablauf" }],
      categories: ["Personal und Recht"],
      files: ["Reiseantrag 2026.pdf"],
    });
    expect(page.content).toContain("## Ablauf");
    expect(page.content).toContain(
      `Antrag **vorher** mit [Formular](${ORIGIN}/wiki/Datei:Antrag.pdf) stellen.`,
    );
  });

  it("pages through a category with an opaque continue token", async () => {
    const connector = new MediaWikiConnector("tester", ORIGIN, "geheim");
    const first = await connector.listPages({ category: "Personal" });
    expect(first.pages.map((p) => p.title)).toEqual(["Dienstreise"]);
    expect(first.continueFrom).toBeDefined();
    await connector.listPages({ category: "Personal", continueFrom: first.continueFrom });
    const last = new URL(String(wiki.fetch.mock.calls.at(-1)?.[0]));
    expect(last.searchParams.get("cmtitle")).toBe("Category:Personal");
    expect(last.searchParams.get("cmcontinue")).toBe("page|abc");
  });
});

describe("WikiService", () => {
  const stub = (account: string) =>
    ({ account, readPage: vi.fn(async () => ({ title: account })) }) as unknown as WikiConnector;
  const registry = (connectors: WikiConnector[]) =>
    ({ getWikiConnectors: vi.fn(() => connectors) }) as unknown as ConnectorRegistry;

  it("explains how to configure a wiki when none is usable", async () => {
    await expect(new WikiService(registry([])).read("X")).rejects.toThrow(
      /No usable wiki connector is configured/,
    );
  });

  it("requires a choice when several wikis are configured", async () => {
    const service = new WikiService(registry([stub("intranet"), stub("lehre")]));
    await expect(service.read("X")).rejects.toThrow(/Several wikis are configured/);
    await expect(service.read("X", { wiki: "Lehre" })).resolves.toEqual({ title: "lehre" });
  });
});

describe("mediawiki connector configuration", () => {
  const base = { id: "intranet", type: "mediawiki", account: "tester", url: ORIGIN };
  const config = (kind: string, connector: object) => ({
    roles: [{ id: "work", name: "Work", weeklyHours: 40, connectors: { [kind]: [connector] } }],
  });

  it("is a password connector of the wiki domain", () => {
    expect(() => parseAppConfig(config("wiki", base))).not.toThrow();
    expect(() => parseAppConfig(config("documents", base))).toThrow(
      /does not support domain "documents"/,
    );
    expect(() => parseAppConfig(config("wiki", { ...base, url: undefined }))).toThrow(
      /requires "url"/,
    );
    expect(() => parseAppConfig(config("wiki", { ...base, token: "x" }))).toThrow(
      /requires a password/,
    );
  });

  it("accepts a keychain reference for the wiki domain", () => {
    expect(
      parseConnectorConfig({ ...base, credentialRef: "connector/work/wiki/intranet.a1b2" }),
    ).toMatchObject({ credentialRef: "connector/work/wiki/intranet.a1b2" });
  });
});

describe("MediaWikiConnector on BlueSpice with ExtendedSearch", () => {
  beforeEach(() => resetMediaWikiSessions());
  afterEach(() => vi.unstubAllGlobals());

  it("searches page and file contents through bs-extendedsearch-query", async () => {
    vi.stubGlobal("fetch", fakeWiki({ user: "tester", password: "geheim" }, "ok").fetch);
    const hits = await new MediaWikiConnector("tester", ORIGIN, "geheim").search("Dienstreise");
    expect(hits).toEqual([
      {
        title: "Handbuch:Dienstreise",
        namespace: 3000,
        snippet: "Antrag auf Dienstreise",
        size: undefined,
        url: `${ORIGIN}/w/index.php?title=Handbuch%3ADienstreise`,
      },
      {
        title: "Datei:Reiseantrag_2026.pdf",
        namespace: 6,
        snippet: "Formular für Dienstreisen & Kostenstelle",
        size: 52000,
        url: `${ORIGIN}/w/index.php?title=Datei%3AReiseantrag_2026.pdf`,
      },
    ]);
  });

  it("falls back to MediaWiki search when the search backend fails", async () => {
    vi.stubGlobal("fetch", fakeWiki({ user: "tester", password: "geheim" }, "broken").fetch);
    const hits = await new MediaWikiConnector("tester", ORIGIN, "geheim").search("Dienstreise");
    expect(hits.map((h) => h.title)).toEqual(["Dienstreise"]);
  });

  it("uses MediaWiki search for namespace and title filters", async () => {
    const wiki = fakeWiki({ user: "tester", password: "geheim" }, "ok");
    vi.stubGlobal("fetch", wiki.fetch);
    await new MediaWikiConnector("tester", ORIGIN, "geheim").search("x", { namespaces: [6] });
    const actions = wiki.fetch.mock.calls.map(([input]) => new URL(String(input)).searchParams);
    expect(actions.some((q) => q.get("action") === "bs-extendedsearch-query")).toBe(false);
    expect(actions.find((q) => q.get("list") === "search")?.get("srnamespace")).toBe("6");
  });
});
