import type {
  BookingAccess,
  BookingApiRequest,
  BookingApiResponse,
  BookingAvailabilityQuery,
  BookingConnector,
  BookingListFilter,
  BookingListOptions,
  BookingPage,
  BookingQuery,
  BookingRecord,
} from "../../types/index.js";
import { assertResponseSize, assertSecureUrl, fetchWithTimeout } from "../../utils/security.js";
import { classifyRequest, normalizeApiPath } from "./endpoint-policy.js";
import { toPage, toResource } from "./jsonapi.js";

export const ANNY_DEFAULT_URL = "https://b.anny.co";

const JSON_API = "application/vnd.api+json";
/** A GET hit by the rate limit is retried once when anny asks for at most this long. */
const MAX_RETRY_AFTER_SECONDS = 10;

/**
 * Supplies the bearer token per request: the personal access token from the
 * credential store ("anny"), or the signed-in user's OAuth token, refreshed
 * when due ("anny-oauth").
 */
export type AnnyTokenSource = () => Promise<string | null>;

export interface AnnyConnectorOptions {
  readonly baseUrl?: string;
  /**
   * Admin access: organization UUID sent as `?o=` (only needed when the token
   * spans several organizations). Customer access: organization slug used to
   * list the organization's resources and services.
   */
  readonly organization?: string;
  readonly locale?: string;
  /** Admin API (team members) or Customer API (people who book). Default admin. */
  readonly access?: BookingAccess;
  /** Hint shown when anny rejects the token. */
  readonly signInHint?: string;
}

export class AnnyApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    detail: string,
  ) {
    super(`anny ${method} ${path}: ${String(status)} ${detail}`);
    this.name = "AnnyApiError";
  }
}

const pagination = (page?: number, pageSize?: number): BookingQuery => ({
  "page[number]": page,
  "page[size]": pageSize,
});

const filters = (filter: BookingListOptions["filter"]): BookingQuery =>
  Object.fromEntries(Object.entries(filter ?? {}).map(([k, v]) => [`filter[${k}]`, v]));

const RANGE_FILTER = {
  start: "filter[start_date_range]",
  end: "filter[end_date_range]",
  period: "filter[period_range]",
  created: "filter[created_at_range]",
} as const;

const DATE_RANGE = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/;

/** The Customer API filters by plain dates instead of the Admin API's range presets. */
function customerRange(range: string | undefined): BookingQuery {
  if (!range) return {};
  if (range === "future" || range === "upcoming") return { "filter[upcoming_only]": true };
  const match = DATE_RANGE.exec(range);
  if (!match)
    throw new Error(
      'With customer access, range must be "YYYY-MM-DD:YYYY-MM-DD" or "future"; presets like next_7_days need admin access.',
    );
  return { "filter[start_date]": match[1], "filter[end_date]": match[2] };
}

export class AnnyConnector implements BookingConnector {
  readonly tier = "anny";
  readonly access: BookingAccess;

  constructor(
    readonly account: string,
    private readonly tokenSource: AnnyTokenSource,
    private readonly options: AnnyConnectorOptions = {},
  ) {
    this.access = options.access ?? "admin";
  }

  /** Validated base URL — the API token must never traverse cleartext. */
  private get root(): string {
    return assertSecureUrl(this.options.baseUrl ?? ANNY_DEFAULT_URL, "anny URL").replace(
      /\/+$/,
      "",
    );
  }

  private adminOnly(what: string): never {
    throw new Error(
      `${what} needs admin access to anny; this connector uses customer access (own bookings only).`,
    );
  }

  private organizationSlug(): string {
    const slug = this.options.organization;
    if (!slug)
      throw new Error(
        'Customer access needs the organization slug (connector field "organization") to list resources and services.',
      );
    return slug;
  }

  private errorDetail(status: number, body: unknown): string {
    const errors = (body as { errors?: { title?: string; detail?: string }[] } | null)?.errors;
    const detail = Array.isArray(errors)
      ? errors
          .map((e) => e.detail ?? e.title ?? "")
          .filter(Boolean)
          .join("; ")
      : typeof body === "string"
        ? body.slice(0, 300)
        : "";
    if (status === 401) {
      const hint =
        this.options.signInHint ??
        "The anny API token is missing, expired or revoked. Rotate it with credential_rotate.";
      return `${detail || "Unauthorized"} — ${hint}`;
    }
    if (status === 403) {
      return `${detail || "Forbidden"} — the token lacks the scope or anny permission for this call.`;
    }
    return detail;
  }

