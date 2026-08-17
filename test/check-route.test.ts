import assert from "node:assert/strict";
import test from "node:test";

import { createCheckHandler } from "../src/lib/check-route";
import { sandboxDemoHistory } from "../src/lib/imported-trade";
import type { CockroachPaperStore } from "../src/lib/paper-store";

const ACTOR = "11111111-1111-4111-8111-111111111111";

function fakeStore(): CockroachPaperStore {
  return {
    listImportedTrades: async () => sandboxDemoHistory(),
    loadClosedOutcomes: async () => [],
  } as unknown as CockroachPaperStore;
}

function post(body: unknown) {
  return new Request("http://local/api/check", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

test("missing actor fails closed to 503", async () => {
  const handler = createCheckHandler({ resolveActor: async () => null, store: fakeStore() });
  const res = await handler(post({ asset: "BTC", direction: "long", entry: 100, size: 1, riskPct: 1, thesis: "x" }));
  assert.equal(res.status, 503);
});

test("a BTC long against losing demo history returns Déjà vu", async () => {
  const handler = createCheckHandler({ resolveActor: async () => ({ userId: ACTOR }), store: fakeStore() });
  const res = await handler(post({ asset: "BTC", direction: "long", entry: 100, size: 1, riskPct: 1, thesis: "BTC bounced from support" }));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { decision: string; pattern: { title: string } | null; similarTrades: unknown[] };
  assert.equal(body.decision, "deja_vu");
  assert.equal(body.pattern?.title, "Déjà vu detected");
  assert.equal(body.similarTrades.length, 6);
});

test("invalid body fails closed to 400", async () => {
  const handler = createCheckHandler({ resolveActor: async () => ({ userId: ACTOR }), store: fakeStore() });
  const res = await handler(post({ asset: "", direction: "long", entry: -1, size: 0 }));
  assert.equal(res.status, 400);
});