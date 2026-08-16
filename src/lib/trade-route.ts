import { createHash } from "node:crypto";
import { z } from "zod";

import {
  PaperTradeError,
  closePaperTrade,
  executePaperTrade,
  refreshPaperMemory,
  WARNING_CODES,
  type WarningCode,
} from "./paper-trade";
import { MemoryPaperStore } from "./paper-store-memory";
import { type CockroachPaperStore } from "./paper-store";
import {
  buildBehaviorEvent,
  evaluateDejaPositions,
  listSettleablePositions,
  settleDoneTrades,
  unavailablePriceFeed,
  validateBehaviorEventList,
  type PriceFeed,
} from "./paper-ops";
import type { AuthenticatedTenantContext } from "./intent-service";

export const MAX_TRADE_BODY_BYTES = 16_384;

export interface TradeRouteDependencies {
  resolveActor(): Promise<AuthenticatedTenantContext | null>;
  store: MemoryPaperStore | CockroachPaperStore;
  resolveDecision(
    intent: unknown,
    userId: string,
  ): Promise<{ decision: "BLOCK" | "WARN" | "PASS"; warningsShown: WarningCode[] }>;
  /** Injectable simulated price source; absent => fail closed to manual-close-only. */
  priceFeed?: PriceFeed;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const warningCodeSchema = z.enum(WARNING_CODES as unknown as [string, ...string[]]);

const intentSchema = z
  .object({
    asset: z.string().min(1).max(100),
    assetClass: z.string().min(1).max(100),
    direction: z.enum(["long", "short"]),
    size: z.number().positive(),
    entry: z.number().positive(),
    stopLoss: z.number().positive().nullable(),
    takeProfit: z.number().positive().nullable(),
    riskPct: z.number().finite(),
    confidence: z.string().max(100).optional(),
    thesisRaw: z.string().min(1).max(20_000),
    regime: z.string().min(1).max(50),
    session: z.string().min(1).max(50),
    sizeIncreaseAfterLoss: z.boolean(),
  })
  .strict();

const executeSchema = z
  .object({
    intent: intentSchema,
    action: z.enum(["executed", "modified_then_executed"]),
    warningsDefied: z.array(warningCodeSchema).max(20),
  })
  .strict();

const closeSchema = z
  .object({
    tradeId: z.string().regex(UUID),
    exitFill: z.number().positive().finite(),
  })
  .strict();

const settleSchema = z
  .object({
    tradeIds: z.array(z.string().regex(UUID)).min(1).max(100),
  })
  .strict();

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Deterministic intent identity for replay/idempotency: the same tenant and the
 * exact canonical intent content derive the same v5-style UUID, so a retried
 * execute resolves to the same trade instead of minting a second one.
 */
function deterministicIntentId(
  userId: string,
  intent: z.infer<typeof intentSchema>,
): string {
  const canonical = JSON.stringify({
    asset: intent.asset,
    assetClass: intent.assetClass,
    direction: intent.direction,
    size: intent.size,
    entry: intent.entry,
    stopLoss: intent.stopLoss ?? null,
    takeProfit: intent.takeProfit ?? null,
    riskPct: intent.riskPct,
    thesisRaw: intent.thesisRaw,
    regime: intent.regime,
    session: intent.session,
    sizeIncreaseAfterLoss: intent.sizeIncreaseAfterLoss,
  });
  const digest = createHash("sha256").update(`${userId}:${canonical}`).digest("hex");
  const b = digest.slice(0, 32);
  const ab = ((parseInt(b[16], 16) & 0x03) | 0x08).toString(16); // RFC 4122 variant 10xx -> 8..b
  return (
    `${b.slice(0, 8)}-${b.slice(8, 12)}-5${b.slice(13, 16)}-` +
    `${ab}${b.slice(17, 20)}-${b.slice(20, 32)}`
  );
}

class BodyTooLargeError extends Error {}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_TRADE_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_TRADE_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function tradeErrorToResponse(error: PaperTradeError): Response {
  switch (error.code) {
    case "EXECUTION_BLOCKED":
      return json({ state: "blocked", decision: "BLOCK", message: error.message }, 409);
    case "INVALID_WARNING_DEFIANCE":
    case "INVALID_REQUEST":
      return json({ state: "validation_error", message: error.message }, 400);
    case "TRADE_NOT_FOUND":
      return json({ state: "not_found", message: error.message }, 404);
    case "TRADE_ALREADY_CLOSED":
      return json({ state: "already_closed", message: error.message }, 409);
    case "TRADE_NOT_CLOSED":
      return json({ state: "not_found", message: error.message }, 404);
    case "PERSISTENCE_UNAVAILABLE":
      return json({ state: "unavailable", message: error.message }, 503);
    default:
      return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
  }
}

async function resolveActor(deps: TradeRouteDependencies): Promise<AuthenticatedTenantContext | null> {
  try {
    return await deps.resolveActor();
  } catch {
    return null;
  }
}

/**
 * POST /api/trades — turn a server-derived decision into an allowed paper trade
 * and return the real open trade state. BLOCK forbids execution (zero writes),
 * WARN requires explicit recorded defiance, PASS executes.
 */
export function createTradeExecuteHandler(deps: TradeRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const actor = await resolveActor(deps);
    if (!actor) {
      return json({ state: "unavailable", message: "Trusted server identity is unavailable." }, 503);
    }

    let bodyText: string;
    try {
      bodyText = await readBoundedBody(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return json({ state: "validation_error", message: "Request body is too large." }, 413);
      }
      return json({ state: "validation_error", message: "Request body could not be read." }, 400);
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      return json({ state: "validation_error", message: "Request body must be valid JSON." }, 400);
    }

    const parsed = executeSchema.safeParse(body);
    if (!parsed.success) {
      return json({ state: "validation_error", message: "Invalid paper trade execute request." }, 400);
    }

    let decision: { decision: "BLOCK" | "WARN" | "PASS"; warningsShown: WarningCode[] };
    try {
      decision = await deps.resolveDecision(parsed.data.intent, actor.userId);
    } catch (error) {
      if (error instanceof PaperTradeError && error.code === "INVALID_REQUEST") {
        return json({ state: "validation_error", message: error.message }, 400);
      }
      return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
    }

    const intent = parsed.data.intent;
    const intentId = deterministicIntentId(actor.userId, intent);
    try {
      void deps.store.recordBehaviorEvent(buildBehaviorEvent({
        userId: actor.userId, type: "decision", subjectKind: "intent", subjectId: intentId,
        at: new Date().toISOString(), availability: "atomic",
        acceptance: decision.decision === "BLOCK" ? "blocked"
          : parsed.data.warningsDefied.length > 0 ? "defied" : "accepted",
        outcome: {
          decision: decision.decision, warningsShown: decision.warningsShown.join(","),
          blocked: decision.decision === "BLOCK",
        },
        verification: { idempotent: false, decision: decision.decision },
      }));
      if (decision.decision === "BLOCK") {
        return json({ state: "blocked", decision: "BLOCK", message: "Blocked trade intents cannot execute." }, 409);
      }
      await deps.store.registerPendingIntent({
        userId: actor.userId,
        intentId,
        asset: intent.asset,
        assetClass: intent.assetClass,
        direction: intent.direction,
        size: intent.size,
        entry: intent.entry,
        stopLoss: intent.stopLoss,
        takeProfit: intent.takeProfit,
        riskPct: intent.riskPct,
        thesisRaw: intent.thesisRaw,
        strategy: null,
        regime: intent.regime,
        session: intent.session,
      });
      const result = await executePaperTrade(
        { action: parsed.data.action, warningsDefied: parsed.data.warningsDefied },
        { userId: actor.userId },
        { intentId, decision: decision.decision, warningsShown: decision.warningsShown },
        deps.store,
      );
      const open = (await deps.store.openTrades(actor.userId)).find((trade) => trade.id === result.tradeId);
      if (!open) {
        return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
      }
      void deps.store.recordBehaviorEvent(buildBehaviorEvent({
        userId: actor.userId, type: "execution", subjectKind: "trade", subjectId: result.tradeId,
        at: open.openedAt, availability: "atomic",
        acceptance: result.replayed ? "replayed" : "new",
        outcome: { tradeId: result.tradeId, action: parsed.data.action, replayed: result.replayed, decision: decision.decision },
        verification: { idempotent: result.replayed, decision: decision.decision },
      }));
      return json(
        {
          state: "executed",
          decision: decision.decision,
          decisionId: result.decisionId,
          tradeId: result.tradeId,
          replayed: result.replayed,
          warningsShown: decision.warningsShown,
          warningsDefied: parsed.data.warningsDefied,
          trade: { id: open.id, asset: open.asset, direction: open.direction, size: open.size, entry: open.entry, stop: open.stop, openedAt: open.openedAt },
        },
        200,
      );
    } catch (error) {
      if (error instanceof PaperTradeError) return tradeErrorToResponse(error);
      return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
    }
  };
}

