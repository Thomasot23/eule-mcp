import type { AccessMode } from "../config/index.js";
import type { BookingSignInTarget, ConnectorRegistry } from "../connectors/index.js";
import {
  annyTokenStore,
  authenticateAnny,
  classifyRequest,
  normalizeApiPath,
  readableTarget,
  simplify,
  type AnnyStoredToken,
  type AnnyTokenStore,
} from "../providers/anny/index.js";
import type {
  BookingAccess,
  BookingApiRequest,
  BookingAvailabilityQuery,
  BookingChangePlan,
  BookingConnector,
  BookingHttpMethod,
  BookingListFilter,
  BookingListOptions,
  BookingQuery,
} from "../types/index.js";
import { ChangePlanStore } from "./change-plan-store.js";

export const BOOKING_ACTIONS = [
  "accept",
  "reject",
  "cancel",
  "check_in",
  "check_out",
  "book",
] as const;
export type BookingAction = (typeof BOOKING_ACTIONS)[number];

/** Shortcuts each anny API surface supports. */
const ACTIONS_BY_ACCESS: Readonly<Record<BookingAccess, readonly BookingAction[]>> = {
  admin: ["accept", "reject", "cancel", "check_in", "check_out"],
  customer: ["book", "cancel"],
};

export interface BookingChangeInput {
  /** Shortcut for a common booking operation; needs `bookingId`. */
  readonly action?: BookingAction;
  readonly bookingId?: string;
  /** For `book`: what to book and when (ISO date-times). */
  readonly resourceId?: string;
  readonly serviceId?: string;
  readonly startDate?: string;
  readonly endDate?: string;
  /** Raw JSON:API request, for anything the shortcuts do not cover. */
  readonly method?: BookingHttpMethod;
  readonly path?: string;
  readonly query?: BookingQuery;
  readonly body?: unknown;
  readonly title?: string;
}

interface Preset {
  readonly request: BookingApiRequest;
  readonly title: string;
  /** Read shown as the "current state" in the preview, when it differs from the target. */
  readonly previewPath?: string;
}

