import type { IntentApiSuccess } from "./intent-route";

export const FIELD_OPTIONS = {
  direction: ["long", "short"],
  confidence: ["low", "medium", "high"],
  session: ["asia", "london", "ny", "off"],
  regime: ["trending", "ranging", "volatile", "unknown"],
} as const;

export interface IntentDraft {
  asset: string;
  assetClass: string;
  direction: (typeof FIELD_OPTIONS.direction)[number];
  thesisRaw: string;
  size: string;
  entry: string;
  stopLoss: string;
  takeProfit: string;
  riskPct: string;
  confidence: (typeof FIELD_OPTIONS.confidence)[number];
  session: (typeof FIELD_OPTIONS.session)[number];
  regime: (typeof FIELD_OPTIONS.regime)[number];
  sizeIncreaseAfterLoss: boolean;
}

export interface TradeIntentPayload {
  asset: string;
  assetClass: string;
  direction: IntentDraft["direction"];
  thesisRaw: string;
  size: number;
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  riskPct: number;
  confidence: IntentDraft["confidence"];
  session: IntentDraft["session"];
  regime: IntentDraft["regime"];
  sizeIncreaseAfterLoss: boolean;
}

export type IntentField = keyof IntentDraft;
export type IntentErrors = Partial<Record<IntentField, string>>;
export type WorkspaceState =
  | "empty"
  | "loading"
  | "result"
  | "validation_error"
  | "unavailable"
  | "example"
  | "degraded";
export type Decision = "BLOCK" | "WARN" | "PASS";
export type OutcomeTone = "positive" | "negative" | "neutral";

export type IntentSubmissionState =
  | { kind: "empty" }
  | { kind: "loading" }
  | { kind: "result"; result: IntentApiSuccess }
  | { kind: "validation_error"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "example" }
  | { kind: "degraded" };