/**
 * GET /api/trades — list the actor's open paper trades.
 */
export function createTradeListHandler(deps: TradeRouteDependencies) {
  return async function GET(): Promise<Response> {
    const actor = await resolveActor(deps);
    if (!actor) {
      return json({ state: "unavailable", message: "Trusted server identity is unavailable." }, 503);
    }
    try {
      const open = await deps.store.openTrades(actor.userId);
      return json({
        trades: open.map((trade) => ({
          id: trade.id, asset: trade.asset, direction: trade.direction,
          size: trade.size, entry: trade.entry, stop: trade.stop, openedAt: trade.openedAt,
        })),
      }, 200);
    } catch (error) {
      if (error instanceof PaperTradeError) return tradeErrorToResponse(error);
      return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
    }
  };
}

const REFRESH_DEFAULTS = { kind: "strategy", filter: {}, baselineRate: 0.5 } as const;

/**
 * POST /api/trades/close — manually close an open paper trade with the fill
 * price, persist the outcome, and refresh the tenant's derived memory.
 */
export function createTradeCloseHandler(deps: TradeRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const actor = await resolveActor(deps);
    if (!actor) {
      return json({ state: "unavailable", message: "Trusted server identity is unavailable." }, 503);
    }

    let bodyText: string;
    try {
      bodyText = await readBoundedBody(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return json({ state: "validation_error", message: "Request body is too large." }, 413);
      }
      return json({ state: "validation_error", message: "Request body could not be read." }, 400);
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      return json({ state: "validation_error", message: "Request body must be valid JSON." }, 400);
    }

    const parsed = closeSchema.safeParse(body);
    if (!parsed.success) {
      return json({ state: "validation_error", message: "Invalid paper trade close request." }, 400);
    }

    try {
      const closedAt = new Date().toISOString();
      const outcome = await closePaperTrade(
        {
          tradeId: parsed.data.tradeId,
          exitFill: parsed.data.exitFill,
          exitReason: "manual" as const,
          closedAt,
        },
        { userId: actor.userId },
        deps.store,
      );
      void deps.store.recordBehaviorEvent(buildBehaviorEvent({
        userId: actor.userId, type: "closure", subjectKind: "trade", subjectId: outcome.tradeId,
        at: closedAt, availability: "atomic", acceptance: "closed",
        outcome: {
          tradeId: outcome.tradeId, exitFill: outcome.exitFill, exitReason: outcome.exitReason,
          pnl: outcome.pnl, rMultiple: outcome.rMultiple,
        },
        verification: { idempotent: false, decision: null },
      }));
      const memory = await refreshPaperMemory(
        { ...REFRESH_DEFAULTS, kind: "strategy" },
        { userId: actor.userId },
        deps.store,
      );
      return json(
        {
          state: "closed",
          outcome: {
            tradeId: outcome.tradeId,
            intentId: outcome.intentId,
            pnl: outcome.pnl,
            rMultiple: outcome.rMultiple,
            durationS: outcome.durationS,
            exitFill: outcome.exitFill,
            exitReason: outcome.exitReason,
            win: outcome.pnl > 0,
          },
          memory: {
            evidence: {
              tier: memory.evidence.tier,
              n: memory.evidence.n,
              averageR: "averageR" in memory.evidence ? memory.evidence.averageR : null,
            },
            lineage: outcome.intentId,
          },
        },
        200,
      );
    } catch (error) {
      if (error instanceof PaperTradeError) return tradeErrorToResponse(error);
      return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
    }
  };
}

