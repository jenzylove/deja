import { canonicalizeThesis, type CanonicalThesis } from "./canonicalize";
import { db } from "./db";
import {
  retrieve,
  retrieveSqlFallback,
  type BehaviouralState,
  type RetrievalQuery,
  type RetrievalResult,
  type RetrievedTrade,
  type SqlFallbackQuery,
} from "./retrieval";
import {
  compileRule,
  evaluateRules,
  type EvaluationDecision,
  type Rule,
  type RuleEvidence,
  type RuleState,
} from "./rules";
import {
  renderable,
  tierFor,
  wilson,
  type Cohort,
  type EvidenceTier,
  type Interval,
} from "./stats";

const DIRECTIONS = ["long", "short"] as const;
const CONFIDENCES = ["low", "medium", "high"] as const;
const REGIMES = ["trending", "ranging", "volatile", "unknown"] as const;
const SESSIONS = ["asia", "london", "ny", "off"] as const;
const INTENT_FIELDS = new Set([
  "asset",
  "assetClass",
  "direction",
  "size",
  "entry",
  "stopLoss",
  "takeProfit",
  "riskPct",
  "confidence",
  "thesisRaw",
  "regime",
  "session",
  "sizeIncreaseAfterLoss",
]);

type Direction = (typeof DIRECTIONS)[number];
type Confidence = (typeof CONFIDENCES)[number];
type Regime = (typeof REGIMES)[number];
type Session = (typeof SESSIONS)[number];

export interface TradeIntentInput {
  asset: string;
  assetClass: string;
  direction: Direction;
  size: number;
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  riskPct: number;
  confidence: Confidence;
  thesisRaw: string;
  regime: Regime;
  session: Session;
  sizeIncreaseAfterLoss: boolean;
}

export interface AuthenticatedTenantContext {
  userId: string;
}

export interface StoredRule {
  id: string;
  predicate: unknown;
  enforcement: unknown;
}

export interface IntentServiceDependencies {
  canonicalize(input: {
    thesisRaw: string;
    direction: string;
    assetClass: string;
    regime: string;
    session: string;
  }): Promise<CanonicalThesis>;
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
  fallbackRetrieve(query: SqlFallbackQuery): Promise<RetrievalResult>;
  loadActiveRules(userId: string): Promise<readonly StoredRule[]>;
}

interface AnecdoteCohort {
  tier: "anecdote";
  n: number;
  caveat: string;
}

interface StatisticalCohort {
  tier: "signal" | "established";
  n: number;
  wins: number;
  losses: number;
  percentage: number;
  interval: Interval;
  avgR: number | null;
  caveat: string;
}

type SafeCohort = AnecdoteCohort | StatisticalCohort;

export interface GroundedRetrieval {
  evidenceTier: EvidenceTier;
  episodes: RetrievedTrade[];
  cohort: SafeCohort;
  filter: {
    used: string;
    widened: boolean;
    candidates: number;
  };
}

export type IntentServiceState = "complete" | "degraded" | "error";

export interface IntentServiceResult {
  state: IntentServiceState;
  decision: EvaluationDecision;
  errors: { stage: "canonicalization" | "retrieval" | "rules"; message: string }[];
  canonicalThesis: CanonicalThesis | null;
  retrieval: GroundedRetrieval | null;
  behaviour: BehaviouralState | null;
  rules: { evidence: RuleEvidence[] };
}

