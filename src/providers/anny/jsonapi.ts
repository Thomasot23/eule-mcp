import type { BookingPage, BookingRecord } from "../../types/index.js";

interface ResourceIdentifier {
  type: string;
  id: string;
}

interface ResourceObject extends ResourceIdentifier {
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: ResourceIdentifier | ResourceIdentifier[] | null }>;
  meta?: Record<string, unknown>;
}

interface JsonApiDocument {
  data: ResourceObject | ResourceObject[] | null;
  included?: ResourceObject[];
  meta?: { page?: { total?: number; "current-page"?: number; "last-page"?: number } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isResourceObject(value: unknown): value is ResourceObject {
  return isObject(value) && typeof value.type === "string" && typeof value.id === "string";
}

export function isJsonApiDocument(value: unknown): value is JsonApiDocument {
  if (!isObject(value) || !("data" in value)) return false;
  const { data } = value;
  return (
    data === null || isResourceObject(data) || (Array.isArray(data) && data.every(isResourceObject))
  );
}

const key = (r: ResourceIdentifier): string => `${r.type}:${r.id}`;

/** Flatten one resource; related records come from `included` without recursing further. */
function flatten(
  resource: ResourceObject,
  included: ReadonlyMap<string, ResourceObject>,
  depth: number,
): BookingRecord {
  const flat: Record<string, unknown> = {
    type: resource.type,
    id: resource.id,
    ...resource.attributes,
  };
  if (resource.meta && Object.keys(resource.meta).length > 0) flat.meta = resource.meta;
  for (const [name, rel] of Object.entries(resource.relationships ?? {})) {
    const data = rel.data;
    if (data === undefined) continue;
    const resolve = (ref: ResourceIdentifier): unknown => {
      const hit = included.get(key(ref));
      return hit && depth === 0
        ? flatten(hit, included, depth + 1)
        : { type: ref.type, id: ref.id };
    };
    flat[name] = data === null ? null : Array.isArray(data) ? data.map(resolve) : resolve(data);
  }
  return flat as BookingRecord;
}

function includedMap(doc: JsonApiDocument): Map<string, ResourceObject> {
  return new Map((doc.included ?? []).map((r) => [key(r), r]));
}

/** Turn a JSON:API document into plain records; other payloads pass through untouched. */
export function simplify(body: unknown): unknown {
  if (!isJsonApiDocument(body)) return body;
  const included = includedMap(body);
  const { data } = body;
  if (data === null) return null;
  if (Array.isArray(data)) {
    const page = body.meta?.page;
    return {
      data: data.map((r) => flatten(r, included, 0)),
      ...(page?.total !== undefined ? { total: page.total } : {}),
      ...(page?.["current-page"] !== undefined ? { page: page["current-page"] } : {}),
      ...(page?.["last-page"] !== undefined ? { lastPage: page["last-page"] } : {}),
    };
  }
  return flatten(data, included, 0);
}

export function toPage(body: unknown): BookingPage {
  const simple = simplify(body);
  if (isObject(simple) && Array.isArray(simple.data)) return simple as unknown as BookingPage;
  throw new Error("Expected a JSON:API collection from anny.");
}

export function toResource(body: unknown): BookingRecord {
  const simple = simplify(body);
  if (isObject(simple) && typeof simple.type === "string" && typeof simple.id === "string") {
    return simple as BookingRecord;
  }
  throw new Error("Expected a single JSON:API resource from anny.");
}
