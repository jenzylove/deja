import { z } from "zod";

import {
  IntentValidationError,
  processTradeIntent,
  type AuthenticatedTenantContext,
  type IntentServiceResult,
} from "./intent-service";
import { resolveConfiguredActor } from "./server-actor";

export const MAX_INTENT_BODY_BYTES = 16_384;

export interface IntentRouteDependencies {
  resolveActor(): Promise<AuthenticatedTenantContext | null>;
  processIntent(
    body: unknown,
    actor: AuthenticatedTenantContext,
  ): Promise<IntentServiceResult>;
}

const finiteNumber = z.number().finite();
const nullableFiniteNumber = finiteNumber.nullable();
const decisionSchema = z.enum(["BLOCK", "WARN", "PASS"]);
const stageErrorSchema = z.object({
  stage: z.enum(["canonicalization", "retrieval", "rules"]),
  message: z.string().min(1).max(200),
});
const canonicalSchema = z.object({
  strategy: z.enum([
    "breakout_retest",
    "reversal",
    "momentum",
    "range",
    "trend_pullback",
    "news",
    "scalp",
    "other",
  ]),
  signals: z.array(z.string().max(200)).max(5),
  marketThesis: z.enum(["continuation", "reversal", "mean_revert"]),
  confirmationStated: z.boolean(),
  canonical: z.string().min(1).max(4_000),
});
const episodeSchema = z.object({
  intentId: z.string().min(1).max(200),
  tradeId: z.string().min(1).max(200).nullable(),
  asset: z.string().min(1).max(100),
  direction: z.string().min(1).max(20),
  strategy: z.string().max(100).nullable(),
  session: z.string().max(100).nullable(),
  regime: z.string().max(100).nullable(),
  riskPct: nullableFiniteNumber,
  confidence: z.string().max(100).nullable(),
  thesisRaw: z.string().min(1).max(20_000),
  openedAt: z.date(),
  closedAt: z.date().nullable(),
  rMultiple: nullableFiniteNumber,
  win: z.boolean().nullable(),
});
const anecdoteCohortSchema = z.object({
  tier: z.literal("anecdote"),
  n: z.number().int().nonnegative(),
  caveat: z.string().min(1).max(1_000),
});
const statisticalCohortSchema = z.object({
  tier: z.enum(["signal", "established"]),
  n: z.number().int().nonnegative(),
  wins: z.number().int().nonnegative(),
  losses: z.number().int().nonnegative(),
  percentage: finiteNumber.min(0).max(1),
  interval: z.object({ low: finiteNumber.min(0).max(1), high: finiteNumber.min(0).max(1) }),
  avgR: nullableFiniteNumber,
  caveat: z.string().min(1).max(1_000),
});
const retrievalSchema = z.object({
  evidenceTier: z.enum(["anecdote", "signal", "established"]),
  episodes: z.array(episodeSchema).max(8),
  cohort: z.discriminatedUnion("tier", [anecdoteCohortSchema, statisticalCohortSchema]),
  filter: z.object({
    used: z.string().min(1).max(1_000),
    widened: z.boolean(),
    candidates: z.number().int().nonnegative(),
  }),
});
const behaviourSchema = z.object({
  minutesSinceLastLoss: z.number().int().nonnegative().nullable(),
  tradesToday: z.number().int().nonnegative(),
  lossStreak: z.number().int().nonnegative(),
  openPositions: z.number().int().nonnegative(),
  stopWidenedLast30d: z.number().int().nonnegative(),
});
const ruleEvidenceSchema = z.object({
  ruleId: z.string().min(1).max(200),
  field: z.enum([
    "risk_pct",
    "minutes_since_last_loss",
    "trades_today",
    "has_stop_loss",
    "size_increase_after_loss",
  ]),
  expected: z.union([finiteNumber, z.boolean()]),
  actual: z.union([finiteNumber, z.boolean()]),
  operator: z.enum(["eq", "lt", "lte", "gt", "gte"]),
  enforcement: z.enum(["warn", "block"]),
  passed: z.boolean(),
});
const serviceResultSchema = z
  .object({
    state: z.enum(["complete", "degraded", "error"]),
    decision: decisionSchema,
    errors: z.array(stageErrorSchema).max(3),
    canonicalThesis: canonicalSchema.nullable(),
    retrieval: retrievalSchema.nullable(),
    behaviour: behaviourSchema.nullable(),
    rules: z.object({ evidence: z.array(ruleEvidenceSchema).max(100) }),
  })
  .superRefine((result, context) => {
    if (result.state === "complete" && (!result.canonicalThesis || !result.retrieval || result.errors.length)) {
      context.addIssue({ code: "custom", message: "Complete result lacks required evidence" });
    }
    if (result.state === "error" && result.decision !== "BLOCK") {
      context.addIssue({ code: "custom", message: "Error result must block" });
    }
    if (result.retrieval && result.retrieval.evidenceTier !== result.retrieval.cohort.tier) {
      context.addIssue({ code: "custom", message: "Evidence tier mismatch" });
    }
  });

function json(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

class BodyTooLargeError extends Error {}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > MAX_INTENT_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_INTENT_BODY_BYTES) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function publicResult(rawResult: unknown) {
  const result = serviceResultSchema.parse(rawResult);
  return {
    state: result.state,
    decision: result.decision,
    errors: result.errors,
    canonicalThesis: result.canonicalThesis,
    retrieval: result.retrieval
      ? {
          ...result.retrieval,
          episodes: result.retrieval.episodes.map((episode) => ({
            ...episode,
            openedAt: episode.openedAt.toISOString(),
            closedAt: episode.closedAt?.toISOString() ?? null,
          })),
        }
      : null,
    behaviour: result.behaviour,
    rules: result.rules,
  };
}

export type IntentApiSuccess = ReturnType<typeof publicResult>;

export function createIntentPostHandler(dependencies: IntentRouteDependencies) {
  return async function POST(request: Request): Promise<Response> {
    let actor: AuthenticatedTenantContext | null;
    try {
      actor = await dependencies.resolveActor();
    } catch {
      actor = null;
    }
    if (!actor) {
      return json(
        { state: "unavailable", message: "Trusted server identity is unavailable." },
        503,
      );
    }

    let bodyText: string;
    try {
      bodyText = await readBoundedBody(request);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return json({ state: "validation_error", message: "Request body is too large." }, 413);
      }
      return json({ state: "validation_error", message: "Request body could not be read." }, 400);
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      return json(
        { state: "validation_error", message: "Request body must be valid JSON." },
        400,
      );
    }

    try {
      const result = await dependencies.processIntent(body, actor);
      const payload = publicResult(result);
      if (payload.state === "error") {
        return json(
          {
            state: "unavailable",
            decision: "BLOCK",
            message: "Decision service is unavailable.",
            errors: payload.errors,
          },
          503,
        );
      }
      return json(payload, 200);
    } catch (error) {
      if (error instanceof IntentValidationError) {
        return json(
          {
            state: "validation_error",
            message: "Invalid trade intent.",
            issues: [...error.issues],
          },
          400,
        );
      }
      return json(
        { state: "unavailable", message: "Decision service is unavailable." },
        503,
      );
    }
  };
}

export const productionIntentRouteDependencies = {
  resolveActor: resolveConfiguredActor,
  processIntent: processTradeIntent,
} satisfies IntentRouteDependencies;
