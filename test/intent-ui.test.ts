import assert from "node:assert/strict";
import test from "node:test";

import {
  EXAMPLE_RESULT,
  FIELD_OPTIONS,
  buildClosePayload,
  buildExecutePayload,
  formatEvidenceRate,
  getIntentErrors,
  getOutcomeTone,
  getWorkspaceView,
  interpretCloseApiResponse,
  interpretInsightsApiResponse,
  interpretIntentApiResponse,
  interpretTradeApiResponse,
  toTradeIntentInput,
  warningsShownFromResult,
  type DnaRow,
  type IntentDraft,
  type WarningCode,
} from "../src/lib/intent-ui";
import { validateTradeIntent } from "../src/lib/intent-service";

const validDraft: IntentDraft = {
  asset: "BTC",
  assetClass: "crypto",
  direction: "long",
  thesisRaw: "Range high reclaimed with volume; expecting continuation.",
  size: "0.05",
  entry: "64000",
  stopLoss: "62800",
  takeProfit: "67000",
  riskPct: "1",
  confidence: "medium",
  session: "ny",
  regime: "trending",
  sizeIncreaseAfterLoss: false,
};

test("closed UI options match the existing service contract", () => {
  assert.deepEqual(FIELD_OPTIONS.direction, ["long", "short"]);
  assert.deepEqual(FIELD_OPTIONS.confidence, ["low", "medium", "high"]);
  assert.deepEqual(FIELD_OPTIONS.session, ["asia", "london", "ny", "off"]);
  assert.deepEqual(FIELD_OPTIONS.regime, ["trending", "ranging", "volatile", "unknown"]);
});

test("intent validation reports accessible field-level errors", () => {
  const errors = getIntentErrors({
    ...validDraft,
    asset: " ",
    thesisRaw: " ",
    size: "0",
    entry: "NaN",
    stopLoss: "-1",
    riskPct: "0",
  });

  assert.equal(errors.asset, "Enter an asset.");
  assert.equal(errors.thesisRaw, "State a thesis.");
  assert.equal(errors.size, "Size must be a finite positive number.");
  assert.equal(errors.entry, "Entry must be a finite positive number.");
  assert.equal(errors.stopLoss, "Stop loss must be blank or a finite positive number.");
  assert.equal(errors.riskPct, "Risk must be a finite positive number.");
  assert.deepEqual(getIntentErrors(validDraft), {});
});

test("a UI-valid draft converts to the exact existing service contract", () => {
  const briefDraft = { ...validDraft, thesisRaw: "brief", stopLoss: "", takeProfit: "" };
  assert.deepEqual(getIntentErrors(briefDraft), {});
  const validated = validateTradeIntent(toTradeIntentInput(briefDraft));
  assert.equal(validated.thesisRaw, "brief");
  assert.equal(validated.size, 0.05);
  assert.equal(validated.entry, 64000);
  assert.equal(validated.stopLoss, null);
  assert.equal(validated.takeProfit, null);
  assert.equal(validated.sizeIncreaseAfterLoss, false);
});

test("workspace states distinguish empty and unavailable service access", () => {
  assert.match(getWorkspaceView("empty").title, /decision check/i);
  const unavailable = getWorkspaceView("unavailable");
  assert.equal(unavailable.decision, "BLOCK");
  assert.match(unavailable.detail, /could not return/i);
  assert.ok(unavailable.recovery);
  assert.match(unavailable.recovery!, /server identity and provider configuration/i);
});

test("example result repeatedly and visibly identifies fixture data", () => {
  assert.equal(EXAMPLE_RESULT.source, "EXAMPLE FIXTURE DATA");
  assert.equal(EXAMPLE_RESULT.decision, "WARN");
  assert.equal(EXAMPLE_RESULT.cohort.tier, "anecdote");
  assert.equal(EXAMPLE_RESULT.cohort.n, 3);
  assert.equal(EXAMPLE_RESULT.episodes.length, 3);
  assert.ok(EXAMPLE_RESULT.episodes.every((episode) => episode.source === "EXAMPLE FIXTURE DATA"));
  assert.equal(EXAMPLE_RESULT.filter.widened, true);
  assert.ok(EXAMPLE_RESULT.rules.some((rule) => rule.passed));
  assert.ok(EXAMPLE_RESULT.rules.some((rule) => !rule.passed));
});

