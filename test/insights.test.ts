import assert from "node:assert/strict";
import test from "node:test";

import { PaperTradeError } from "../src/lib/paper-trade";
import { wilson } from "../src/lib/stats";
import {
  buildInsightsView,
  type InsightsStore,
} from "../src/lib/insights";
import { createInsightsHandler, type InsightsRouteDependencies } from "../src/lib/insights-route";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function outcome(index: number, rMultiple: number, strategy = "breakout_retest") {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    tradeId: `50000000-0000-4000-8000-${suffix}`,
    intentId: `60000000-0000-4000-8000-${suffix}`,
    thesisRaw: `Original thesis ${index}`,
    rMultiple,
    asset: "BTC",
    assetClass: "crypto",
    direction: "long" as const,
    strategy: strategy as "breakout_retest" | "reversal",
    regime: "trending" as const,
  };
}

function observation(index: number, code = "EARLY_ENTRY", defied = false, rMultiple = 1) {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    tradeId: `50000000-0000-4000-8000-${suffix}`,
    code,
    shown: true,
    defied,
    rMultiple,
  };
}

interface TenantStoreData {
  outcomes?: unknown[];
  observations?: unknown[];
  patterns?: unknown[];
}

function storeFor(perUser: Record<string, TenantStoreData>): InsightsStore {
  const data: Record<string, { outcomes: unknown[]; observations: unknown[]; patterns: unknown[] }> = {};
  for (const [userId, partial] of Object.entries(perUser)) {
    data[userId] = {
      outcomes: partial.outcomes ?? [],
      observations: partial.observations ?? [],
      patterns: partial.patterns ?? [],
    };
  }
  return {
    async loadClosedOutcomes(userId) {
      return [...(data[userId]?.outcomes ?? [])];
    },
    async loadWarningObservations(userId) {
      return [...(data[userId]?.observations ?? [])];
    },
    async listPatternCandidates(userId) {
      return [...(data[userId]?.patterns ?? [])];
    },
  };
}

function validPatternCandidate(suffixes: string[]) {
  const wins = suffixes.length;
  const interval = wilson(wins, wins);
  return {
    kind: "strategy" as const,
    statement: "This filtered cohort is associated with a higher win rate than the trader baseline.",
    n: wins,
    wins,
    losses: 0,
    rate: 1,
    interval,
    effectSize: 0.5,
    tier: "signal" as const,
    filter: { strategy: "breakout_retest" as const },
    sourceTradeIds: suffixes,
  };
}

test("buildInsightsView derives per-strategy DNA only from that tenant's stored outcomes", async () => {
  const tenantA = Array.from({ length: 10 }, (_, i) => outcome(i + 1, i < 7 ? 1 : -1));
  const tenantB = Array.from({ length: 8 }, (_, i) => outcome(50 + i, 1, "reversal"));

  const store = storeFor({
    [USER]: { outcomes: tenantA },
    [OTHER]: { outcomes: tenantB },
  });

  const view = await buildInsightsView({ userId: USER }, store);
  const strategies = view.dna.map((row) => row.strategy);
  assert.ok(strategies.every((strategy) => strategy === "breakout_retest"));
  assert.equal(strategies.filter((strategy) => (strategy as string) === "reversal").length, 0);
  assert.equal(view.dna[0].n, 10);
});

test("buildInsightsView warning counts sum exactly to the tenant's observation records with no double count", async () => {
  const observations = [
    observation(1, "EARLY_ENTRY", true, -1),
    observation(2, "EARLY_ENTRY", true, 2),
    observation(3, "EARLY_ENTRY", false, 1),
    observation(4, "EARLY_ENTRY", false, -0.5),
    observation(5, "EARLY_ENTRY", false, 0.8),
    observation(6, "OVERSIZED_RISK", true, -1.2),
    observation(7, "OVERSIZED_RISK", true, 0.5),
    observation(8, "OVERSIZED_RISK", false, 1),
    observation(9, "OVERSIZED_RISK", false, -0.2),
  ];
  const store = storeFor({ [USER]: { observations } });

  const view = await buildInsightsView({ userId: USER }, store);
  const early = view.warnings.find((row) => row.code === "EARLY_ENTRY");
  assert.ok(early);
  assert.equal(early.timesShown, 5);
  assert.equal(early.timesHeeded, 3);
  assert.equal(early.timesDefied, 2);
  assert.equal(early.defiedWithLoss, 1);
  assert.equal(early.defiedWithWin, 1);

  const oversized = view.warnings.find((row) => row.code === "OVERSIZED_RISK");
  assert.ok(oversized);
  assert.equal(oversized.timesShown, 4);
  assert.equal(oversized.timesDefied, 2);
  assert.equal(oversized.defiedWithLoss, 1);
  assert.equal(oversized.defiedWithWin, 1);

  const totalShown = view.warnings.reduce((sum, row) => sum + row.timesShown, 0);
  assert.equal(totalShown, 9);
});