  buildUrl(path: string, query: BookingQuery = {}): string {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const item of value as readonly unknown[]) params.append(`${name}[]`, String(item));
      } else {
        params.append(name, String(value));
      }
    }
    // Only the Admin API takes the organization context as `?o=`.
    if (this.access === "admin" && this.options.organization && !params.has("o")) {
      params.append("o", this.options.organization);
    }
    const qs = params.toString();
    return `${this.root}${normalizeApiPath(path)}${qs ? `?${qs}` : ""}`;
  }

  private async request(
    request: BookingApiRequest,
    allowRetry: boolean,
  ): Promise<BookingApiResponse> {
    const url = this.buildUrl(request.path, request.query);
    const headers: Record<string, string> = { Accept: `${JSON_API}, application/json` };
    const token = await this.tokenSource();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.options.locale) headers["Accept-Language"] = this.options.locale;
    const init: RequestInit = { method: request.method, headers };
    if (request.body !== undefined) {
      // JSON:API documents go as vnd.api+json; some Customer API actions
      // (instant booking, personalization) take plain JSON objects.
      const isDocument =
        typeof request.body === "object" && request.body !== null && "data" in request.body;
      headers["Content-Type"] = isDocument ? JSON_API : "application/json";
      init.body = JSON.stringify(request.body);
    }
    const res = await fetchWithTimeout(url, init);
    assertResponseSize(res);

    if (res.status === 429 && allowRetry) {
      const wait = Number(res.headers.get("retry-after") ?? "");
      if (Number.isFinite(wait) && wait <= MAX_RETRY_AFTER_SECONDS) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 1) * 1000));
        return this.request(request, false);
      }
    }

    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!res.ok) {
      throw new AnnyApiError(
        res.status,
        request.method,
        request.path,
        this.errorDetail(res.status, body),
      );
    }
    return { status: res.status, body };
  }

  /** Read-only GET. Refuses any path that is not on the read allowlist. */
  async get(path: string, query?: BookingQuery): Promise<unknown> {
    if (classifyRequest("GET", path) !== "read") {
      throw new Error(
        `GET ${path} is not a documented read-only endpoint (anny has GET routes that change data). Plan it with booking_change_plan instead.`,
      );
    }
    return (await this.request({ method: "GET", path, query }, true)).body;
  }

  /**
   * Execute any request, writes included. Only BookingService.applyChange
   * calls this, after the user confirmed the exact request.
   */
  async send(request: BookingApiRequest): Promise<BookingApiResponse> {
    return this.request(request, false);
  }

  async whoami(): Promise<{ user: BookingRecord | null; organization: BookingRecord | null }> {
    if (this.access === "customer") {
      return { user: toResource(await this.get("/api/v1/customer-account")), organization: null };
    }
    const [user, organization] = await Promise.allSettled([
      this.get("/api/v1/user"),
      this.get("/api/v1/organization"),
    ]);
    if (user.status === "rejected" && organization.status === "rejected") throw user.reason;
    return {
      user: user.status === "fulfilled" ? toResource(user.value) : null,
      organization: organization.status === "fulfilled" ? toResource(organization.value) : null,
    };
  }

  /** Admin: all bookings of the organization. Customer: the signed-in person's own bookings. */
  async listBookings(filter: BookingListFilter): Promise<BookingPage> {
    const range: BookingQuery =
      this.access === "customer"
        ? customerRange(filter.range)
        : filter.range
          ? { [RANGE_FILTER[filter.rangeField ?? "start"]]: filter.range }
          : {};
    const query: BookingQuery = {
      ...range,
      "filter[status]": filter.status,
      "filter[resources]": filter.resources,
      ...(this.access === "admin" ? { "filter[services]": filter.services } : {}),
      "filter[search]": filter.search,
      "filter[email]": filter.email,
      "filter[hide_blocker]": filter.hideBlockers ? true : undefined,
      include: filter.include,
      sort: filter.sort,
      ...pagination(filter.page, filter.pageSize),
    };
    return toPage(await this.get("/api/v1/bookings", query));
  }

  async getBooking(id: string, include?: string): Promise<BookingRecord> {
    if (this.access === "customer") this.adminOnly("Reading a booking by ID");
    return toResource(await this.get(`/api/v1/bookings/${id}`, { include }));
  }

  private async list(path: string, options: BookingListOptions): Promise<BookingPage> {
    const query: BookingQuery = {
      ...filters(options.filter),
      "filter[search]": options.search,
      include: options.include,
      sort: options.sort,
      ...pagination(options.page, options.pageSize),
    };
    return toPage(await this.get(path, query));
  }

  listResources(options: BookingListOptions): Promise<BookingPage> {
    return this.access === "customer"
      ? this.list(`/api/v1/organizations/${this.organizationSlug()}/resources`, options)
      : this.list("/api/v1/resources", options);
  }

  listServices(options: BookingListOptions): Promise<BookingPage> {
    return this.access === "customer"
      ? this.list(`/api/v1/organizations/${this.organizationSlug()}/services`, options)
      : this.list("/api/v1/services", options);
  }

  listCustomers(options: BookingListOptions): Promise<BookingPage> {
    if (this.access === "customer") this.adminOnly("Searching customers");
    return this.list("/api/v1/customers", options);
  }

  listOrders(options: BookingListOptions): Promise<BookingPage> {
    if (this.access === "customer") this.adminOnly("Listing orders");
    return this.list("/api/v1/orders", options);
  }

  async availability(query: BookingAvailabilityQuery): Promise<unknown> {
    const base: BookingQuery = { service_id: query.serviceId, resource_id: query.resourceId };
    switch (query.kind) {
      case "service-configuration":
        return this.get("/api/v1/service-configuration", base);
      case "next-date":
        return this.get("/api/v1/availability/next-date", base);
      case "start-dates":
        return this.get("/api/v1/availability/start-dates", {
          ...base,
          start_date: query.startDate,
          end_date: query.endDate,
        });
      case "start":
        return this.get("/api/v1/availability/start", {
          ...base,
          date: query.date,
          duration: query.duration,
        });
    }
  }
}