test("degraded fixture state never implies live provider evidence", () => {
  const degraded = getWorkspaceView("degraded");
  assert.equal(degraded.decision, "BLOCK");
  assert.match(degraded.title, /provider unavailable/i);
  assert.match(degraded.detail, /not live/i);
});

test("example outcomes use semantic tones instead of presenting losses as wins", () => {
  assert.equal(getOutcomeTone("+0.8R"), "positive");
  assert.equal(getOutcomeTone("-1.0R"), "negative");
  assert.equal(getOutcomeTone("0R"), "neutral");
});

test("real API responses map to distinct success, validation, and unavailable states", () => {
  const liveResult = {
    state: "complete",
    decision: "WARN",
    errors: [],
    canonicalThesis: {
      strategy: "breakout_retest",
      signals: ["retest holding"],
      marketThesis: "continuation",
      confirmationStated: true,
      canonical: "breakout retest; retest holding; expecting continuation",
    },
    retrieval: {
      evidenceTier: "anecdote",
      episodes: [{
        intentId: "intent-1",
        tradeId: "trade-1",
        asset: "BTC",
        direction: "long",
        strategy: "breakout_retest",
        session: "ny",
        regime: "trending",
        riskPct: 1,
        confidence: "high",
        thesisRaw: "Range high held on the retest.",
        openedAt: "2026-08-01T12:00:00.000Z",
        closedAt: "2026-08-01T18:00:00.000Z",
        rMultiple: 1,
        win: true,
      }],
      cohort: { tier: "anecdote", n: 1, caveat: "Only one comparable episode." },
      filter: { used: "same direction and strategy", widened: false, candidates: 1 },
    },
    behaviour: {
      minutesSinceLastLoss: null,
      tradesToday: 0,
      lossStreak: 0,
      openPositions: 0,
      stopWidenedLast30d: 0,
    },
    rules: { evidence: [] },
  };

  const success = interpretIntentApiResponse(200, liveResult);
  assert.equal(success.kind, "result");
  assert.equal(success.kind === "result" ? success.result.decision : null, "WARN");

  const validation = interpretIntentApiResponse(400, {
    state: "validation_error",
    message: "Invalid trade intent.",
    issues: ["unknown field: user_id"],
  });
  assert.deepEqual(validation, {
    kind: "validation_error",
    message: "Invalid trade intent.",
  });

  const unavailable = interpretIntentApiResponse(503, {
    state: "unavailable",
    message: "Trusted server identity is unavailable.",
  });
  assert.deepEqual(unavailable, {
    kind: "unavailable",
    message: "Trusted server identity is unavailable.",
  });
});

test("malformed API success output fails closed in the UI contract", () => {
  assert.deepEqual(
    interpretIntentApiResponse(200, { state: "complete", decision: "ALLOW" }),
    { kind: "unavailable", message: "The decision response was invalid." },
  );
  assert.match(getWorkspaceView("loading").detail, /server decision service/i);
});

const canonicalIntent = toTradeIntentInput({ ...validDraft, thesisRaw: "range high reclaim with volume" });

test("execute payload for PASS records an unmodified executed action with no defiance", () => {
  const payload = buildExecutePayload(canonicalIntent, [], []);
  assert.equal(payload.action, "executed");
  assert.deepEqual(payload.warningsDefied, []);
  assert.equal(payload.intent.thesisRaw, "range high reclaim with volume");
});

