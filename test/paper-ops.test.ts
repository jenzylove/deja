import assert from "node:assert/strict";
import test from "node:test";

import { MemoryPaperStore } from "../src/lib/paper-store-memory";
import {
  createBehaviorListHandler,
  createSettleableViewHandler,
  createTradeCloseHandler,
  createTradeExecuteHandler,
  createTradeMonitorHandler,
  createTradeSettleHandler,
  type TradeRouteDependencies,
} from "../src/lib/trade-route";
import type { BehaviorEvent, PriceFeed } from "../src/lib/paper-ops";

const ACTOR = { userId: "11111111-1111-4111-8111-111111111111" } as const;
const OTHER = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } as const;

const VALID_INTENT = {
  asset: "BTC",
  assetClass: "crypto",
  direction: "long",
  size: 2,
  entry: 100,
  stopLoss: 95,
  takeProfit: 110,
  riskPct: 1,
  confidence: "high",
  thesisRaw: "Resistance broke and the retest held with volume.",
  regime: "trending",
  session: "ny",
  sizeIncreaseAfterLoss: false,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function jsonRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function fakeFeed(prices: Record<string, number>): PriceFeed {
  return {
    async resolve(asset: string) {
      const price = prices[asset];
      if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
        return { available: false };
      }
      return { available: true, price, at: "2026-08-16T12:00:00.000Z" };
    },
  };
}

const unavailableFeed: PriceFeed = {
  async resolve() {
    return { available: false };
  },
};

function depsFor(priceFeed: PriceFeed, actor: { userId: string }): { deps: TradeRouteDependencies; store: MemoryPaperStore } {
  const store = new MemoryPaperStore();
  return {
    store,
    deps: {
      resolveActor: async () => actor,
      store,
      resolveDecision: async (intent, userId) => store.resolveDecisionFromRules(intent, userId),
      priceFeed,
    },
  };
}