const UNTRUSTED_METHOD = json({ state: "method_not_allowed", message: "Method not allowed." }, 405);

/**
 * GET /api/trades/monitor — evaluate the tenant's open trades against the
 * injected simulated price feed and auto-close any stop/target that is hit,
 * reusing the shared closure path. Never fabricates fills. Fails closed to a
 * price-feed-unavailable state (manual close only) when no price is available.
 */
export function createTradeMonitorHandler(deps: TradeRouteDependencies) {
  return async function GET(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return json({ state: "method_not_allowed", message: "Use GET." }, 405);
    }
    const actor = await resolveActor(deps);
    if (!actor) {
      return json({ state: "unavailable", message: "Trusted server identity is unavailable." }, 503);
    }
    try {
      const result = await evaluateDejaPositions({ userId: actor.userId }, {
        store: deps.store,
        priceFeed: deps.priceFeed ?? unavailablePriceFeed,
        now: () => new Date().toISOString(),
      });
      if (result.open.length > 0 && result.closed.length === 0 && result.priceFeed === "unavailable") {
        return json({
          state: "price_feed_unavailable",
          message: "Price feed is unavailable; use manual close only.",
          manualCloseOnly: result.open.map((trade) => trade.tradeId),
        }, 503);
      }
      return json({
        priceFeed: result.priceFeed,
        open: result.open,
        closed: result.closed,
        trades: result.open,
      }, 200);
    } catch (error) {
      if (error instanceof PaperTradeError) return tradeErrorToResponse(error);
      return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
    }
  };
}