export class IntentValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid trade intent: ${issues.join("; ")}`);
    this.name = "IntentValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function validateTradeIntent(input: unknown): TradeIntentInput {
  if (!isRecord(input)) throw new IntentValidationError(["intent must be an object"]);
  const issues: string[] = [];
  for (const key of Object.keys(input)) {
    if (!INTENT_FIELDS.has(key)) issues.push(`unknown field: ${key}`);
  }
  const text = (key: string) => {
    const value = input[key];
    if (typeof value !== "string" || value.trim().length === 0) issues.push(`${key} is required`);
  };
  text("asset");
  text("assetClass");
  text("thesisRaw");
  if (!DIRECTIONS.includes(input.direction as Direction)) issues.push("direction is invalid");
  if (!CONFIDENCES.includes(input.confidence as Confidence)) issues.push("confidence is invalid");
  if (!REGIMES.includes(input.regime as Regime)) issues.push("regime is invalid");
  if (!SESSIONS.includes(input.session as Session)) issues.push("session is invalid");
  for (const key of ["size", "entry", "riskPct"] as const) {
    if (!finitePositive(input[key])) issues.push(`${key} must be a finite positive number`);
  }
  for (const key of ["stopLoss", "takeProfit"] as const) {
    if (input[key] !== null && !finitePositive(input[key])) {
      issues.push(`${key} must be null or a finite positive number`);
    }
  }
  if (typeof input.sizeIncreaseAfterLoss !== "boolean") {
    issues.push("sizeIncreaseAfterLoss must be boolean");
  }
  if (issues.length) throw new IntentValidationError(issues);
  return {
    asset: (input.asset as string).trim(),
    assetClass: (input.assetClass as string).trim(),
    direction: input.direction as Direction,
    size: input.size as number,
    entry: input.entry as number,
    stopLoss: input.stopLoss as number | null,
    takeProfit: input.takeProfit as number | null,
    riskPct: input.riskPct as number,
    confidence: input.confidence as Confidence,
    thesisRaw: (input.thesisRaw as string).trim(),
    regime: input.regime as Regime,
    session: input.session as Session,
    sizeIncreaseAfterLoss: input.sizeIncreaseAfterLoss as boolean,
  };
}

function validateAuthenticatedTenant(context: unknown): AuthenticatedTenantContext {
  if (
    !isRecord(context) ||
    typeof context.userId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      context.userId,
    )
  ) {
    throw new IntentValidationError(["userId must be a UUID"]);
  }
  return { userId: context.userId };
}

function safeCohort(cohort: Cohort): SafeCohort {
  if (
    !Number.isSafeInteger(cohort.n) ||
    cohort.n < 0 ||
    !Number.isSafeInteger(cohort.wins) ||
    cohort.wins < 0 ||
    !Number.isSafeInteger(cohort.losses) ||
    cohort.losses < 0 ||
    cohort.wins + cohort.losses !== cohort.n
  ) {
    throw new Error("Invalid retrieval cohort");
  }
  const normalized: Cohort = {
    n: cohort.n,
    wins: cohort.wins,
    losses: cohort.losses,
    rate: cohort.n === 0 ? null : cohort.wins / cohort.n,
    interval: wilson(cohort.wins, cohort.n),
    tier: tierFor(cohort.n),
    avgR:
      cohort.avgR === null || (typeof cohort.avgR === "number" && Number.isFinite(cohort.avgR))
        ? cohort.avgR
        : null,
  };
  const display = renderable(normalized);
  if (display.tier === "anecdote") {
    return { tier: "anecdote", n: normalized.n, caveat: display.caveat };
  }
  return {
    tier: display.tier,
    n: normalized.n,
    wins: normalized.wins,
    losses: normalized.losses,
    percentage: normalized.rate as number,
    interval: normalized.interval,
    avgR: normalized.avgR,
    caveat: display.caveat,
  };
}

function groundedRetrieval(retrieved: RetrievalResult): GroundedRetrieval {
  const cohort = safeCohort(retrieved.cohort);
  return {
    evidenceTier: cohort.tier,
    episodes:
      cohort.tier === "anecdote"
        ? retrieved.trades.slice(0, 3)
        : retrieved.trades,
    cohort,
    filter: {
      used: retrieved.filterUsed,
      widened: retrieved.widened,
      candidates: retrieved.candidates,
    },
  };
}

function toRuleState(
  intent: TradeIntentInput,
  behaviour: BehaviouralState | null,
): Partial<RuleState> {
  return {
    risk_pct: intent.riskPct,
    ...(behaviour
      ? {
          // No prior loss means a cooldown requirement is satisfied, rather
          // than treating absent history as a loss at this instant.
          minutes_since_last_loss:
            behaviour.minutesSinceLastLoss ?? Number.MAX_SAFE_INTEGER,
          trades_today: behaviour.tradesToday,
        }
      : {}),
    has_stop_loss: intent.stopLoss !== null,
    size_increase_after_loss: intent.sizeIncreaseAfterLoss,
  };
}

function stageMessage(stage: "canonicalization" | "retrieval" | "rules"): string {
  switch (stage) {
    case "canonicalization":
      return "Trade thesis canonicalization is unavailable.";
    case "retrieval":
      return "Trade memory retrieval is unavailable.";
    case "rules":
      return "Safety rules are unavailable.";
  }
}

export interface RuleQueryAdapter {
  query(sql: string, values: unknown[]): Promise<{ rows: StoredRule[] }>;
}

export async function loadActiveRulesForUser(
  userId: string,
  database: RuleQueryAdapter = db(),
): Promise<StoredRule[]> {
  const { rows } = await database.query(
    `SELECT id::STRING AS id, predicate, enforcement::STRING AS enforcement
       FROM rules
      WHERE user_id = $1 AND active = true AND retired_at IS NULL
      ORDER BY created_at ASC, id ASC`,
    [userId],
  );
  return rows;
}

export const productionIntentDependencies: IntentServiceDependencies = {
  canonicalize: canonicalizeThesis,
  retrieve,
  fallbackRetrieve: retrieveSqlFallback,
  loadActiveRules: loadActiveRulesForUser,
};

export async function processTradeIntent(
  rawInput: unknown,
  authenticatedContext: AuthenticatedTenantContext,
  dependencies: IntentServiceDependencies = productionIntentDependencies,
): Promise<IntentServiceResult> {
  const intent = validateTradeIntent(rawInput);
  const tenant = validateAuthenticatedTenant(authenticatedContext);
  let rules: Rule[];
  try {
    const storedRules = await dependencies.loadActiveRules(tenant.userId);
    rules = storedRules.map((row) =>
      compileRule({ id: row.id, predicate: row.predicate, enforcement: row.enforcement }),
    );
  } catch {
    return {
      state: "error",
      decision: "BLOCK",
      errors: [{ stage: "rules", message: stageMessage("rules") }],
      canonicalThesis: null,
      retrieval: null,
      behaviour: null,
      rules: { evidence: [] },
    };
  }

  let canonical: CanonicalThesis;
  try {
    canonical = await dependencies.canonicalize({
      thesisRaw: intent.thesisRaw,
      direction: intent.direction,
      assetClass: intent.assetClass,
      regime: intent.regime,
      session: intent.session,
    });
  } catch {
    try {
      const fallback = await dependencies.fallbackRetrieve({
        userId: tenant.userId,
        asset: intent.asset,
        assetClass: intent.assetClass,
        direction: intent.direction,
        riskPct: intent.riskPct,
        session: intent.session,
        regime: intent.regime,
      });
      if (fallback.trades.length === 0) {
        return {
          state: "error",
          decision: "BLOCK",
          errors: [
            { stage: "canonicalization", message: stageMessage("canonicalization") },
            { stage: "retrieval", message: "No retrieval evidence available" },
          ],
          canonicalThesis: null,
          retrieval: null,
          behaviour: fallback.behaviour,
          rules: { evidence: [] },
        };
      }
      const evaluated = evaluateRules(rules, toRuleState(intent, fallback.behaviour));
      return {
        state: "degraded",
        decision: evaluated.decision,
        errors: [{ stage: "canonicalization", message: stageMessage("canonicalization") }],
        canonicalThesis: null,
        retrieval: groundedRetrieval(fallback),
        behaviour: fallback.behaviour,
        rules: { evidence: evaluated.evidence },
      };
    } catch {
      return {
        state: "error",
        decision: "BLOCK",
        errors: [
          { stage: "canonicalization", message: stageMessage("canonicalization") },
          { stage: "retrieval", message: stageMessage("retrieval") },
        ],
        canonicalThesis: null,
        retrieval: null,
        behaviour: null,
        rules: { evidence: [] },
      };
    }
  }

  let retrieved: RetrievalResult;
  let grounded: GroundedRetrieval;
  try {
    retrieved = await dependencies.retrieve({
      userId: tenant.userId,
      canonicalThesis: canonical.canonical,
      asset: intent.asset,
      assetClass: intent.assetClass,
      direction: intent.direction,
      strategy: canonical.strategy,
      riskPct: intent.riskPct,
      session: intent.session,
      regime: intent.regime,
    });
    if (retrieved.trades.length === 0) {
      throw new Error("No retrieval evidence");
    }
    grounded = groundedRetrieval(retrieved);
  } catch {
    const evaluated = evaluateRules(rules, toRuleState(intent, null));
    return {
      state: "degraded",
      // Retrieval is part of the decision contract. Without memory evidence the
      // service may expose deterministic rule evidence, but it must not permit
      // execution.
      decision: "BLOCK",
      errors: [{ stage: "retrieval", message: stageMessage("retrieval") }],
      canonicalThesis: canonical,
      retrieval: null,
      behaviour: null,
      rules: { evidence: evaluated.evidence },
    };
  }

  const evaluated = evaluateRules(rules, toRuleState(intent, retrieved.behaviour));
  return {
    state: "complete",
    decision: evaluated.decision,
    errors: [],
    canonicalThesis: canonical,
    retrieval: grounded,
    behaviour: retrieved.behaviour,
    rules: { evidence: evaluated.evidence },
  };
}