async function openTradeFor(deps: TradeRouteDependencies, actor: { userId: string } = ACTOR): Promise<string> {
  const res = await createTradeExecuteHandler(deps)(jsonRequest("http://localhost/api/trades", {
    intent: VALID_INTENT,
    action: "executed",
    warningsDefied: [],
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  void actor;
  return body.trade.id as string;
}

async function closeTradeFor(deps: TradeRouteDependencies, tradeId: string): Promise<void> {
  const res = await createTradeCloseHandler(deps)(jsonRequest("http://localhost/api/trades/close", {
    tradeId,
    exitFill: 95,
  }));
  assert.equal(res.status, 200);
}

test("monitoring auto-closes a long whose stop is hit through the same closure path", async () => {
  const { deps } = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  const tradeId = await openTradeFor(deps);
  const res = await createTradeMonitorHandler(deps)(jsonRequest("http://localhost/api/trades/monitor"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.priceFeed, "available");
  assert.equal(body.closed.length, 1);
  assert.equal(body.closed[0].tradeId, tradeId);
  assert.equal(body.closed[0].exitReason, "stop");
  assert.equal(body.closed[0].exitFill, 95);
  assert.equal(body.closed[0].pnl, -10);
  assert.equal(body.closed[0].rMultiple, -1);
  assert.equal(body.open.length, 0);
});

test("monitor auto-closes a take-profit target through the same closure path", async () => {
  const { deps } = depsFor(fakeFeed({ BTC: 115 }), ACTOR);
  const tradeId = await openTradeFor(deps);
  const res = await createTradeMonitorHandler(deps)(jsonRequest("http://localhost/api/trades/monitor"));
  const body = await res.json();
  assert.equal(body.closed.length, 1);
  assert.equal(body.closed[0].tradeId, tradeId);
  assert.equal(body.closed[0].exitReason, "target");
  assert.equal(body.closed[0].exitFill, 110);
  assert.equal(body.closed[0].pnl, 20);
  assert.equal(body.closed[0].rMultiple, 2);
});

test("monitor never fabricates a fill and leaves trades open when no level is hit", async () => {
  const { deps } = depsFor(fakeFeed({ BTC: 105 }), ACTOR);
  const tradeId = await openTradeFor(deps);
  const res = await createTradeMonitorHandler(deps)(jsonRequest("http://localhost/api/trades/monitor"));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.closed.length, 0);
  assert.equal(body.open.length, 1);
  assert.equal(body.trades[0].tradeId, tradeId);
});

test("price-feed-unavailable monitor fails closed to manual-close-only with zero closure writes", async () => {
  const { deps } = depsFor(unavailableFeed, ACTOR);
  const tradeId = await openTradeFor(deps);
  const res = await createTradeMonitorHandler(deps)(jsonRequest("http://localhost/api/trades/monitor"));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.state, "price_feed_unavailable");
  assert.equal(body.manualCloseOnly.includes(tradeId), true);
});

test("monitor is tenant-scoped and only acts on the actor's open trades", async () => {
  const owner = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  const actorId = await openTradeFor(owner.deps);
  const intruder = createTradeMonitorHandler(depsFor(fakeFeed({ BTC: 90 }), OTHER).deps);
  // Intruder sees no open trades and must not close the owner's trade.
  const res = await intruder(jsonRequest("http://localhost/api/trades/monitor"));
  const body = await res.json();
  assert.equal(body.closed.length, 0);
  assert.equal(body.open.length, 0);
  const ownerList = await (await createSettleableViewHandler(owner.deps)()).json();
  assert.equal(ownerList.trades.some((t: { tradeId: string }) => t.tradeId === actorId), false);
});

test("behavior event listing surfaces only the tenant's real, versioned events", async () => {
  const { deps } = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  const tradeId = await openTradeFor(deps);
  await createTradeMonitorHandler(deps)(jsonRequest("http://localhost/api/trades/monitor"));

  // A different tenant records its own activity in its own store.
  const other = depsFor(fakeFeed({ ETH: 1 }), OTHER);
  const otherId = await openTradeFor(other.deps, OTHER);

  const res = await createBehaviorListHandler(deps)();
  assert.equal(res.status, 200);
  const body = await res.json();
  const events: BehaviorEvent[] = body.events;
  assert.ok(events.length >= 1);
  assert.equal(events.every((event) => event.version === 1), true);
  assert.equal(events.every((event) => event.userId === ACTOR.userId), true);
  assert.equal(events.some((event) => event.type === "execution"), true);
  assert.equal(events.some((event) => event.subjectId === tradeId), true);
  assert.equal(events.some((event) => event.subjectId === otherId), false);
});

test("behavior events expose sanitized outcome/availability/acceptance/verification dimensions", async () => {
  const { deps } = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  await openTradeFor(deps);
  await createTradeMonitorHandler(deps)(jsonRequest("http://localhost/api/trades/monitor"));
  const body = await (await createBehaviorListHandler(deps)()).json();
  const events: BehaviorEvent[] = body.events;
  const ok = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  for (const event of events) {
    assert.equal(typeof event.id, "string");
    assert.match(event.id, UUID);
    assert.equal(typeof event.at, "string");
    assert.ok(ok(event.verification));
    assert.equal(typeof (event.verification as Record<string, unknown>).idempotent, "boolean");
    assert.ok(event.outcome === null || ok(event.outcome));
    assert.ok(event.availability !== undefined);
    assert.ok(event.acceptance !== undefined);
  }
});

test("settlement lists closed trades with realized PnL/R and is idempotent", async () => {
  const { deps, store } = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  const tradeId = await openTradeFor(deps);
  await closeTradeFor(deps, tradeId);

  const list = await (await createSettleableViewHandler(deps)()).json();
  assert.equal(list.state, "settleable");
  const row = list.trades.find((t: { tradeId: string }) => t.tradeId === tradeId);
  assert.ok(row);
  assert.equal(row.pnl, -10);
  assert.equal(row.rMultiple, -1);
  assert.equal(row.exitReason, "manual");

  const settle = createTradeSettleHandler(deps);
  const first = await (await settle(jsonRequest("http://localhost/api/trades/settle", { tradeIds: [tradeId] }))).json();
  assert.equal(first.state, "settled");
  assert.equal(first.results[0].outcome, "settled");
  const second = await (await settle(jsonRequest("http://localhost/api/trades/settle", { tradeIds: [tradeId] }))).json();
  assert.equal(second.results[0].outcome, "already_settled");
  assert.equal((await store.listSettleableTrades(ACTOR.userId)).length, 0);
});

test("a settled trade no longer appears in the settleable list", async () => {
  const { deps } = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  const tradeId = await openTradeFor(deps);
  await closeTradeFor(deps, tradeId);
  const settle = createTradeSettleHandler(deps);
  await settle(jsonRequest("http://localhost/api/trades/settle", { tradeIds: [tradeId] }));
  const list = await (await createSettleableViewHandler(deps)()).json();
  assert.equal(list.trades.some((t: { tradeId: string }) => t.tradeId === tradeId), false);
});

test("settlement fails closed for a trade owned by another tenant", async () => {
  const ownerDeps = depsFor(fakeFeed({ BTC: 90 }), ACTOR).deps;
  const tradeId = await openTradeFor(ownerDeps);
  await closeTradeFor(ownerDeps, tradeId);
  const other = createTradeSettleHandler(depsFor(fakeFeed({ BTC: 90 }), OTHER).deps);
  const res = await other(jsonRequest("http://localhost/api/trades/settle", { tradeIds: [tradeId] }));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.state, "not_found");
});

test("settlement rejects malformed and non-UUID trade ids before writes", async () => {
  const { deps, store } = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  await openTradeFor(deps);
  const closeRes = await createTradeSettleHandler(deps)(jsonRequest("http://localhost/api/trades/settle", { tradeIds: ["not-a-uuid"] }));
  assert.equal(closeRes.status, 400);
  assert.equal((await closeRes.json()).state, "validation_error");
  assert.equal((await store.listSettleableTrades(ACTOR.userId)).length, 0);
});

test("settlement rejects an open (not closed) trade before writes", async () => {
  const { deps, store } = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  const tradeId = await openTradeFor(deps); // still open
  const res = await createTradeSettleHandler(deps)(jsonRequest("http://localhost/api/trades/settle", { tradeIds: [tradeId] }));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).state, "not_found");
  assert.equal((await store.listSettleableTrades(ACTOR.userId)).length, 0);
});

