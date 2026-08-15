import assert from "node:assert/strict";
import test from "node:test";

import {
  IntentValidationError,
  loadActiveRulesForUser,
  processTradeIntent,
  type IntentServiceDependencies,
} from "../src/lib/intent-service";
import { summarize } from "../src/lib/stats";
import { buildAnnSearchSql, retrieveSqlFallback } from "../src/lib/retrieval";

// Every adapter and history row in this file is a deterministic test fixture.
// Nothing returned here is live CockroachDB, Bedrock, or provider evidence.
const TEST_FIXTURE_NOTICE = "deterministic test fixture; not live provider evidence";
const authenticatedTenant = {
  userId: "11111111-1111-4111-8111-111111111111",
} as const;

function fixtureDependencies(): IntentServiceDependencies {
  return {
    canonicalize: async () => ({
      strategy: "breakout_retest",
      signals: ["retest holding"],
      marketThesis: "continuation",
      confirmationStated: true,
      canonical: "breakout retest; retest holding; expecting continuation",
      embedding: [0.1],
    }),
    retrieve: async () => ({
      trades: [
        {
          intentId: "intent-history-1",
          tradeId: "trade-history-1",
          asset: "BTC",
          direction: "long",
          strategy: "breakout_retest",
          session: "ny",
          regime: "trending",
          riskPct: 1,
          confidence: "high",
          thesisRaw: "Range high held on the retest.",
          openedAt: new Date("2026-08-01T12:00:00.000Z"),
          closedAt: new Date("2026-08-01T18:00:00.000Z"),
          rMultiple: -1,
          win: false,
          cosine: 0.91,
          score: 0.88,
          ageDays: 14,
        },
      ],
      cohort: summarize([{ win: false, r: -1 }]),
      behaviour: {
        minutesSinceLastLoss: 5,
        tradesToday: 1,
        lossStreak: 1,
        openPositions: 0,
        stopWidenedLast30d: 0,
      },
      filterUsed: "same direction, asset and strategy",
      widened: false,
      candidates: 1,
      latencyMs: 3,
    }),
    fallbackRetrieve: async (query) =>
      fixtureDependencies().retrieve({
        ...query,
        canonicalThesis: "deterministic fallback fixture",
        strategy: null,
      }),
    loadActiveRules: async () => [
      {
        id: "tenant-risk-rule",
        predicate: { field: "risk_pct", op: "lte", value: 2 },
        enforcement: "block",
      },
    ],
  };
}

const validIntent = {
  asset: "BTC",
  assetClass: "crypto",
  direction: "long",
  size: 0.1,
  entry: 60_000,
  stopLoss: 58_000,
  takeProfit: 64_000,
  riskPct: 3,
  confidence: "high",
  thesisRaw: "Resistance broke and the retest held with volume.",
  regime: "trending",
  session: "ny",
  sizeIncreaseAfterLoss: false,
} as const;

test("payload tenant selection is rejected and cannot override authenticated context", async () => {
  let calls = 0;
  const dependencies = fixtureDependencies();
  dependencies.loadActiveRules = async () => {
    calls++;
    return [];
  };

  await assert.rejects(
    processTradeIntent(
      { ...validIntent, userId: "22222222-2222-4222-8222-222222222222" },
      authenticatedTenant,
      dependencies,
    ),
    (error) =>
      error instanceof IntentValidationError && error.issues.includes("unknown field: userId"),
  );
  assert.equal(calls, 0);
});

test("tracer bullet evaluates tenant rules and returns anecdote-safe grounded evidence", async () => {
  const result = await processTradeIntent(validIntent, authenticatedTenant, fixtureDependencies());

  assert.equal(TEST_FIXTURE_NOTICE.includes("not live provider evidence"), true);
  assert.equal(result.state, "complete");
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.canonicalThesis?.strategy, "breakout_retest");
  assert.equal(result.retrieval?.evidenceTier, "anecdote");
  assert.equal(result.retrieval?.filter.widened, false);
  assert.equal(result.behaviour?.minutesSinceLastLoss, 5);
  assert.deepEqual(result.rules.evidence, [
    {
      ruleId: "tenant-risk-rule",
      field: "risk_pct",
      expected: 2,
      actual: 3,
      operator: "lte",
      enforcement: "block",
      passed: false,
    },
  ]);
  assert.equal(result.retrieval?.cohort.n, 1);
  assert.equal("percentage" in (result.retrieval?.cohort ?? {}), false);
  assert.equal(result.retrieval?.episodes[0].thesisRaw, "Range high held on the retest.");
});

