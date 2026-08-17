import assert from "node:assert/strict";
import test from "node:test";

import { BaseError, coreDejaCheck, similarityScore, type HistoryOutcome, type ProposedTrade } from "../src/lib/deja-check";

const UUID = /^[0-9a-f-]{36}$/i;
let n = 0;
function outcome(p: { asset: string; direction: "long" | "short"; r: number; size?: number; openedAt?: string | null }): HistoryOutcome {
  n += 1;
  return {
    tradeId: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`,
    asset: p.asset,
    direction: p.direction,
    size: p.size ?? 1,
    rMultiple: p.r,
    openedAt: p.openedAt ?? null,
  };
}

test("empty history and no matches resolve to a clear check (no pattern)", async () => {
  const source = { loadClosedOutcomes: async () => [] as HistoryOutcome[] };
  const proposed: ProposedTrade = { asset: "ETH", direction: "long", entry: 3000, size: 1, riskPct: 1, thesis: "uptrend" };
  const res = await coreDejaCheck(source, proposed, "11111111-1111-4111-8111-111111111111");
  assert.equal(res.decision, "clear");
  assert.equal(res.pattern, null);
  assert.equal(res.similarTrades.length, 0);
});

test("Déjà vu detected when a majority of similar trades lost (6 BTC longs, 4 losses)", async () => {
  const losses = [1, 2, 3, 4].map(() => outcome({ asset: "BTC", direction: "long", r: -1 }));
  const wins = [5, 6].map(() => outcome({ asset: "BTC", direction: "long", r: 1.8 }));
  const source = { loadClosedOutcomes: async () => [...losses, ...wins] as HistoryOutcome[] };
  const proposed: ProposedTrade = { asset: "BTC", direction: "long", entry: 64000, size: 1, riskPct: 1, thesis: "BTC bounced from support" };
  const res = await coreDejaCheck(source, proposed, "11111111-1111-4111-8111-111111111111");
  assert.equal(res.decision, "deja_vu");
  assert.ok(res.pattern);
  assert.equal(res.similarTrades.length, 6);
  assert.equal(res.similarTrades.filter((s) => s.outcome === "loss").length, 4);
  assert.ok(res.pattern.actions.includes("reduce_position"));
  assert.deepEqual([...res.pattern.actions].sort(), ["cancel", "proceed_anyway", "reduce_position"]);
});

test("opposite direction or unrelated asset does not trigger a pattern", async () => {
  const source = {
    loadClosedOutcomes: async () => [
      outcome({ asset: "BTC", direction: "short", r: -1 }),
      outcome({ asset: "ETH", direction: "long", r: -1 }),
      outcome({ asset: "BTC", direction: "long", r: 1 }),
    ] as HistoryOutcome[],
  };
  const res = await coreDejaCheck(source, { asset: "BTC", direction: "long", entry: 64000, size: 1, riskPct: 1, thesis: "x" }, "11111111-1111-4111-8111-111111111111");
  // only 1 similar (same asset+direction), below the 3 minimum -> no pattern
  assert.equal(res.decision, "clear");
  assert.equal(res.similarTrades.length, 1);
});

test("malformed proposed trade fails closed", async () => {
  const source = { loadClosedOutcomes: async () => [] as HistoryOutcome[] };
  await assert.rejects(
    coreDejaCheck(source, { asset: "", direction: "long", entry: -5, size: 0, riskPct: 1, thesis: "x" } as unknown as ProposedTrade, "11111111-1111-4111-8111-111111111111"),
    (e) => e instanceof BaseError,
  );
});

test("similarity score rewards same asset, same direction and matching size", () => {
  const a = { asset: "BTC", direction: "long", entry: 100, size: 2, riskPct: 1 } as ProposedTrade;
  const close = similarityScore(a, { tradeId: "00000000-0000-4000-8000-0000000000aa", asset: "BTC", direction: "long", size: 2.1, rMultiple: 1 });
  const far = similarityScore(a, { tradeId: "00000000-0000-4000-8000-0000000000bb", asset: "ETH", direction: "short", size: 20, rMultiple: 1 });
  assert.ok(close > far, "close should score higher than far");
  assert.ok(UUID.test("00000000-0000-4000-8000-000000000001"));
});