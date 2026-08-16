import { PaperTradeError } from "./paper-trade";
import { buildInsightsView, type InsightsStore } from "./insights";
import type { AuthenticatedTenantContext } from "./intent-service";

export interface InsightsRouteDependencies {
  resolveActor(): Promise<AuthenticatedTenantContext | null>;
  store: InsightsStore;
}

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function resolveActor(deps: InsightsRouteDependencies): Promise<AuthenticatedTenantContext | null> {
  try {
    return await deps.resolveActor();
  } catch {
    return null;
  }
}

/**
 * GET /api/insights — the evidence-tiered Trading DNA and warning-compliance
 * (self-audit) views for the trusted tenant, derived only from stored outcomes,
 * observations, and qualified pattern candidates. Missing identity or a
 * persistence/malformed-store failure fails closed to a sanitized 503.
 */
export function createInsightsHandler(deps: InsightsRouteDependencies) {
  return async function GET(request?: Request): Promise<Response> {
    if (request && request.method !== "GET") {
      return json({ state: "method_not_allowed", message: "Use GET." }, 405);
    }
    const actor = await resolveActor(deps);
    if (!actor) {
      return json({ state: "unavailable", message: "Trusted server identity is unavailable." }, 503);
    }
    try {
      const view = await buildInsightsView({ userId: actor.userId }, deps.store);
      return json({ state: "ok", ...view }, 200);
    } catch (error) {
      if (error instanceof PaperTradeError) {
        return json({ state: "unavailable", message: "Insights are unavailable." }, 503);
      }
      return json({ state: "unavailable", message: "Insights are unavailable." }, 503);
    }
  };
}