/**
 * GET /api/trades/events — list the actor's own append-only behavioral events
 * (decision, execution, closure, monitoring, settlement), sanitized and
 * detached. Never surfaces another tenant's events.
 */
export function createBehaviorListHandler(deps: TradeRouteDependencies) {
  return async function GET(request?: Request): Promise<Response> {
    if (request && request.method !== "GET") {
      return UNTRUSTED_METHOD;
    }
    const actor = await resolveActor(deps);
    if (!actor) {
      return json({ state: "unavailable", message: "Trusted server identity is unavailable." }, 503);
    }
    try {
      const raw = await deps.store.listBehaviorEvents(actor.userId);
      const events = validateBehaviorEventList(raw);
      return json({ events }, 200);
    } catch (error) {
      if (error instanceof PaperTradeError) return tradeErrorToResponse(error);
      return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
    }
  };
}

/**
 * GET /api/trades/settle — list the tenant's closed (done) positions that are
 * not yet settled, with realized P&L and R multiple.
 */
export function createSettleableViewHandler(deps: TradeRouteDependencies) {
  return async function GET(request?: Request): Promise<Response> {
    if (request && request.method !== "GET") {
      return UNTRUSTED_METHOD;
    }
    const actor = await resolveActor(deps);
    if (!actor) {
      return json({ state: "unavailable", message: "Trusted server identity is unavailable." }, 503);
    }
    try {
      const trades = await listSettleablePositions({ userId: actor.userId }, deps.store);
      return json({ state: "settleable", trades }, 200);
    } catch (error) {
      if (error instanceof PaperTradeError) return tradeErrorToResponse(error);
      return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
    }
  };
}

/**
 * POST /api/trades/settle — mark the tenant's closed paper positions settled
 * (append-only; not money movement). Idempotent and cross-tenant isolated.
 */
export function createTradeSettleHandler(deps: TradeRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const actor = await resolveActor(deps);
    if (!actor) {
      return json({ state: "unavailable", message: "Trusted server identity is unavailable." }, 503);
    }
    let bodyText: string;
    try {
      bodyText = await readBoundedBody(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return json({ state: "validation_error", message: "Request body is too large." }, 413);
      }
      return json({ state: "validation_error", message: "Request body could not be read." }, 400);
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      return json({ state: "validation_error", message: "Request body must be valid JSON." }, 400);
    }
    const parsed = settleSchema.safeParse(body);
    if (!parsed.success) {
      return json({ state: "validation_error", message: "Invalid settlement request." }, 400);
    }
    try {
      const result = await settleDoneTrades(parsed.data, { userId: actor.userId }, {
        store: deps.store,
        settledAt: () => new Date().toISOString(),
      });
      return json({ state: "settled", results: result.results }, 200);
    } catch (error) {
      if (error instanceof PaperTradeError) return tradeErrorToResponse(error);
      return json({ state: "unavailable", message: "Paper trade service is unavailable." }, 503);
    }
  };
}