import { describe, expect, it } from "vitest";
import { simplify, toPage, toResource } from "../src/providers/anny/jsonapi.js";

const document = {
  data: [
    {
      type: "bookings",
      id: "b1",
      attributes: { start_date: "2026-10-20T10:00:00+02:00", status: "accepted" },
      relationships: {
        resource: { data: { type: "resources", id: "r1" } },
        service: { data: { type: "services", id: "s-missing" } },
        sub_bookings: { data: [] },
        order: { data: null },
        customer: {},
      },
    },
  ],
  included: [
    {
      type: "resources",
      id: "r1",
      attributes: { name: "Raum 1.101" },
      relationships: { parent: { data: { type: "resources", id: "r0" } } },
    },
  ],
  meta: { page: { total: 42, "current-page": 1, "last-page": 3 } },
};

describe("simplify", () => {
  it("flattens attributes and resolves included relationships one level deep", () => {
    expect(simplify(document)).toEqual({
      data: [
        {
          type: "bookings",
          id: "b1",
          start_date: "2026-10-20T10:00:00+02:00",
          status: "accepted",
          resource: {
            type: "resources",
            id: "r1",
            name: "Raum 1.101",
            parent: { type: "resources", id: "r0" },
          },
          service: { type: "services", id: "s-missing" },
          sub_bookings: [],
          order: null,
        },
      ],
      total: 42,
      page: 1,
      lastPage: 3,
    });
  });

  it("passes non-JSON:API payloads through", () => {
    const plain = [{ start_date: "2026-10-20T09:00:00+02:00", available: true }];
    expect(simplify(plain)).toBe(plain);
    expect(simplify(null)).toBeNull();
    expect(simplify({ data: null })).toBeNull();
  });

  it("keeps resource meta", () => {
    expect(simplify({ data: { type: "x", id: "1", meta: { count: 2 } } })).toEqual({
      type: "x",
      id: "1",
      meta: { count: 2 },
    });
  });
});

describe("toPage / toResource", () => {
  it("rejects the wrong shape", () => {
    expect(toPage(document).total).toBe(42);
    expect(() => toPage({ data: { type: "x", id: "1" } })).toThrow(/collection/);
    expect(() => toResource(document)).toThrow(/single/);
  });
});