export function getOutcomeTone(outcome: string): OutcomeTone {
  const value = Number.parseFloat(outcome);
  if (!Number.isFinite(value) || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function isPositiveNumber(value: string): boolean {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) && parsed > 0;
}

export function getIntentErrors(draft: IntentDraft): IntentErrors {
  const errors: IntentErrors = {};
  if (!draft.asset.trim()) errors.asset = "Enter an asset.";
  if (!draft.assetClass.trim()) errors.assetClass = "Enter an asset class.";
  if (!draft.thesisRaw.trim()) errors.thesisRaw = "State a thesis.";
  if (!isPositiveNumber(draft.size)) errors.size = "Size must be a finite positive number.";
  if (!isPositiveNumber(draft.entry)) errors.entry = "Entry must be a finite positive number.";
  if (draft.stopLoss.trim() && !isPositiveNumber(draft.stopLoss)) {
    errors.stopLoss = "Stop loss must be blank or a finite positive number.";
  }
  if (draft.takeProfit.trim() && !isPositiveNumber(draft.takeProfit)) {
    errors.takeProfit = "Take profit must be blank or a finite positive number.";
  }
  if (!isPositiveNumber(draft.riskPct)) errors.riskPct = "Risk must be a finite positive number.";
  return errors;
}

export function toTradeIntentInput(draft: IntentDraft): TradeIntentPayload {
  return {
    asset: draft.asset.trim(),
    assetClass: draft.assetClass.trim(),
    direction: draft.direction,
    thesisRaw: draft.thesisRaw.trim(),
    size: Number(draft.size),
    entry: Number(draft.entry),
    stopLoss: draft.stopLoss.trim() ? Number(draft.stopLoss) : null,
    takeProfit: draft.takeProfit.trim() ? Number(draft.takeProfit) : null,
    riskPct: Number(draft.riskPct),
    confidence: draft.confidence,
    session: draft.session,
    regime: draft.regime,
    sizeIncreaseAfterLoss: draft.sizeIncreaseAfterLoss,
  };
}

interface WorkspaceView {
  title: string;
  detail: string;
  recovery: string | null;
  decision: Decision | null;
}

const WORKSPACE_VIEWS: Record<WorkspaceState, WorkspaceView> = {
  empty: {
    title: "Your decision check will appear here",
    detail: "Complete the intent form to review the request. Nothing has been sent.",
    recovery: null,
    decision: null,
  },
  loading: {
    title: "Checking this intent",
    detail: "Waiting for the real server decision service to resolve tenant rules and memory.",
    recovery: null,
    decision: null,
  },
  result: {
    title: "Decision result",
    detail: "Returned by the server decision service for the configured tenant.",
    recovery: null,
    decision: null,
  },
  validation_error: {
    title: "Intent needs correction",
    detail: "The server rejected this intent before decision processing.",
    recovery: "Review the form values and submit again.",
    decision: null,
  },
  unavailable: {
    title: "Decision service unavailable",
    detail:
      "The server could not return a trusted decision result. No paper trade was authorized.",
    recovery: "Check server identity and provider configuration, then submit again.",
    decision: "BLOCK",
  },
  example: {
    title: "Example decision result",
    detail: "A static fixture demonstrates the evidence hierarchy. It is not live account history.",
    recovery: null,
    decision: "WARN",
  },
  degraded: {
    title: "Provider unavailable",
    detail:
      "Canonicalization is unavailable. This degraded example is fixture-only and not live provider evidence.",
    recovery: "Deterministic safety rules remain visible, but this preview cannot authorize a trade.",
    decision: "BLOCK",
  },
};

export function getWorkspaceView(state: WorkspaceState): WorkspaceView {
  return WORKSPACE_VIEWS[state];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntentApiSuccess(value: unknown): value is IntentApiSuccess {
  if (!isRecord(value)) return false;
  if (!["complete", "degraded", "error"].includes(String(value.state))) return false;
  if (!["BLOCK", "WARN", "PASS"].includes(String(value.decision))) return false;
  if (!Array.isArray(value.errors) || !isRecord(value.rules) || !Array.isArray(value.rules.evidence)) {
    return false;
  }
  if (value.state === "complete" && (!isRecord(value.canonicalThesis) || !isRecord(value.retrieval))) {
    return false;
  }
  if (value.retrieval !== null) {
    if (!isRecord(value.retrieval) || !Array.isArray(value.retrieval.episodes)) return false;
    if (!isRecord(value.retrieval.cohort) || !Number.isSafeInteger(value.retrieval.cohort.n)) return false;
    if (!isRecord(value.retrieval.filter)) return false;
  }
  return true;
}

export function interpretIntentApiResponse(status: number, body: unknown): IntentSubmissionState {
  if (status >= 200 && status < 300 && isIntentApiSuccess(body)) {
    return { kind: "result", result: body };
  }
  if (status === 400 && isRecord(body) && body.state === "validation_error") {
    return {
      kind: "validation_error",
      message: typeof body.message === "string" ? body.message : "Invalid trade intent.",
    };
  }
  if (status >= 500 && isRecord(body) && typeof body.message === "string") {
    return { kind: "unavailable", message: body.message };
  }
  return { kind: "unavailable", message: "The decision response was invalid." };
}

interface ExampleRule {
  id: string;
  label: string;
  field: string;
  operator: string;
  expected: string;
  actual: string;
  enforcement: "block" | "warn";
  passed: boolean;
}

interface ExampleEpisode {
  id: string;
  source: "EXAMPLE FIXTURE DATA";
  asset: string;
  thesis: string;
  outcome: string;
  context: string;
}

export const EXAMPLE_RESULT: {
  source: "EXAMPLE FIXTURE DATA";
  decision: "WARN";
  summary: string;
  cohort: { tier: "anecdote"; n: 3; caveat: string };
  filter: { used: string; widened: true; candidates: number; disclosure: string };
  rules: ExampleRule[];
  episodes: ExampleEpisode[];
} = {
  source: "EXAMPLE FIXTURE DATA",
  decision: "WARN",
  summary: "One advisory rule needs attention before this paper-trade intent proceeds.",
  cohort: {
    tier: "anecdote",
    n: 3,
    caveat: "Only 3 comparable episodes exist. These are anecdotes, not a pattern. No rate is shown.",
  },
  filter: {
    used: "same direction and asset class",
    widened: true,
    candidates: 6,
    disclosure:
      "The example filter was widened from the same asset and strategy to the same direction and asset class because the initial cohort was too small.",
  },
  rules: [
    {
      id: "risk-limit",
      label: "Risk at or below 2%",
      field: "risk_pct",
      operator: "lte",
      expected: "2",
      actual: "1",
      enforcement: "block",
      passed: true,
    },
    {
      id: "loss-cooldown",
      label: "Wait 20 minutes after a loss",
      field: "minutes_since_last_loss",
      operator: "gte",
      expected: "20",
      actual: "12",
      enforcement: "warn",
      passed: false,
    },
  ],
  episodes: [
    {
      id: "fixture-episode-01",
      source: "EXAMPLE FIXTURE DATA",
      asset: "BTC long",
      thesis: "Reclaimed the prior range high after a clean retest.",
      outcome: "+0.8R",
      context: "Trending, New York session",
    },
    {
      id: "fixture-episode-02",
      source: "EXAMPLE FIXTURE DATA",
      asset: "ETH long",
      thesis: "Breakout held, but entry followed a loss by nine minutes.",
      outcome: "-1.0R",
      context: "Trending, London session",
    },
    {
      id: "fixture-episode-03",
      source: "EXAMPLE FIXTURE DATA",
      asset: "SOL long",
      thesis: "Range high retest held while volume contracted.",
      outcome: "+0.3R",
      context: "Ranging, New York session",
    },
  ],
};
