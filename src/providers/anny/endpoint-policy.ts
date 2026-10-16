import type { BookingHttpMethod } from "../../types/index.js";
import type { AccessMode } from "../../config/index.js";
import { READ_ENDPOINTS, RESERVED_SEGMENTS } from "./read-endpoints.generated.js";

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * Validate a caller-supplied API path and return it without a trailing slash.
 * Query strings belong in the separate `query` object so they cannot smuggle
 * a second path or override the organization context.
 */
export function normalizeApiPath(raw: string): string {
  const path = raw.trim();
  if (!path.startsWith("/api/v1/")) {
    throw new Error(`Path must start with /api/v1/ (got "${raw}").`);
  }
  if (/[?#]/.test(path)) {
    throw new Error("Pass query parameters in `query`, not in the path.");
  }
  const segments = path.split("/").slice(1);
  if (segments.at(-1) === "") segments.pop();
  for (const segment of segments) {
    if (!SEGMENT.test(segment) || segment === "." || segment === "..") {
      throw new Error(`Invalid path segment "${segment}" in "${raw}".`);
    }
  }
  return `/${segments.join("/")}`;
}

const TEMPLATES: readonly (readonly string[])[] = READ_ENDPOINTS.map(([template]) =>
  template.split("/").filter(Boolean),
);

function matchesTemplate(segments: readonly string[], template: readonly string[]): boolean {
  if (segments.length !== template.length) return false;
  return template.every((part, i) => {
    const segment = segments[i] ?? "";
    // "{}" stands for an ID or slug, never for a fixed word such as "export" or "instant".
    return part === "{}" ? !RESERVED_SEGMENTS.has(segment) : part === segment;
  });
}

/** True when `path` is a documented, side-effect-free GET endpoint. */
export function isReadEndpoint(path: string): boolean {
  const segments = normalizeApiPath(path).split("/").filter(Boolean);
  return TEMPLATES.some((template) => matchesTemplate(segments, template));
}

/**
 * Decide whether a request may run without confirmation. anny has GET routes
 * that cancel, send or create things, so a request counts as a read only when
 * it is a GET on the allowlist; everything else — including unknown GETs — is
 * a write that needs a confirmed change plan.
 */
export function classifyRequest(method: BookingHttpMethod, path: string): AccessMode {
  return method === "GET" && isReadEndpoint(path) ? "read" : "write";
}

/**
 * The closest readable record a write targets, e.g. `/api/v1/bookings/{id}`
 * for `/api/v1/bookings/{id}/cancel`. Used to show the current state in a
 * change preview.
 */
export function readableTarget(path: string): string | undefined {
  const segments = normalizeApiPath(path).split("/").filter(Boolean);
  for (let length = segments.length; length > 3; length--) {
    const candidate = `/${segments.slice(0, length).join("/")}`;
    if (isReadEndpoint(candidate)) return candidate;
  }
  return undefined;
}
