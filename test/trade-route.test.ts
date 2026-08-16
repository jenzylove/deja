import assert from "node:assert/strict";
import test from "node:test";

import {
  createTradeCloseHandler,
  createTradeExecuteHandler,
  createTradeListHandler,
  type TradeRouteDependencies,
} from "../src/lib/trade-route";
import {
  MemoryPaperStore,
  type SeededRule,
} from "../src/lib/paper-store-memory";

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

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function depsFor(
  rules: SeededRule[] = [],
  resolveActor: () => Promise<{ userId: string } | null> = async () => ACTOR,
): { deps: TradeRouteDependencies; store: MemoryPaperStore } {
  const store = new MemoryPaperStore();
  store.upsertRules(ACTOR.userId, rules);
  store.upsertRules(OTHER.userId, []);
  return {
    store,
    deps: {
      resolveActor,
      store,
      resolveDecision: async (intent, userId) =>
        store.resolveDecisionFromRules(intent, userId),
    },
  };
}

test("missing trusted identity fails closed before any route or store work", async () => {
  const { deps, store } = depsFor([], async () => null);
  const handler = createTradeExecuteHandler(deps);
  const response = await handler(jsonRequest("http://localhost/api/trades", {
    intent: VALID_INTENT,
    action: "executed",
    warningsDefied: [],
  }));
  assert.equal(response.status, 503);
  assert.equal(await store.openTradeCount(ACTOR.userId), 0);
});