test("execute payload for WARN with full defiance uses executed; partial defiance is modified_then_executed", () => {
  const shown: WarningCode[] = ["NO_STOP_LOSS", "OVERSIZED_RISK"];
  const full = buildExecutePayload(canonicalIntent, shown, ["NO_STOP_LOSS", "OVERSIZED_RISK"]);
  assert.equal(full.action, "executed");
  assert.deepEqual(full.warningsDefied, shown);

  const partial = buildExecutePayload(canonicalIntent, shown, ["NO_STOP_LOSS"]);
  assert.equal(partial.action, "modified_then_executed");
  assert.deepEqual(partial.warningsDefied, ["NO_STOP_LOSS"]);

  const none = buildExecutePayload(canonicalIntent, shown, []);
  assert.equal(none.action, "modified_then_executed");
  assert.deepEqual(none.warningsDefied, []);
});

test("execute payload never lets the browser attach the user_id or the decision", () => {
  const payload = buildExecutePayload(canonicalIntent, [], []);
  assert.ok(!("userId" in payload));
  assert.ok(!("user_id" in payload));
  assert.ok(!("decision" in payload));
});

test("warnings shown are derived only from failed warn rules", () => {
  const result = {
    state: "complete",
    decision: "WARN",
    errors: [],
    canonicalThesis: null,
    retrieval: null,
    behaviour: null,
    rules: {
      evidence: [
        { ruleId: "a", field: "has_stop_loss", enforcement: "warn", passed: false },
        { ruleId: "b", field: "risk_pct", enforcement: "warn", passed: false },
        { ruleId: "c", field: "risk_pct", enforcement: "warn", passed: false },
        { ruleId: "d", field: "risk_pct", enforcement: "block", passed: false },
        { ruleId: "e", field: "has_stop_loss", enforcement: "warn", passed: true },
      ],
    },
  } as unknown as Parameters<typeof warningsShownFromResult>[0];
  assert.deepEqual(warningsShownFromResult(result), ["NO_STOP_LOSS", "OVERSIZED_RISK"]);
});

test("execute API responses map to executed, blocked, validation, and unavailable states", () => {
  const executed = interpretTradeApiResponse(200, {
    state: "executed",
    decision: "PASS",
    decisionId: "11111111-1111-4111-8111-111111111111",
    tradeId: "22222222-2222-4222-8222-222222222222",
    replayed: false,
    warningsShown: [],
    warningsDefied: [],
    trade: {
      id: "22222222-2222-4222-8222-222222222222",
      asset: "BTC",
      direction: "long",
      size: 0.05,
      entry: 64000,
      stop: 62800,
      openedAt: "2026-08-16T12:00:00.000Z",
    },
  });
  assert.equal(executed.kind, "executed");
  assert.equal(executed.kind === "executed" ? executed.executed.decision : null, "PASS");
  assert.equal(executed.kind === "executed" ? executed.executed.trade.asset : null, "BTC");

  const blocked = interpretTradeApiResponse(409, { state: "blocked", decision: "BLOCK", message: "Blocked intents cannot execute." });
  assert.deepEqual(blocked, { kind: "blocked", message: "Blocked intents cannot execute." });

  const validation = interpretTradeApiResponse(400, { state: "validation_error", message: "Invalid execute request." });
  assert.deepEqual(validation, { kind: "validation_error", message: "Invalid execute request." });

  const unavailable = interpretTradeApiResponse(503, { state: "unavailable", message: "Paper trade service unavailable." });
  assert.deepEqual(unavailable, { kind: "unavailable", message: "Paper trade service unavailable." });
});

test("malformed execute success output fails closed as unavailable", () => {
  const invalid = interpretTradeApiResponse(200, { state: "blocked", message: "not a success" });
  assert.deepEqual(invalid, { kind: "unavailable", message: "The paper trade response was invalid." });
});

test("close payload validates a positive finite exit fill", () => {
  assert.deepEqual(
    buildClosePayload("22222222-2222-4222-8222-222222222222", "64800"),
    { tradeId: "22222222-2222-4222-8222-222222222222", exitFill: 64800 },
  );
  assert.throws(() => buildClosePayload("trade-1", "0"), /positive number/);
  assert.throws(() => buildClosePayload("trade-1", "NaN"), /positive number/);
});