test("anecdote strategy cohort exposes episodes and caveat, never a fabricated rate", async () => {
  const store = storeFor({ [USER]: { outcomes: [outcome(1, 1)] } });
  const view = await buildInsightsView({ userId: USER }, store);
  const row = view.dna[0];
  assert.equal(row.tier, "anecdote");
  assert.equal(row.n, 1);
  assert.equal(row.rate, null);
  assert.equal(row.wins, null);
  assert.equal(row.losses, null);
  assert.ok(row.caveat.length > 0);
  assert.ok(row.episodes.length >= 1);
  assert.match(row.caveat, /anecdote/i);
});

test("qualified pattern candidate carries exact source-row lineage", async () => {
  const suffixes = Array.from({ length: 8 }, (_, i) => `50000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`);
  const store = storeFor({
    [USER]: {
      patterns: [validPatternCandidate(suffixes)],
      outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)),
    },
  });
  const view = await buildInsightsView({ userId: USER }, store);
  assert.equal(view.patterns.length, 1);
  assert.equal(view.patterns[0].n, 8);
  assert.equal(view.patterns[0].sourceTradeIds.length, 8);
  assert.equal(view.patterns[0].tier, "signal");
});

test("malformed stored outcomes fail closed with a sanitized persistence error", async () => {
  const store = storeFor({ [USER]: { outcomes: [{ ...outcome(1, 1), rMultiple: Number.POSITIVE_INFINITY }] } });
  await assert.rejects(
    buildInsightsView({ userId: USER }, store),
    (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE" &&
      error.message === "Paper trade persistence is unavailable.",
  );
});

test("a persistence read failure is sanitized, never leaking the raw error", async () => {
  const store: InsightsStore = {
    async loadClosedOutcomes() { throw new Error("secret db password leaked here"); },
    async loadWarningObservations() { return []; },
    async listPatternCandidates() { return []; },
  };
  await assert.rejects(
    buildInsightsView({ userId: USER }, store),
    (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE",
  );
});

test("insights view output is detached and frozen", async () => {
  const store = storeFor({
    [USER]: {
      outcomes: Array.from({ length: 10 }, (_, i) => outcome(i + 1, i < 7 ? 1 : -1)),
      observations: [observation(1), observation(2, "OVERSIZED_RISK")],
    },
  });
  const view = await buildInsightsView({ userId: USER }, store);
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.dna), true);
  assert.equal(Object.isFrozen(view.dna[0]), true);
  assert.equal(Object.isFrozen(view.warnings), true);
  assert.ok(Object.isFrozen(view.warnings[0]));
});

test("missing trusted identity fails closed before any store work on the insights route", async () => {
  const store = storeFor({});
  const deps: InsightsRouteDependencies = {
    resolveActor: async () => null,
    store,
  };
  const handler = createInsightsHandler(deps);
  const response = await handler(new Request("http://localhost/api/insights"));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.state, "unavailable");
  assert.match(body.message, /Trusted server identity/);
});

test("insights route returns real DNA and warning rows for the trusted actor", async () => {
  const store = storeFor({
    [USER]: {
      outcomes: Array.from({ length: 10 }, (_, i) => outcome(i + 1, i < 7 ? 1 : -1)),
      observations: [observation(1, "EARLY_ENTRY", true, -1), observation(2, "OVERSIZED_RISK", false, 1)],
    },
  });
  const deps: InsightsRouteDependencies = {
    resolveActor: async () => ({ userId: USER }),
    store,
  };
  const handler = createInsightsHandler(deps);
  const response = await handler(new Request("http://localhost/api/insights"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.state, "ok");
  assert.equal(body.dna.length, 1);
  assert.ok(body.warnings.length >= 1);
});

test("insights route sanitizes a malformed persistence result into a 503", async () => {
  const store: InsightsStore = {
    async loadClosedOutcomes() { return [{ bogus: true }]; },
    async loadWarningObservations() { return []; },
    async listPatternCandidates() { return []; },
  };
  const deps: InsightsRouteDependencies = {
    resolveActor: async () => ({ userId: USER }),
    store,
  };
  const handler = createInsightsHandler(deps);
  const response = await handler(new Request("http://localhost/api/insights"));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.state, "unavailable");
});