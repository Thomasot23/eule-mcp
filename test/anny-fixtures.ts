import { vi } from "vitest";

export interface RecordedCall {
  url: URL;
  method: string;
  headers: Record<string, string>;
  rawBody: string | undefined;
  body: unknown;
}

export type Responder = (call: RecordedCall) => {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
};

/** Replace global fetch with a recorder that answers through `responder`. */
export function stubFetch(responder: Responder): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const rawBody = typeof init?.body === "string" ? init.body : undefined;
      const call: RecordedCall = {
        url: new URL(input instanceof Request ? input.url : String(input)),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        rawBody,
        body: rawBody ? (JSON.parse(rawBody) as unknown) : undefined,
      };
      calls.push(call);
      const { status = 200, body, headers = {} } = responder(call);
      const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
      return Promise.resolve(new Response(text || null, { status, headers }));
    }),
  );
  return calls;
}

export const ORG = "11111111-2222-4333-8444-555555555555";
export const BOOKING_ID = "0b5e1d2c-1111-4222-8333-944455556666";
export const BOOKING_PATH = `/api/v1/bookings/${BOOKING_ID}`;

export const bookingDoc = (status = "requested") => ({
  data: {
    type: "bookings",
    id: BOOKING_ID,
    attributes: { status, start_date: "2026-10-20T10:00:00+02:00" },
  },
});
