import type { AuthenticatedTenantContext } from "./intent-service";
import { resolveConfiguredActor } from "./server-actor";
import { MemoryPaperStore } from "./paper-store-memory";
import { CockroachPaperStore } from "./paper-store";
import { envStatus } from "./env";
import type { WarningCode } from "./paper-trade";
import { defaultPriceFeed } from "./price-feed";
import type { TradeRouteDependencies } from "./trade-route";

/**
 * Shared wiring. When a live CockroachDB connection is configured
 * (DATABASE_URL present) the app uses the tenant-scoped CockroachPaperStore so
 * paper trades, decisions, outcomes, monitoring, settlement, behavior events, and
 * insights persist to the real cluster. Without one it falls back to the
 * in-memory store (ephemeral, clearly local). Both expose the same interface and
 * fail closed on persistence errors. The actor resolver stays the fail-closed
 * configured single tenant until real authentication is wired.
 */
class PaperApp {
  readonly store = envStatus().hasDatabase ? new CockroachPaperStore() : new MemoryPaperStore();
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
    // Free no-key crypto feed; fails closed to manual-close-only when unreachable.
    priceFeed: defaultPriceFeed,
  };
}