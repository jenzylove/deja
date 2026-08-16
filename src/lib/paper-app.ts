import type { AuthenticatedTenantContext } from "./intent-service";
import { resolveConfiguredActor } from "./server-actor";
import { MemoryPaperStore } from "./paper-store-memory";
import type { WarningCode } from "./paper-trade";
import type { TradeRouteDependencies } from "./trade-route";

/**
 * Shared local-development wiring: a single in-memory store instance behind the
 * existing paper store interface, plus the fail-closed configured-single-tenant
 * actor resolver. In a release build this store is replaced by the live
 * CockroachDB adapter behind the same interface; without a live connection the
 * in-memory adapter fails closed when persistence is required but absent.
 */
class PaperApp {
  readonly store = new MemoryPaperStore();
  readonly resolveActor: () => Promise<AuthenticatedTenantContext | null> =
    () => resolveConfiguredActor();

  readonly resolveDecision = async (
    intent: unknown,
    userId: string,
  ): Promise<{ decision: "BLOCK" | "WARN" | "PASS"; warningsShown: WarningCode[] }> =>
    this.store.resolveDecisionFromRules(intent, userId);
}

/** Singleton so all /api/trades* routes share one tenant-scoped store. */
export const paperApp = new PaperApp();

export function tradeRouteDependencies(): TradeRouteDependencies {
  return {
    resolveActor: paperApp.resolveActor,
    store: paperApp.store,
    resolveDecision: paperApp.resolveDecision,
  };
}