test("validation rejects unknown intent fields before any adapter call", async () => {
  let calls = 0;
  const dependencies: IntentServiceDependencies = {
    canonicalize: async () => {
      calls++;
      throw new Error("must not run");
    },
    retrieve: async () => {
      calls++;
      throw new Error("must not run");
    },
    fallbackRetrieve: async () => {
      calls++;
      throw new Error("must not run");
    },
    loadActiveRules: async () => {
      calls++;
      throw new Error("must not run");
    },
  };

  await assert.rejects(
    processTradeIntent(
      { ...validIntent, executionVenue: "live-exchange" },
      authenticatedTenant,
      dependencies,
    ),
    (error) =>
      error instanceof IntentValidationError &&
      error.issues.includes("unknown field: executionVenue"),
  );
  assert.equal(calls, 0);
});

test("canonicalization failure uses SQL fallback evidence without vector retrieval", async () => {
  let vectorRetrievalCalls = 0;
  let fallbackCalls = 0;
  const dependencies = fixtureDependencies();
  dependencies.canonicalize = async () => {
    throw new Error("Bedrock unavailable token=super-secret");
  };
  dependencies.retrieve = async () => {
    vectorRetrievalCalls++;
    throw new Error("must not retrieve without a canonical thesis");
  };
  dependencies.fallbackRetrieve = async (query) => {
    fallbackCalls++;
    assert.equal(query.userId, authenticatedTenant.userId);
    return fixtureDependencies().fallbackRetrieve(query);
  };

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);

  assert.equal(result.state, "degraded");
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.canonicalThesis, null);
  assert.equal(result.retrieval?.episodes[0].thesisRaw, "Range high held on the retest.");
  assert.equal(result.behaviour?.minutesSinceLastLoss, 5);
  assert.equal(result.rules.evidence[0].ruleId, "tenant-risk-rule");
  assert.equal(result.rules.evidence[0].passed, false);
  assert.deepEqual(result.errors, [
    { stage: "canonicalization", message: "Trade thesis canonicalization is unavailable." },
  ]);
  assert.equal(fallbackCalls, 1);
  assert.equal(vectorRetrievalCalls, 0);
});

test("anecdote output exposes only the three most similar raw episodes", async () => {
  const dependencies = fixtureDependencies();
  const baseRetrieve = dependencies.retrieve;
  dependencies.retrieve = async (query) => {
    const result = await baseRetrieve(query);
    const episode = result.trades[0];
    return {
      ...result,
      trades: [0, 1, 2, 3].map((index) => ({
        ...episode,
        intentId: `intent-history-${index}`,
        tradeId: `trade-history-${index}`,
        thesisRaw: `Raw fixture thesis ${index}`,
        score: episode.score - index * 0.01,
      })),
    };
  };

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);

  assert.equal(result.retrieval?.evidenceTier, "anecdote");
  assert.equal(result.retrieval?.episodes.length, 3);
  assert.deepEqual(
    result.retrieval?.episodes.map((episode) => episode.thesisRaw),
    ["Raw fixture thesis 0", "Raw fixture thesis 1", "Raw fixture thesis 2"],
  );
});

test("production rule loader uses the tenant ID and active deterministic query", async () => {
  let capturedSql = "";
  let capturedValues: readonly unknown[] = [];
  const deterministicDatabaseFixture = {
    async query(sql: string, values: readonly unknown[]) {
      capturedSql = sql;
      capturedValues = values;
      return {
        rows: [
          {
            id: "rule-1",
            predicate: { field: "risk_pct", op: "lte", value: 2 },
            enforcement: "block",
          },
        ],
      };
    },
  };

  const rows = await loadActiveRulesForUser(authenticatedTenant.userId, deterministicDatabaseFixture);

  assert.equal(rows[0].id, "rule-1");
  assert.deepEqual(capturedValues, [authenticatedTenant.userId]);
  assert.match(capturedSql, /WHERE user_id = \$1/);
  assert.match(capturedSql, /active = true/);
  assert.match(capturedSql, /retired_at IS NULL/);
  assert.match(capturedSql, /ORDER BY created_at ASC, id ASC/);
});

test("validation rejects a non-UUID authenticated tenant identifier before adapters run", async () => {
  let calls = 0;
  const dependencies = fixtureDependencies();
  dependencies.loadActiveRules = async () => {
    calls++;
    return [];
  };
  dependencies.canonicalize = async () => {
    calls++;
    throw new Error("must not run");
  };

  await assert.rejects(
    processTradeIntent(validIntent, { userId: "tenant-name" }, dependencies),
    (error) =>
      error instanceof IntentValidationError &&
      error.issues.includes("userId must be a UUID"),
  );
  assert.equal(calls, 0);
});

