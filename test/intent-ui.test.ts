import assert from "node:assert/strict";
import test from "node:test";

import {
  EXAMPLE_RESULT,
  FIELD_OPTIONS,
  getIntentErrors,
  getOutcomeTone,
  getWorkspaceView,
  interpretIntentApiResponse,
  toTradeIntentInput,
  type IntentDraft,
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
