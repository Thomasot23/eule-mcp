import { randomBytes } from "node:crypto";
import type { BookingApiRequest, BookingChangePlan } from "../types/index.js";

export const PLAN_TTL_MS = 15 * 60 * 1000;

export interface ChangePlanDraft {
  readonly account: string;
  readonly role?: string;
  readonly request: BookingApiRequest;
  readonly title: string;
  readonly before?: unknown;
}

/**
 * In-memory store for previewed booking writes. A plan is applied at most once
 * and expires after PLAN_TTL_MS, so a confirmation cannot be replayed later or
 * applied to a request other than the one the user saw.
 */
export class ChangePlanStore {
  private readonly plans = new Map<string, BookingChangePlan>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PLAN_TTL_MS,
  ) {}

  create(draft: ChangePlanDraft): BookingChangePlan {
    this.prune();
    const created = this.now();
    const plan: BookingChangePlan = {
      id: `chg_${randomBytes(4).toString("hex")}`,
      account: draft.account,
      ...(draft.role !== undefined ? { role: draft.role } : {}),
      request: draft.request,
      title: draft.title,
      ...(draft.before !== undefined ? { before: draft.before } : {}),
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.ttlMs).toISOString(),
    };
    this.plans.set(plan.id, plan);
    return plan;
  }

  /** Remove and return a live plan; throws when it is unknown, used or expired. */
  take(id: string): BookingChangePlan {
    this.prune();
    const plan = this.plans.get(id);
    if (!plan) {
      throw new Error(
        `Change plan ${id} does not exist, was already applied or expired. Create a new plan and confirm it again.`,
      );
    }
    this.plans.delete(id);
    return plan;
  }

  discard(id: string): boolean {
    return this.plans.delete(id);
  }

  list(): BookingChangePlan[] {
    this.prune();
    return [...this.plans.values()];
  }

  private prune(): void {
    const now = this.now();
    for (const [id, plan] of this.plans) {
      if (Date.parse(plan.expiresAt) <= now) this.plans.delete(id);
    }
  }
}