test("retrieval failure preserves deterministic rule enforcement", async () => {
  const dependencies = fixtureDependencies();
  dependencies.retrieve = async () => {
    throw new Error("CockroachDB retrieval unavailable");
  };

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);

  assert.equal(result.state, "degraded");
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.canonicalThesis?.strategy, "breakout_retest");
  assert.equal(result.retrieval, null);
  assert.equal(result.rules.evidence[0].passed, false);
  assert.deepEqual(result.errors, [
    { stage: "retrieval", message: "Trade memory retrieval is unavailable." },
  ]);
});

test("retrieval failure without active rules still blocks instead of permitting execution", async () => {
  const dependencies = fixtureDependencies();
  dependencies.loadActiveRules = async () => [];
  dependencies.retrieve = async () => {
    throw new Error("database host and password must remain private");
  };

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);

  assert.equal(result.state, "degraded");
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.retrieval, null);
  assert.deepEqual(result.errors, [
    { stage: "retrieval", message: "Trade memory retrieval is unavailable." },
  ]);
});

test("unavailable tenant rules fail closed before canonicalization or retrieval", async () => {
  let canonicalizationCalls = 0;
  let retrievalCalls = 0;
  const dependencies = fixtureDependencies();
  dependencies.loadActiveRules = async () => {
    throw new Error("rules query unavailable");
  };
  dependencies.canonicalize = async () => {
    canonicalizationCalls++;
    throw new Error("must not run");
  };
  dependencies.retrieve = async () => {
    retrievalCalls++;
    throw new Error("must not run");
  };

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);

  assert.equal(result.state, "error");
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.retrieval, null);
  assert.deepEqual(result.rules.evidence, []);
  assert.deepEqual(result.errors, [
    { stage: "rules", message: "Safety rules are unavailable." },
  ]);
  assert.equal(canonicalizationCalls, 0);
  assert.equal(retrievalCalls, 0);
});

test("intent and retrieved behaviour populate every supported rule field", async () => {
  const dependencies = fixtureDependencies();
  dependencies.loadActiveRules = async () => [
    { id: "risk", predicate: { field: "risk_pct", op: "eq", value: 3 }, enforcement: "block" },
    { id: "cooldown", predicate: { field: "minutes_since_last_loss", op: "eq", value: 5 }, enforcement: "block" },
    { id: "daily", predicate: { field: "trades_today", op: "eq", value: 1 }, enforcement: "block" },
    { id: "stop", predicate: { field: "has_stop_loss", op: "eq", value: true }, enforcement: "block" },
    { id: "size", predicate: { field: "size_increase_after_loss", op: "eq", value: false }, enforcement: "warn" },
  ];

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);

  assert.equal(result.decision, "PASS");
  assert.deepEqual(
    result.rules.evidence.map(({ ruleId, actual, passed }) => ({ ruleId, actual, passed })),
    [
      { ruleId: "risk", actual: 3, passed: true },
      { ruleId: "cooldown", actual: 5, passed: true },
      { ruleId: "daily", actual: 1, passed: true },
      { ruleId: "stop", actual: true, passed: true },
      { ruleId: "size", actual: false, passed: true },
    ],
  );
});

test("signal-tier cohort includes its rate and interval", async () => {
  const dependencies = fixtureDependencies();
  const baseRetrieve = dependencies.retrieve;
  dependencies.retrieve = async (query) => ({
    ...(await baseRetrieve(query)),
    cohort: summarize([
      { win: true }, { win: true }, { win: true }, { win: true },
      { win: false }, { win: false }, { win: false }, { win: false },
    ]),
  });

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);
  const cohort = result.retrieval?.cohort;

  assert.equal(cohort?.tier, "signal");
  assert.equal(cohort && "percentage" in cohort ? cohort.percentage : null, 0.5);
  assert.equal(cohort && "interval" in cohort, true);
});

test("adapter tier cannot expose statistics below eight validated outcomes", async () => {
  const dependencies = fixtureDependencies();
  const baseRetrieve = dependencies.retrieve;
  dependencies.retrieve = async (query) => ({
    ...(await baseRetrieve(query)),
    cohort: {
      n: 1,
      wins: 1,
      losses: 0,
      rate: 1,
      interval: { low: 0.99, high: 1 },
      tier: "signal",
      avgR: 99,
    },
  });

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);
  const cohort = result.retrieval?.cohort;

  assert.equal(result.retrieval?.evidenceTier, "anecdote");
  assert.equal(cohort?.tier, "anecdote");
  assert.equal(cohort && "percentage" in cohort, false);
  assert.equal(cohort && "interval" in cohort, false);
});

