import assert from "node:assert/strict";
import test from "node:test";

import { createIntentPostHandler } from "../src/lib/intent-route";
import {
  validateTradeIntent,
  type IntentServiceResult,
} from "../src/lib/intent-service";

const TRUSTED_ACTOR = { userId: "11111111-1111-4111-8111-111111111111" } as const;

const VALID_INTENT = {
  asset: "BTC",
  assetClass: "crypto",
  direction: "long",
  size: 0.1,
  entry: 60_000,
  stopLoss: 58_000,
  takeProfit: 64_000,
  riskPct: 1,
  confidence: "high",
  thesisRaw: "Resistance broke and the retest held with volume.",
  regime: "trending",
  session: "ny",
  sizeIncreaseAfterLoss: false,
} as const;

function serviceResult(decision: "BLOCK" | "WARN" | "PASS" = "PASS"): IntentServiceResult {
  return {
    state: "complete",
    decision,
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
      episodes: [
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
          rMultiple: 1,
          win: true,
          cosine: 0.91,
          score: 0.88,
          ageDays: 14,
        },
      ],
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
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/intents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a trusted server actor reaches the intent service and returns a sanitized result", async () => {
  let capturedActor: unknown;
  let capturedBody: unknown;
  const handler = createIntentPostHandler({
    resolveActor: async () => TRUSTED_ACTOR,
    processIntent: async (body, actor) => {
      capturedBody = body;
      capturedActor = actor;
      return serviceResult("PASS");
    },
  });

  const response = await handler(request(VALID_INTENT));
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(capturedActor, TRUSTED_ACTOR);
  assert.deepEqual(capturedBody, VALID_INTENT);
  assert.equal(payload.decision, "PASS");
  assert.equal(payload.retrieval.cohort.n, 1);
  assert.equal(payload.retrieval.episodes[0].openedAt, "2026-08-01T12:00:00.000Z");
  assert.equal("cosine" in payload.retrieval.episodes[0], false);
});

test("body tenant identifiers and unknown fields are rejected as validation errors", async () => {
  for (const forbidden of [
    { user_id: TRUSTED_ACTOR.userId },
    { userId: TRUSTED_ACTOR.userId },
    { accountId: "browser-selected-account" },
  ]) {
    const handler = createIntentPostHandler({
      resolveActor: async () => TRUSTED_ACTOR,
      processIntent: async (body) => {
        validateTradeIntent(body);
        return serviceResult();
      },
    });

    const response = await handler(request({ ...VALID_INTENT, ...forbidden }));
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.state, "validation_error");
    assert.match(payload.message, /invalid trade intent/i);
    assert.equal(JSON.stringify(payload).includes(TRUSTED_ACTOR.userId), false);
  }
});

test("missing trusted identity fails before reading the body or calling the service", async () => {
  let serviceCalls = 0;
  const handler = createIntentPostHandler({
    resolveActor: async () => null,
    processIntent: async () => {
      serviceCalls++;
      return serviceResult();
    },
  });
  const unreadableBody = new ReadableStream({
    pull() {
      throw new Error("body must not be read");
    },
  });

  const response = await handler(
    new Request("http://localhost/api/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: unreadableBody,
      duplex: "half",
    } as RequestInit & { duplex: "half" }),
  );

  assert.equal(response.status, 503);
  assert.equal(serviceCalls, 0);
  assert.deepEqual(await response.json(), {
    state: "unavailable",
    message: "Trusted server identity is unavailable.",
  });
});

test("malformed JSON returns a sanitized validation response", async () => {
  let serviceCalls = 0;
  const handler = createIntentPostHandler({
    resolveActor: async () => TRUSTED_ACTOR,
    processIntent: async () => {
      serviceCalls++;
      return serviceResult();
    },
  });
  const response = await handler(
    new Request("http://localhost/api/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json secret=do-not-leak",
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(serviceCalls, 0);
  assert.deepEqual(await response.json(), {
    state: "validation_error",
    message: "Request body must be valid JSON.",
  });
});

test("oversize request bodies are rejected before the service", async () => {
  let serviceCalls = 0;
  const handler = createIntentPostHandler({
    resolveActor: async () => TRUSTED_ACTOR,
    processIntent: async () => {
      serviceCalls++;
      return serviceResult();
    },
  });
  const response = await handler(
    new Request("http://localhost/api/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...VALID_INTENT, thesisRaw: "x".repeat(17_000) }),
    }),
  );

  assert.equal(response.status, 413);
  assert.equal(serviceCalls, 0);
  assert.deepEqual(await response.json(), {
    state: "validation_error",
    message: "Request body is too large.",
  });
});

test("malformed service output is replaced with a sanitized unavailable response", async () => {
  const handler = createIntentPostHandler({
    resolveActor: async () => TRUSTED_ACTOR,
    processIntent: async () =>
      ({
        ...serviceResult(),
        decision: "ALLOW",
        internalDiagnostic: "database-password=do-not-leak",
      }) as unknown as IntentServiceResult,
  });

  const response = await handler(request(VALID_INTENT));
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(payload, {
    state: "unavailable",
    message: "Decision service is unavailable.",
  });
  assert.equal(JSON.stringify(payload).includes("database-password"), false);
});

test("BLOCK, WARN, and PASS decisions retain their exact service integrity", async () => {
  for (const decision of ["BLOCK", "WARN", "PASS"] as const) {
    const handler = createIntentPostHandler({
      resolveActor: async () => TRUSTED_ACTOR,
      processIntent: async () => serviceResult(decision),
    });
    const response = await handler(request(VALID_INTENT));
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.state, "complete");
    assert.equal(payload.decision, decision);
  }
});

test("service configuration failure is an honest unavailable BLOCK response", async () => {
  const failed = serviceResult("BLOCK");
  failed.state = "error";
  failed.errors = [{ stage: "rules", message: "Safety rules are unavailable." }];
  failed.canonicalThesis = null;
  failed.retrieval = null;
  failed.behaviour = null;

  const handler = createIntentPostHandler({
    resolveActor: async () => TRUSTED_ACTOR,
    processIntent: async () => failed,
  });
  const response = await handler(request(VALID_INTENT));

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    state: "unavailable",
    decision: "BLOCK",
    message: "Decision service is unavailable.",
    errors: [{ stage: "rules", message: "Safety rules are unavailable." }],
  });
});