test("monitor rejects a malformed price feed adapter output as sanitized unavailable without invoking traps", async () => {
  let reads = 0;
  const badFeed: PriceFeed = {
    async resolve() {
      const value: Record<string, unknown> = { available: true };
      Object.defineProperty(value, "price", { enumerable: true, get() { reads++; return 100; } });
      return value as { available: true; price: number; at: string };
    },
  };
  const { deps } = depsFor(badFeed, ACTOR);
  await openTradeFor(deps);
  const res = await createTradeMonitorHandler(deps)(jsonRequest("http://localhost/api/trades/monitor"));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).state, "price_feed_unavailable");
  assert.equal(reads, 0);
});

test("persistence failure while settling is sanitized to unavailable", async () => {
  const { deps, store } = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  const tradeId = await openTradeFor(deps);
  await closeTradeFor(deps, tradeId);
  store.markSettled = async () => {
    throw new Error("password=secret db.internal");
  };
  const res = await createTradeSettleHandler(deps)(jsonRequest("http://localhost/api/trades/settle", { tradeIds: [tradeId] }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.state, "unavailable");
  assert.equal(JSON.stringify(body).includes("password"), false);
});

test("monitoring events are append-only and never mutated after listing", async () => {
  const { deps } = depsFor(fakeFeed({ BTC: 90 }), ACTOR);
  await openTradeFor(deps);
  await createTradeMonitorHandler(deps)(jsonRequest("http://localhost/api/trades/monitor"));
  const first = (await (await createBehaviorListHandler(deps)()).json()).events;
  await createTradeMonitorHandler(deps)(jsonRequest("http://localhost/api/trades/monitor"));
  const second = (await (await createBehaviorListHandler(deps)()).json()).events;
  assert.ok(second.length >= first.length);
  // Listed events are detached copies; mutating a copy must not mutate the store.
  if (second[0]) (second[0] as { acceptance: string }).acceptance = "mutated";
  const third = (await (await createBehaviorListHandler(deps)()).json()).events;
  assert.equal(third.some((event: BehaviorEvent) => (event.acceptance as string) === "mutated"), false);
});