test("SQL fallback is tenant-scoped and contains no embedding or vector operation", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const database = {
    async query<T>(sql: string, values: unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, values });
      let rows: unknown[];
      if (sql.includes("JOIN trade_intents")) {
        rows = [
          {
            intent_id: "intent-1",
            trade_id: "trade-1",
            asset: "BTC",
            direction: "long",
            strategy: "breakout_retest",
            session: "ny",
            regime: "trending",
            risk_pct: "1",
            confidence: "high",
            thesis_raw: "Raw tenant-scoped episode",
            opened_at: "2026-08-01T12:00:00.000Z",
            closed_at: "2026-08-01T18:00:00.000Z",
            r_multiple: "1.5",
          },
        ];
      } else if (sql.includes("max(closed_at)")) {
        rows = [{ m: "5" }];
      } else if (sql.includes("ORDER BY closed_at DESC LIMIT 20")) {
        rows = [{ r_multiple: "-1" }];
      } else {
        rows = [{ c: "0" }];
      }
      return { rows: rows as T[] };
    },
  };

  const result = await retrieveSqlFallback(
    {
      userId: authenticatedTenant.userId,
      asset: "BTC",
      assetClass: "crypto",
      direction: "long",
      riskPct: 1,
      session: "ny",
      regime: "trending",
    },
    database,
  );

  assert.equal(result.trades[0].thesisRaw, "Raw tenant-scoped episode");
  assert.equal(calls.length, 6);
  assert.equal(calls.every((call) => call.values[0] === authenticatedTenant.userId), true);
  assert.match(calls[0].sql, /t\.user_id = \$1 AND i\.user_id = \$1/);
  assert.doesNotMatch(calls[0].sql, /embedding|vector|<=>/i);
});

test("canonicalization failure with no fallback evidence blocks safely", async () => {
  const dependencies = fixtureDependencies();
  dependencies.loadActiveRules = async () => [];
  dependencies.canonicalize = async () => {
    throw new Error("secret provider diagnostic");
  };
  dependencies.fallbackRetrieve = async () => {
    const fixture = await fixtureDependencies().retrieve({
      userId: authenticatedTenant.userId,
      canonicalThesis: "unused fixture",
      asset: "BTC",
      assetClass: "crypto",
      direction: "long",
      strategy: null,
      riskPct: 1,
      session: "ny",
      regime: "trending",
    });
    return { ...fixture, trades: [], cohort: summarize([]), candidates: 0 };
  };

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);

  assert.equal(result.state, "error");
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.retrieval, null);
  assert.equal(JSON.stringify(result).includes("secret provider diagnostic"), false);
});

test("normal retrieval with no evidence blocks even when no rules exist", async () => {
  const dependencies = fixtureDependencies();
  dependencies.loadActiveRules = async () => [];
  dependencies.retrieve = async () => {
    const fixture = await fixtureDependencies().retrieve({
      userId: authenticatedTenant.userId,
      canonicalThesis: "unused fixture",
      asset: "BTC",
      assetClass: "crypto",
      direction: "long",
      strategy: null,
      riskPct: 1,
      session: "ny",
      regime: "trending",
    });
    return { ...fixture, trades: [], cohort: summarize([]), candidates: 0 };
  };

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);

  assert.equal(result.state, "degraded");
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.retrieval, null);
});

test("malformed retrieval cohort returns a sanitized structured BLOCK", async () => {
  const dependencies = fixtureDependencies();
  dependencies.loadActiveRules = async () => [];
  const baseRetrieve = dependencies.retrieve;
  dependencies.retrieve = async (query) => ({
    ...(await baseRetrieve(query)),
    cohort: {
      n: 1,
      wins: 2,
      losses: 0,
      rate: 2,
      interval: { low: 0, high: 1 },
      tier: "anecdote",
      avgR: null,
    },
  });

  const result = await processTradeIntent(validIntent, authenticatedTenant, dependencies);

  assert.equal(result.state, "degraded");
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.retrieval, null);
  assert.deepEqual(result.errors, [
    { stage: "retrieval", message: "Trade memory retrieval is unavailable." },
  ]);
  assert.equal(JSON.stringify(result).includes("Invalid retrieval cohort"), false);
});

test("vector retrieval SQL scopes both sides of the tenant join", () => {
  const sql = buildAnnSearchSql("i.direction = $2", "$3");

  assert.match(sql, /i\.user_id = \$1/);
  assert.match(sql, /t\.user_id = \$1/);
  assert.match(sql, /t\.intent_id = i\.id/);
});