function presetRequest(
  action: BookingAction,
  input: BookingChangeInput,
  access: BookingAccess,
): Preset {
  if (action === "book") {
    const { resourceId, serviceId, startDate, endDate } = input;
    if (!resourceId || !serviceId || !startDate || !endDate)
      throw new Error('Action "book" needs resource_id, service_id, start_date and end_date.');
    return {
      // Customer API: creates and completes the booking without the cart flow.
      request: {
        method: "POST",
        path: "/api/v1/bookings/instant",
        body: {
          start_date: startDate,
          end_date: endDate,
          resource_id: resourceId,
          service_id: serviceId,
        },
      },
      title: `Book resource ${resourceId} (service ${serviceId}) ${startDate} – ${endDate}`,
    };
  }
  const bookingId = input.bookingId;
  if (!bookingId) throw new Error(`Action "${action}" needs booking_id.`);
  const booking = normalizeApiPath(`/api/v1/bookings/${bookingId}`);
  const status = (value: string): BookingApiRequest => ({
    method: "PATCH",
    path: booking,
    body: { data: { type: "bookings", id: bookingId, attributes: { status: value } } },
  });
  switch (action) {
    case "accept":
      return { request: status("accepted"), title: `Accept requested booking ${bookingId}` };
    case "reject":
      return { request: status("rejected"), title: `Reject requested booking ${bookingId}` };
    case "cancel":
      // anny's cancellation flow: refunds and invoices follow the cancellation
      // policy, which the preview shows as fee and refund.
      return {
        request: { method: "GET", path: `${booking}/cancel` },
        title: `Cancel booking ${bookingId}`,
        ...(access === "customer" ? { previewPath: `${booking}/cancellation-preview` } : {}),
      };
    case "check_in":
      return {
        request: { method: "POST", path: `${booking}/check-in`, body: { data: {} } },
        title: `Check in booking ${bookingId}`,
      };
    case "check_out":
      return {
        request: { method: "POST", path: `${booking}/check-out`, body: { data: {} } },
        title: `Check out booking ${bookingId}`,
      };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateBody(method: BookingHttpMethod, path: string, body: unknown): void {
  if (method === "GET" || method === "DELETE") {
    if (body !== undefined) throw new Error(`${method} requests carry no body.`);
    return;
  }
  if (!isObject(body)) {
    throw new Error(
      `${method} needs a JSON body (a JSON:API document { "data": … } for most endpoints).`,
    );
  }
  const id = isObject(body.data) ? body.data.id : undefined;
  if (method === "PATCH" && typeof id === "string" && !path.endsWith(`/${id}`)) {
    throw new Error(`PATCH body id "${id}" does not match the path ${path}.`);
  }
}

/**
 * Booking-domain service. Reads pass straight through to the role's single
 * booking connector; writes only ever run from a change plan the user has
 * seen and confirmed, and only for roles that permit write access.
 */
export class BookingService {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly plans: ChangePlanStore = new ChangePlanStore(),
    private readonly signIn: {
      readonly authenticate: typeof authenticateAnny;
      readonly store: AnnyTokenStore;
    } = { authenticate: authenticateAnny, store: annyTokenStore },
  ) {}

  /**
   * Booking tools address one anny organization at a time. Several matching
   * connectors would make a listing or a write ambiguous, so the role must
   * leave exactly one.
   */
  private connector(role: string | undefined, mode: AccessMode): BookingConnector {
    const connectors = this.registry.getBookingConnectors(role, mode);
    const scope = role ? ` for role "${role}"` : "";
    const [first, ...rest] = connectors;
    if (!first) {
      if (mode === "write" && this.registry.getBookingConnectors(role, "read").length > 0)
        throw new Error(
          `Booking changes are not permitted${scope}: the role is read-only or excludes the booking domain.`,
        );
      throw new Error(
        `No usable booking connector is configured${scope}. Configure an anny connector (kind "booking", type "anny") with connector_configure and verify its credential with credential_status.`,
      );
    }
    if (rest.length > 0)
      throw new Error(
        `Several booking connectors match${scope} (${connectors.map((c) => c.account).join(", ")}). Pass a role that selects exactly one.`,
      );
    return first;
  }

  async whoami(role?: string) {
    return this.connector(role, "read").whoami();
  }
  async listBookings(filter: BookingListFilter, role?: string) {
    return this.connector(role, "read").listBookings(filter);
  }
  async getBooking(id: string, include?: string, role?: string) {
    return this.connector(role, "read").getBooking(id, include);
  }
  async listResources(options: BookingListOptions, role?: string) {
    return this.connector(role, "read").listResources(options);
  }
  async listServices(options: BookingListOptions, role?: string) {
    return this.connector(role, "read").listServices(options);
  }
  async listCustomers(options: BookingListOptions, role?: string) {
    return this.connector(role, "read").listCustomers(options);
  }
  async listOrders(options: BookingListOptions, role?: string) {
    return this.connector(role, "read").listOrders(options);
  }
  async availability(query: BookingAvailabilityQuery, role?: string) {
    return this.connector(role, "read").availability(query);
  }
  async get(path: string, query?: BookingQuery, raw = false, role?: string): Promise<unknown> {
    const body = await this.connector(role, "read").get(path, query);
    return raw ? body : simplify(body);
  }

  /** Validate a write and keep it as a plan; nothing is sent to anny except a read of the target. */
  async planChange(input: BookingChangeInput, role?: string): Promise<BookingChangePlan> {
    const usesPreset = input.action !== undefined;
    const usesRaw = input.method !== undefined || input.path !== undefined;
    if (usesPreset === usesRaw) {
      throw new Error("Pass either `action` + `booking_id` or `method` + `path`, not both.");
    }

    // Planning already requires write permission, so a read-only role fails here.
    const connector = this.connector(role, "write");

    let request: BookingApiRequest;
    let title: string;
    let previewPath: string | undefined;
    if (input.action !== undefined) {
      if (!ACTIONS_BY_ACCESS[connector.access].includes(input.action))
        throw new Error(
          `Action "${input.action}" is not available with ${connector.access} access (available: ${ACTIONS_BY_ACCESS[connector.access].join(", ")}).`,
        );
      ({ request, title, previewPath } = presetRequest(input.action, input, connector.access));
    } else {
      if (!input.method || !input.path) throw new Error("A raw change needs both method and path.");
      const path = normalizeApiPath(input.path);
      request = {
        method: input.method,
        path,
        ...(input.query ? { query: input.query } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
      };
      title = `${input.method} ${path}`;
    }
    if (input.title) title = input.title;

    if (classifyRequest(request.method, request.path) === "read") {
      throw new Error(`${request.method} ${request.path} is a read; use booking_api_get instead.`);
    }
    validateBody(request.method, request.path, request.body);

    const target = previewPath ?? readableTarget(request.path);
    let before: unknown;
    if (target) {
      try {
        before = simplify(await connector.get(target));
      } catch {
        before = undefined; // The preview is best effort; the plan stays valid.
      }
    }
    return this.plans.create({
      account: connector.account,
      ...(role !== undefined ? { role } : {}),
      request,
      title,
      ...(before !== undefined ? { before } : {}),
    });
  }

  /**
   * Execute a confirmed plan exactly as previewed. Each plan runs at most once,
   * and the role's write permission is checked again at apply time.
   */
  async applyChange(
    planId: string,
  ): Promise<{ plan: BookingChangePlan; status: number; result: unknown }> {
    const plan = this.plans.take(planId);
    const connector = this.connector(plan.role, "write");
    if (connector.account !== plan.account)
      throw new Error(
        `Plan ${plan.id} was made for "${plan.account}", but the role now resolves to "${connector.account}". Create a new plan.`,
      );
    const response = await connector.send(plan.request);
    return { plan, status: response.status, result: simplify(response.body) };
  }

  /** Pick the one "anny-oauth" connector a sign-in or sign-out addresses. */
  private signInTarget(role?: string, connectorId?: string): BookingSignInTarget {
    const all = this.registry.getBookingSignInTargets(role);
    const targets = connectorId ? all.filter((t) => t.connectorId === connectorId) : all;
    const [first, ...rest] = targets;
    if (!first)
      throw new Error(
        `No anny sign-in connector${role ? ` for role "${role}"` : ""}${connectorId ? ` with id "${connectorId}"` : ""}. Configure one with connector_configure (kind "booking", type "anny-oauth").`,
      );
    if (rest.length > 0)
      throw new Error(
        `Several anny sign-in connectors match (${targets.map((t) => `${t.role}/${t.connectorId}`).join(", ")}). Pass role and connector_id.`,
      );
    return first;
  }

  /** Sign the user in to anny (OAuth + PKCE through anny's own login and SSO). */
  async login(
    role?: string,
    connectorId?: string,
  ): Promise<{ target: BookingSignInTarget; token: AnnyStoredToken }> {
    const target = this.signInTarget(role, connectorId);
    const token = await this.signIn.authenticate({
      ...(target.clientId ? { clientId: target.clientId } : {}),
      ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
    });
    this.signIn.store.set(target.key, token);
    return { target, token };
  }

  /** Forget the stored anny session of a sign-in connector. */
  logout(role?: string, connectorId?: string): { target: BookingSignInTarget; removed: boolean } {
    const target = this.signInTarget(role, connectorId);
    return { target, removed: this.signIn.store.remove(target.key) };
  }

  listPlans(): BookingChangePlan[] {
    return this.plans.list();
  }

  discardPlan(planId: string): boolean {
    return this.plans.discard(planId);
  }
}
