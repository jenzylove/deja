import { coreDejaCheck, type HistorySource, type HistoryOutcome, type ProposedTrade } from "./deja-check";
import type { AuthenticatedTenantContext } from "./intent-service";
import { type CockroachPaperStore } from "./paper-store";
import { type ImportedTrade } from "./imported-trade";

export interface CheckRouteDependencies {
  resolveActor(): Promise<AuthenticatedTenantContext | null>;
  store: CockroachPaperStore;
}

function json(payload: unknown, status: number): Response {
  return Response.json(payload, { status, headers: { "cache-control": "no-store" } });
}

/**
 * Build the tenant's history source for the pre-trade check: exchange-imported
 * trades (PRD §3.2) merged with any paper-closed outcomes. This is what lets
 * Deja answer "have I done this before, and what happened?".
 */
export function historySourceFor(store: CockroachPaperStore): HistorySource {
  return {
    loadClosedOutcomes: async (userId: string) => {
      const imported: ImportedTrade[] = await store.listImportedTrades(userId);
      const importedOutcomes: HistoryOutcome[] = imported.map((t) => ({
        tradeId: t.exchangeOrderId,
        asset: t.asset,
        direction: t.direction,
        size: t.size,
        rMultiple: t.exitPrice !== null && t.entryPrice > 0
          ? (t.direction === "long"
            ? (t.exitPrice - t.entryPrice) / t.entryPrice
            : (t.entryPrice - t.exitPrice) / t.entryPrice)
          : 0,
        openedAt: t.entryAt,
      }));
      const closed: unknown = await store.loadClosedOutcomes(userId);
      return [...importedOutcomes, ...(Array.isArray(closed) ? closed : [])];
    },
  };
}

export function createCheckHandler(deps: CheckRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const actor = await deps.resolveActor().catch(() => null);
    if (!actor) return json({ state: "unavailable", message: "Trusted server identity is unavailable." }, 503);
    let body: unknown;
    try { body = await request.json(); }
    catch { return json({ state: "validation_error", message: "Request body must be valid JSON." }, 400); }
    const p = body as ProposedTrade;
    if (typeof p !== "object" || p === null || typeof p.asset !== "string" || !p.asset ||
        (p.direction !== "long" && p.direction !== "short") ||
        typeof p.entry !== "number" || !Number.isFinite(p.entry) || p.entry <= 0 ||
        typeof p.size !== "number" || !Number.isFinite(p.size) || p.size <= 0) {
      return json({ state: "validation_error", message: "Proposed trade is invalid." }, 400);
    }
    try {
      const result = await coreDejaCheck(historySourceFor(deps.store), p, actor.userId);
      return json({ state: "ok", ...result }, 200);
    } catch {
      return json({ state: "unavailable", message: "Deja check is unavailable." }, 503);
    }
  };
}