test("close API responses map to closed, not-found, already-closed, validation, and unavailable", () => {
  const closedBody = {
    state: "closed",
    outcome: {
      tradeId: "22222222-2222-4222-8222-222222222222",
      intentId: "11111111-1111-4111-8111-111111111111",
      pnl: 20,
      rMultiple: 1.2,
      durationS: 3600,
      exitFill: 64800,
      exitReason: "manual",
      win: true,
    },
    memory: {
      evidence: { tier: "anecdote", n: 1, averageR: 1.2 },
      lineage: "11111111-1111-4111-8111-111111111111",
    },
  };
  const closed = interpretCloseApiResponse(200, closedBody);
  assert.equal(closed.kind, "closed");
  assert.equal(closed.kind === "closed" ? closed.closed.outcome.rMultiple : null, 1.2);
  assert.equal(closed.kind === "closed" ? closed.closed.memory.evidence.tier : null, "anecdote");

  assert.deepEqual(interpretCloseApiResponse(404, { state: "not_found", message: "no trade" }), { kind: "not_found", message: "no trade" });
  assert.deepEqual(interpretCloseApiResponse(409, { state: "already_closed", message: "closed." }), { kind: "already_closed", message: "closed." });
  assert.deepEqual(interpretCloseApiResponse(400, { state: "validation_error", message: "bad." }), { kind: "validation_error", message: "bad." });
  assert.deepEqual(interpretCloseApiResponse(503, { state: "unavailable", message: "gone." }), { kind: "unavailable", message: "gone." });
});

test("malformed close success output fails closed as unavailable", () => {
  assert.deepEqual(interpretCloseApiResponse(200, { state: "bogus" }), {
    kind: "unavailable",
    message: "The close response was invalid.",
  });
});

test("insights response interprets a real ok payload as dna + warning ledger", () => {
  const body = {
    state: "ok",
    dna: [
      { strategy: "breakout_retest", n: 3, tier: "anecdote", wins: null, losses: null, rate: null, averageR: null, caveat: "anecdote", episodes: [{ tradeId: "11111111-1111-4111-8111-111111111111", thesisRaw: "t", rMultiple: 0.5, asset: "BTC" }] },
    ],
    warnings: [{ code: "NO_STOP_LOSS", shown: 2, heeded: 1, defied: 1, defiedWithWin: 0, defiedWithLoss: 1 }],
  };
  const state = interpretInsightsApiResponse(200, body);
  assert.equal(state.kind, "ok");
  if (state.kind === "ok") {
    assert.equal(state.insights.dna[0].n, 3);
    assert.equal(state.insights.warnings[0].defiedWithLoss, 1);
  }
});

test("interpretInsightsApiResponse fails closed on malformed or unavailable", () => {
  assert.equal(interpretInsightsApiResponse(200, { state: "bogus" }).kind, "unavailable");
  assert.equal(interpretInsightsApiResponse(200, { state: "ok", dna: "nope", warnings: [] }).kind, "unavailable");
  const unavailable = interpretInsightsApiResponse(503, { state: "unavailable", message: "gone." });
  assert.deepEqual(unavailable, { kind: "unavailable", message: "gone." });
});

test("anecdote cohorts never render an unsupported percentage", () => {
  const anecdote: DnaRow = { strategy: "reversal", n: 3, tier: "anecdote", wins: null, losses: null, rate: null, averageR: null, caveat: "anecdote", episodes: [] };
  assert.equal(formatEvidenceRate(anecdote), null);
  const tiny: DnaRow = { strategy: "reversal", n: 6, tier: "signal", wins: 4, losses: 2, rate: 0.66, averageR: 0.4, caveat: "signal", episodes: [] };
  assert.equal(formatEvidenceRate(tiny), null);
  const coherent: DnaRow = { strategy: "reversal", n: 20, tier: "established", wins: 14, losses: 6, rate: 0.7, averageR: 0.4, caveat: "established", episodes: [] };
  assert.match(formatEvidenceRate(coherent) ?? "", /70%/);
});