test("PASS executes atomically and returns the real open trade state", async () => {
  const { deps, store } = depsFor();
  const handler = createTradeExecuteHandler(deps);
  const response = await handler(jsonRequest("http://localhost/api/trades", {
    intent: VALID_INTENT,
    action: "executed",
    warningsDefied: [],
  }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.state, "executed");
  assert.equal(payload.decision, "PASS");
  assert.equal(payload.replayed, false);
  assert.match(payload.decisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.match(payload.trade.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(payload.trade.asset, "BTC");
  assert.equal(payload.trade.direction, "long");
  assert.equal(payload.trade.size, 2);
  assert.equal(payload.trade.entry, 100);
  assert.equal(payload.trade.stop, 95);
  assert.match(payload.trade.openedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  assert.equal(await store.openTradeCount(ACTOR.userId), 1);
});

test("BLOCK forbids execution with zero store writes", async () => {
  const rules: SeededRule[] = [{
    id: "risk-block",
    predicate: { field: "risk_pct", op: "lte", value: 1 },
    enforcement: "block",
  }];
  const store = new MemoryPaperStore();
  store.upsertRules(ACTOR.userId, rules);
  const deps = {
    resolveActor: async () => ACTOR,
    store,
    resolveDecision: async (intent: unknown, userId: string) =>
      store.resolveDecisionFromRules(intent, userId),
  };
  const handler = createTradeExecuteHandler(deps);
  let openAtomicCalls = 0;
  const original = store.openAtomic.bind(store);
  store.openAtomic = async (input) => {
    openAtomicCalls++;
    return original(input);
  };
  const response = await handler(jsonRequest("http://localhost/api/trades", {
    intent: { ...VALID_INTENT, riskPct: 3 },
    action: "executed",
    warningsDefied: [],
  }));
  assert.equal(response.status, 409);
  const payload = await response.json();
  assert.equal(payload.state, "blocked");
  assert.equal(payload.decision, "BLOCK");
  assert.equal(openAtomicCalls, 0);
  assert.equal(await store.openTradeCount(ACTOR.userId), 0);
});

test("WARN requires explicit defiance to execute unchanged", async () => {
  const rules: SeededRule[] = [{
    id: "stop-warn",
    predicate: { field: "has_stop_loss", op: "eq", value: true },
    enforcement: "warn",
  }];
  const store = new MemoryPaperStore();
  store.upsertRules(ACTOR.userId, rules);
  const deps = {
    resolveActor: async () => ACTOR,
    store,
    resolveDecision: async (intent: unknown, userId: string) =>
      store.resolveDecisionFromRules(intent, userId),
  };
  const handler = createTradeExecuteHandler(deps);
  // Unchanged execution with no defiance must be rejected.
  const forbiddenIntent = { ...VALID_INTENT, stopLoss: null };
  const rejected = await handler(jsonRequest("http://localhost/api/trades", {
    intent: forbiddenIntent,
    action: "executed",
    warningsDefied: [],
  }));
  assert.equal(rejected.status, 400);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.state, "validation_error");

  // Defying the shown warning permits unchanged execution.
  const accepted = await handler(jsonRequest("http://localhost/api/trades", {
    intent: forbiddenIntent,
    action: "executed",
    warningsDefied: ["NO_STOP_LOSS"],
  }));
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.decision, "WARN");
  assert.equal(await store.openTradeCount(ACTOR.userId), 1);
});

test("close records outcome and refreshes derived memory with lineage", async () => {
  const { deps } = depsFor();
  const executeHandler = createTradeExecuteHandler(deps);
  const executeRes = await executeHandler(jsonRequest("http://localhost/api/trades", {
    intent: VALID_INTENT,
    action: "executed",
    warningsDefied: [],
  }));
  const executed = await executeRes.json();
  const tradeId = executed.trade.id as string;

  const closeHandler = createTradeCloseHandler(deps);
  const closeRes = await closeHandler(jsonRequest("http://localhost/api/trades/close", {
    tradeId,
    exitFill: 110,
  }));
  assert.equal(closeRes.status, 200);
  const closed = await closeRes.json();
  assert.equal(closed.state, "closed");
  assert.equal(closed.outcome.exitFill, 110);
  assert.equal(closed.outcome.exitReason, "manual");
  assert.equal(closed.outcome.pnl, 20);
  assert.equal(closed.outcome.rMultiple, 2);
  assert.equal(closed.outcome.win, true);
  assert.equal(closed.outcome.tradeId, tradeId);
  assert.ok(closed.memory.evidence);
  assert.equal(closed.memory.evidence.tier, "anecdote");
  assert.equal(closed.memory.evidence.n, 1);

  // The closed trade must be gone from the open list and folded into memory.
  const listHandler = createTradeListHandler(deps);
  const listRes = await listHandler();
  const listed = await listRes.json();
  assert.deepEqual(listed.trades, []);
});

test("duplicate execute replays idempotently instead of creating a second trade", async () => {
  const { deps, store } = depsFor();
  const handler = createTradeExecuteHandler(deps);
  const body = {
    intent: VALID_INTENT,
    action: "executed",
    warningsDefied: [],
  };
  const first = await (await handler(jsonRequest("http://localhost/api/trades", body))).json();
  const second = await (await handler(jsonRequest("http://localhost/api/trades", body))).json();
  assert.equal(second.replayed, true);
  assert.equal(second.trade.id, first.trade.id);
  assert.equal(await store.openTradeCount(ACTOR.userId), 1);
});

test("duplicate close is rejected as already closed without overwriting outcome", async () => {
  const { deps } = depsFor();
  const executeHandler = createTradeExecuteHandler(deps);
  const executed = await (await executeHandler(jsonRequest("http://localhost/api/trades", {
    intent: VALID_INTENT,
    action: "executed",
    warningsDefied: [],
  }))).json();
  const tradeId = executed.trade.id as string;

  const closeHandler = createTradeCloseHandler(deps);
  const first = await closeHandler(jsonRequest("http://localhost/api/trades/close", { tradeId, exitFill: 110 }));
  assert.equal(first.status, 200);
  const second = await closeHandler(jsonRequest("http://localhost/api/trades/close", { tradeId, exitFill: 111 }));
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.state, "already_closed");
});

test("malformed close fill is rejected as a validation error", async () => {
  const { deps } = depsFor();
  const closeHandler = createTradeCloseHandler(deps);
  for (const badFill of [0, -5, Number.NaN]) {
    const res = await closeHandler(jsonRequest("http://localhost/api/trades/close", {
      tradeId: "44444444-4444-4444-8444-444444444444",
      exitFill: badFill,
    }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.state, "validation_error");
  }
});

test("a trade cannot be closed by another tenant", async () => {
  const actor = { userId: ACTOR.userId };
  const other = { userId: OTHER.userId };

  const ownerStore = new MemoryPaperStore();
  ownerStore.upsertRules(ACTOR.userId, []);
  const executeHandler = createTradeExecuteHandler({
    resolveActor: async () => actor,
    store: ownerStore,
    resolveDecision: async (intent, userId) => ownerStore.resolveDecisionFromRules(intent, userId),
  });
  const executed = await (await executeHandler(jsonRequest("http://localhost/api/trades", {
    intent: VALID_INTENT,
    action: "executed",
    warningsDefied: [],
  }))).json();
  const tradeId = executed.trade.id as string;

  const otherStore = new MemoryPaperStore();
  otherStore.upsertRules(OTHER.userId, []);
  const closeHandler = createTradeCloseHandler({
    resolveActor: async () => other,
    store: otherStore,
    resolveDecision: async (intent, userId) => otherStore.resolveDecisionFromRules(intent, userId),
  });
  const res = await closeHandler(jsonRequest("http://localhost/api/trades/close", { tradeId, exitFill: 110 }));
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.state, "not_found");
});

test("persistence write failure is sanitized to an unavailableresponse", async () => {
  const store = new MemoryPaperStore();
  store.upsertRules(ACTOR.userId, []);
  store.openAtomic = async () => {
    throw new Error("password=secret db.internal");
  };
  const deps = {
    resolveActor: async () => ACTOR,
    store,
    resolveDecision: async (intent: unknown, userId: string) =>
      store.resolveDecisionFromRules(intent, userId),
  };
  const handler = createTradeExecuteHandler(deps);
  const res = await handler(jsonRequest("http://localhost/api/trades", {
    intent: VALID_INTENT,
    action: "executed",
    warningsDefied: [],
  }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.state, "unavailable");
  assert.equal(JSON.stringify(body).includes("password"), false);
});

test("browser cannot supply a trusted decision or tenant override", async () => {
  const { deps, store } = depsFor();
  const handler = createTradeExecuteHandler(deps);
  const res = await handler(jsonRequest("http://localhost/api/trades", {
    intent: { ...VALID_INTENT, decision: "PASS" },
    action: "executed",
    warningsDefied: [],
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.state, "validation_error");
  assert.equal(await store.openTradeCount(ACTOR.userId), 0);
});