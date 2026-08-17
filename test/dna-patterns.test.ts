import assert from "node:assert/strict";
import test from "node:test";

import { deriveDnaPatterns } from "../src/lib/dna-patterns";
import { toHistoryOutcome, sandboxDemoHistory } from "../src/lib/imported-trade";
import type { HistoryOutcome } from "../src/lib/deja-check";

test("demo history yields a negative BTC-long pattern with correct counts", () => {
  const patterns = deriveDnaPatterns(sandboxDemoHistory().map(toHistoryOutcome));
  const btc = patterns.find((p) => p.id === "pair-neg-btc-long");
  assert.ok(btc, "expected a negative BTC long pattern");
  assert.equal(btc.kind, "negative");
  assert.equal(btc.n, 6);
  assert.match(btc.detail, /4 of 6 BTC long/);
});

test("a profitable cohort yields a positive pattern, not just warnings", () => {
  const wins: HistoryOutcome[] = [1, 2, 3, 4, 5].map((i: number) => ({
    tradeId: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
    asset: "ETH", direction: "long", size: 1, rMultiple: 1.4,
    openedAt: new Date(1_700_000_000_000 - i * 60_000).toISOString(),
  }));
  const patterns = deriveDnaPatterns(wins);
  const positive = patterns.find((p) => p.kind === "positive");
  assert.ok(positive, "expected a positive pattern");
  assert.equal(positive.n, 5);
});

test("anecdote cohort (n<3) produces no directional conclusion", () => {
  const sparse = [
    { tradeId: "00000000-0000-4000-8000-000000000001", asset: "BTC", direction: "long", size: 1, rMultiple: -1 },
  ];
  const patterns = deriveDnaPatterns(sparse as any);
  assert.ok(patterns.every((p) => p.n >= 3) || patterns.length === 0);
  assert.ok(!patterns.some((p) => p.id.startsWith("pair-")), "no single-trade conclusion");
});