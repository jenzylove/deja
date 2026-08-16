import { types as utilTypes } from "node:util";
import { effectSize, qualifiesAsPattern, tierFor, wilson, type EvidenceTier, type Interval } from "./stats";

export const WARNING_CODES = [
  "EARLY_ENTRY", "OVERSIZED_RISK", "POST_LOSS_REENTRY", "DAILY_CAP_EXCEEDED",
  "NO_STOP_LOSS", "STOP_WIDENED", "WEAK_REGIME_MATCH", "ASSET_UNDERPERFORMANCE",
  "STRATEGY_DRIFT", "SIZE_ESCALATION", "LOW_EVIDENCE",
] as const;

export type WarningCode = (typeof WARNING_CODES)[number];
export type DecisionAction = "executed" | "modified_then_executed";

export interface TrustedTenantContext { userId: string }
export interface TrustedExecutionAuthorization {
  intentId: string;
  decision: "PASS" | "WARN" | "BLOCK";
  warningsShown: WarningCode[];
}

export interface OpenExecutionInput {
  userId: string;
  intentId: string;
  action: DecisionAction;
  warningsShown: WarningCode[];
  warningsDefied: WarningCode[];
}

export interface OpenExecutionResult { decisionId: string; tradeId: string; replayed: boolean }
export interface PaperExecutionStore {
  openAtomic(input: OpenExecutionInput): Promise<OpenExecutionResult>;
}

export type ExitReason = "stop" | "target" | "manual" | "timeout";
export interface OpenTradeRecord {
  tradeId: string;
  intentId: string;
  userId: string;
  direction: "long" | "short";
  entryFill: number;
  size: number;
  initialStop: number | null;
  openedAt: string;
  closedAt: string | null;
}
export interface ClosedTradeOutcome {
  tradeId: string;
  intentId: string;
  pnl: number;
  rMultiple: number;
  durationS: number;
  exitFill: number;
  exitReason: ExitReason;
}
export interface CloseTradeInput {
  userId: string;
  tradeId: string;
  exitFill: number;
  exitReason: ExitReason;
  closedAt: string;
  compute(row: OpenTradeRecord): ClosedTradeOutcome;
}
export interface PaperClosureStore {
  closeAtomic(input: CloseTradeInput): Promise<ClosedTradeOutcome>;
}

export type PaperTradeErrorCode =
  | "INVALID_REQUEST" | "EXECUTION_BLOCKED" | "INVALID_WARNING_DEFIANCE"
  | "PERSISTENCE_UNAVAILABLE" | "TRADE_NOT_FOUND" | "TRADE_ALREADY_CLOSED"
  | "INVALID_INITIAL_RISK";

const PUBLIC_MESSAGES: Record<PaperTradeErrorCode, string> = {
  INVALID_REQUEST: "Paper trade request is invalid.",
  EXECUTION_BLOCKED: "Blocked trade intents cannot execute.",
  INVALID_WARNING_DEFIANCE: "Warning defiance is invalid.",
  PERSISTENCE_UNAVAILABLE: "Paper trade persistence is unavailable.",
  TRADE_NOT_FOUND: "Open paper trade was not found.",
  TRADE_ALREADY_CLOSED: "Paper trade is already closed.",
  INVALID_INITIAL_RISK: "Paper trade has invalid initial risk.",
};

export class PaperTradeError extends Error {
  constructor(readonly code: PaperTradeErrorCode) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "PaperTradeError";
  }
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string");
}

type PlainData = null | undefined | string | number | boolean | bigint | PlainData[] | { [key: string]: PlainData };

/** Capture untrusted data once without property reads, then validate only the detached immutable copy. */
function plainDataSnapshot(value: unknown, ancestors = new WeakSet<object>()): PlainData {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value as PlainData;
  if (typeof value === "function" || utilTypes.isProxy(value)) throw new PaperTradeError("INVALID_REQUEST");
  const source = value as object;
  if (ancestors.has(source)) throw new PaperTradeError("INVALID_REQUEST");
  ancestors.add(source);
  try {
    const prototype = Object.getPrototypeOf(source);
    const descriptors = Object.getOwnPropertyDescriptors(source);
    const keys = Reflect.ownKeys(source);
    if (Array.isArray(source)) {
      if (prototype !== Array.prototype || keys.some((key) => typeof key !== "string")) throw new PaperTradeError("INVALID_REQUEST");
      const lengthDescriptor = descriptors.length;
      if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 ||
          keys.length !== lengthDescriptor.value + 1) throw new PaperTradeError("INVALID_REQUEST");
      const copy: PlainData[] = [];
      for (let index = 0; index < lengthDescriptor.value; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new PaperTradeError("INVALID_REQUEST");
        copy.push(plainDataSnapshot(descriptor.value, ancestors));
      }
      Object.freeze(copy);
      return copy;
    }
    if (prototype !== Object.prototype && prototype !== null) throw new PaperTradeError("INVALID_REQUEST");
    const copy: { [key: string]: PlainData } = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new PaperTradeError("INVALID_REQUEST");
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new PaperTradeError("INVALID_REQUEST");
      Object.defineProperty(copy, key, {
        value: plainDataSnapshot(descriptor.value, ancestors), enumerable: true, writable: false, configurable: false,
      });
    }
    return Object.freeze(copy);
  } catch (error) {
    if (error instanceof PaperTradeError) throw error;
    throw new PaperTradeError("INVALID_REQUEST");
  } finally {
    ancestors.delete(source);
  }
}

export interface CapturedSqlResult {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly rowCount: number | null;
}

/** Descriptor-safe capture for an untrusted SQL adapter result before any row/property read. */
export function captureDescriptorSafeSqlResult(
  value: unknown,
  rowFields: readonly string[],
  allowedRowLengths?: readonly number[],
): CapturedSqlResult {
  if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const source = value as object;
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== null && utilTypes.isProxy(prototype)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const constructorDescriptor = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "constructor");
  const constructorValue = constructorDescriptor && "value" in constructorDescriptor
    ? constructorDescriptor.value : null;
  if (typeof constructorValue === "function" && utilTypes.isProxy(constructorValue)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const nameDescriptor = typeof constructorValue === "function"
    ? Object.getOwnPropertyDescriptor(constructorValue, "name") : undefined;
  const constructorName = nameDescriptor && "value" in nameDescriptor &&
    typeof nameDescriptor.value === "string" ? nameDescriptor.value : null;
  if (prototype !== Object.prototype && prototype !== null && constructorName !== "Result") {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const allowedResultFields = new Set([
    "rows", "rowCount", "command", "oid", "fields", "_parsers", "_types",
    "RowCtor", "rowAsArray", "parseRow", "_prebuiltEmptyResultObject",
  ]);
  const keys = Reflect.ownKeys(source);
  const descriptors = Object.getOwnPropertyDescriptors(source);
  if (keys.some((key) => typeof key !== "string" || !allowedResultFields.has(key))) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new PaperTradeError("INVALID_REQUEST");
    }
  }
  const rowsDescriptor = descriptors.rows;
  const rowCountDescriptor = descriptors.rowCount;
  if (!rowsDescriptor || !("value" in rowsDescriptor) ||
      !rowCountDescriptor || !("value" in rowCountDescriptor)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const rows = plainDataSnapshot(rowsDescriptor.value);
  const rowCount = rowCountDescriptor.value;
  if (!Array.isArray(rows) ||
      (rowCount !== null && (typeof rowCount !== "number" || !Number.isSafeInteger(rowCount) || rowCount < 0)) ||
      (allowedRowLengths !== undefined && !allowedRowLengths.includes(rows.length))) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const expected = new Set(rowFields);
  for (const row of rows) {
    if (!record(row) || Object.keys(row).length !== expected.size ||
        Object.keys(row).some((key) => !expected.has(key))) {
      throw new PaperTradeError("INVALID_REQUEST");
    }
  }
  return Object.freeze({
    rows: rows as readonly Readonly<Record<string, unknown>>[],
    rowCount: rowCount as number | null,
  });
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function warningArray(value: unknown): value is WarningCode[] {
  return Array.isArray(value) && value.every((code) => WARNING_CODES.includes(code as WarningCode)) && new Set(value).size === value.length;
}
function trustedTenant(value: unknown): TrustedTenantContext {
  const snapshot = plainDataSnapshot(value);
  if (!record(snapshot) || Object.keys(snapshot).length !== 1 || !uuid(snapshot.userId)) throw new PaperTradeError("INVALID_REQUEST");
  return { userId: snapshot.userId };
}

const EXECUTION_FIELDS = new Set(["action", "warningsDefied"]);
const AUTHORIZATION_FIELDS = new Set(["intentId", "decision", "warningsShown"]);

function trustedAuthorization(value: unknown): TrustedExecutionAuthorization {
  const snapshot = plainDataSnapshot(value);
  if (!record(snapshot) || Object.keys(snapshot).length !== AUTHORIZATION_FIELDS.size ||
      Object.keys(snapshot).some((key) => !AUTHORIZATION_FIELDS.has(key)) ||
      !uuid(snapshot.intentId) ||
      (snapshot.decision !== "PASS" && snapshot.decision !== "WARN" && snapshot.decision !== "BLOCK") ||
      !warningArray(snapshot.warningsShown)) throw new PaperTradeError("INVALID_REQUEST");
  if ((snapshot.decision === "PASS" && snapshot.warningsShown.length !== 0) ||
      (snapshot.decision === "WARN" && snapshot.warningsShown.length === 0)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  return { intentId: snapshot.intentId, decision: snapshot.decision, warningsShown: [...snapshot.warningsShown] };
}

export async function executePaperTrade(
  raw: unknown,
  context: TrustedTenantContext,
  authorization: TrustedExecutionAuthorization,
  store: PaperExecutionStore,
): Promise<OpenExecutionResult> {
  const tenant = trustedTenant(context);
  const authorized = trustedAuthorization(authorization);
  if (authorized.decision === "BLOCK") throw new PaperTradeError("EXECUTION_BLOCKED");
  const request = plainDataSnapshot(raw);
  if (!record(request) || Object.keys(request).length !== EXECUTION_FIELDS.size ||
      Object.keys(request).some((key) => !EXECUTION_FIELDS.has(key))) throw new PaperTradeError("INVALID_REQUEST");
  if (
    (request.action !== "executed" && request.action !== "modified_then_executed") ||
    !warningArray(request.warningsDefied)
  ) throw new PaperTradeError("INVALID_REQUEST");
  const shown = new Set(authorized.warningsShown);
  if (request.warningsDefied.some((code) => !shown.has(code)) ||
      (request.action === "executed" && request.warningsDefied.length !== shown.size)) {
    throw new PaperTradeError("INVALID_WARNING_DEFIANCE");
  }
  try {
    const result = await store.openAtomic({
      userId: tenant.userId, intentId: authorized.intentId, action: request.action,
      warningsShown: [...authorized.warningsShown], warningsDefied: [...request.warningsDefied],
    });
    let captured: PlainData;
    try { captured = plainDataSnapshot(result); }
    catch { throw new PaperTradeError("PERSISTENCE_UNAVAILABLE"); }
    if (!record(captured) || Object.keys(captured).length !== 3 ||
        !uuid(captured.decisionId) || !uuid(captured.tradeId) || typeof captured.replayed !== "boolean") {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    }
    return { decisionId: captured.decisionId, tradeId: captured.tradeId, replayed: captured.replayed };
  } catch (error) {
    if (error instanceof PaperTradeError) throw error;
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
}

const CLOSE_FIELDS = new Set(["tradeId", "exitFill", "exitReason", "closedAt"]);
const OPEN_TRADE_FIELDS = new Set(["tradeId", "intentId", "userId", "direction", "entryFill", "size", "initialStop", "openedAt", "closedAt"]);
const CLOSED_OUTCOME_FIELDS = new Set(["tradeId", "intentId", "pnl", "rMultiple", "durationS", "exitFill", "exitReason"]);
const EXIT_REASONS = ["stop", "target", "manual", "timeout"] as const;
function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function computeClosure(
  untrustedRow: OpenTradeRecord,
  exitFill: number,
  exitReason: ExitReason,
  closedAt: string,
): ClosedTradeOutcome {
  const captured = plainDataSnapshot(untrustedRow);
  if (!record(captured) || Object.keys(captured).length !== OPEN_TRADE_FIELDS.size ||
      Object.keys(captured).some((key) => !OPEN_TRADE_FIELDS.has(key))) throw new PaperTradeError("INVALID_REQUEST");
  const row = captured;
  if (!positive(row.entryFill) || !positive(row.size) || !positive(exitFill) ||
      !uuid(row.tradeId) || !uuid(row.intentId) || !uuid(row.userId) ||
      (row.direction !== "long" && row.direction !== "short") || !instant(row.openedAt) || !instant(closedAt)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  if (row.initialStop === null || !positive(row.initialStop)) throw new PaperTradeError("INVALID_INITIAL_RISK");
  const initialRisk = Math.abs(row.entryFill - row.initialStop) * row.size;
  if (!Number.isFinite(initialRisk) || initialRisk <= 0) throw new PaperTradeError("INVALID_INITIAL_RISK");
  const durationS = (new Date(closedAt).getTime() - new Date(row.openedAt).getTime()) / 1000;
  if (!Number.isFinite(durationS) || durationS < 0) throw new PaperTradeError("INVALID_REQUEST");
  const direction = row.direction === "long" ? 1 : -1;
  const pnl = (exitFill - row.entryFill) * row.size * direction;
  const rMultiple = pnl / initialRisk;
  if (!Number.isFinite(pnl) || !Number.isFinite(rMultiple)) throw new PaperTradeError("INVALID_REQUEST");
  return { tradeId: row.tradeId, intentId: row.intentId, pnl, rMultiple, durationS, exitFill, exitReason };
}

export async function closePaperTrade(
  raw: unknown,
  context: TrustedTenantContext,
  store: PaperClosureStore,
): Promise<ClosedTradeOutcome> {
  const tenant = trustedTenant(context);
  const request = plainDataSnapshot(raw);
  if (!record(request) || Object.keys(request).length !== CLOSE_FIELDS.size ||
      Object.keys(request).some((key) => !CLOSE_FIELDS.has(key)) ||
      !uuid(request.tradeId) || !positive(request.exitFill) ||
      !EXIT_REASONS.includes(request.exitReason as ExitReason) || !instant(request.closedAt)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const tradeId = request.tradeId;
  const exitFill = request.exitFill;
  const exitReason = request.exitReason as ExitReason;
  const closedAt = request.closedAt;
  try {
    const outcome = await store.closeAtomic({
      userId: tenant.userId, tradeId, exitFill, exitReason, closedAt,
      compute: (row) => computeClosure(row, exitFill, exitReason, closedAt),
    });
    let captured: PlainData;
    try { captured = plainDataSnapshot(outcome); }
    catch { throw new PaperTradeError("PERSISTENCE_UNAVAILABLE"); }
    if (!record(captured) || Object.keys(captured).length !== CLOSED_OUTCOME_FIELDS.size ||
        Object.keys(captured).some((key) => !CLOSED_OUTCOME_FIELDS.has(key)) ||
        !uuid(captured.tradeId) || !uuid(captured.intentId) || typeof captured.pnl !== "number" || !Number.isFinite(captured.pnl) ||
        typeof captured.rMultiple !== "number" || !Number.isFinite(captured.rMultiple) ||
        typeof captured.durationS !== "number" || !Number.isFinite(captured.durationS) ||
        !positive(captured.exitFill) || !EXIT_REASONS.includes(captured.exitReason as ExitReason)) {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    }
    return {
      tradeId: captured.tradeId, intentId: captured.intentId, pnl: captured.pnl,
      rMultiple: captured.rMultiple, durationS: captured.durationS, exitFill: captured.exitFill,
      exitReason: captured.exitReason as ExitReason,
    };
  } catch (error) {
    if (error instanceof PaperTradeError) throw error;
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
}

export const ASSET_CLASSES = ["crypto", "equity", "forex", "futures", "options"] as const;
export const STRATEGIES = ["breakout_retest", "reversal", "momentum", "range", "trend_pullback", "news", "scalp", "other"] as const;
export const REGIMES = ["trending", "ranging", "volatile", "unknown"] as const;
const DIRECTIONS = ["long", "short"] as const;

type AssetClass = (typeof ASSET_CLASSES)[number];
type Strategy = (typeof STRATEGIES)[number];
type Regime = (typeof REGIMES)[number];
type Direction = (typeof DIRECTIONS)[number];

export interface ValidatedOutcome {
  tradeId: string;
  intentId: string;
  thesisRaw: string;
  rMultiple: number;
  asset: string;
  assetClass: AssetClass;
  direction: Direction;
  strategy: Strategy | null;
  regime: Regime;
}
interface AnecdoteEvidence { tier: "anecdote"; n: number; episodes: ValidatedOutcome[] }
interface StatisticalEvidence { tier: "signal" | "established"; n: number; wins: number; losses: number; rate: number; interval: Interval; averageR: number; episodes: ValidatedOutcome[] }
export type CohortEvidence = AnecdoteEvidence | StatisticalEvidence;

const OUTCOME_FIELDS = new Set(["tradeId", "intentId", "thesisRaw", "rMultiple", "asset", "assetClass", "direction", "strategy", "regime"]);
const CANONICAL_ASSET = /^[A-Z0-9][A-Z0-9._/-]{0,19}$/;

function outcomesFrom(untrusted: unknown): ValidatedOutcome[] {
  const input = plainDataSnapshot(untrusted);
  if (!record(input) || !Array.isArray(input.outcomes)) throw new PaperTradeError("INVALID_REQUEST");
  const tradeIds = new Set<string>();
  const intentIds = new Set<string>();
  return input.outcomes.map((item) => {
    if (!record(item) || Object.keys(item).length !== OUTCOME_FIELDS.size ||
        Object.keys(item).some((key) => !OUTCOME_FIELDS.has(key)) ||
        !uuid(item.tradeId) || !uuid(item.intentId) || tradeIds.has(item.tradeId) || intentIds.has(item.intentId) ||
        typeof item.thesisRaw !== "string" || item.thesisRaw.trim().length === 0 || item.thesisRaw !== item.thesisRaw.trim() ||
        typeof item.rMultiple !== "number" || !Number.isFinite(item.rMultiple) ||
        typeof item.asset !== "string" || !CANONICAL_ASSET.test(item.asset) ||
        !ASSET_CLASSES.includes(item.assetClass as AssetClass) || !DIRECTIONS.includes(item.direction as Direction) ||
        (item.strategy !== null && !STRATEGIES.includes(item.strategy as Strategy)) ||
        !REGIMES.includes(item.regime as Regime)) throw new PaperTradeError("INVALID_REQUEST");
    tradeIds.add(item.tradeId);
    intentIds.add(item.intentId);
    return {
      tradeId: item.tradeId, intentId: item.intentId, thesisRaw: item.thesisRaw, rMultiple: item.rMultiple,
      asset: item.asset, assetClass: item.assetClass as AssetClass, direction: item.direction as Direction,
      strategy: item.strategy as Strategy | null, regime: item.regime as Regime,
    };
  });
}

function finiteAverage(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  const average = sum / values.length;
  if (!Number.isFinite(sum) || !Number.isFinite(average)) throw new PaperTradeError("INVALID_REQUEST");
  return average;
}

export function recomputeCohortEvidence(input: unknown): CohortEvidence {
  const outcomes = outcomesFrom(input); const n = outcomes.length; const tier = tierFor(n);
  if (tier === "anecdote") return { tier, n, episodes: outcomes.slice(0, 3) };
  const wins = outcomes.filter((row) => row.rMultiple > 0).length;
  const rate = wins / n;
  const interval = wilson(wins, n);
  const averageR = finiteAverage(outcomes.map((row) => row.rMultiple));
  if (averageR === null || !Number.isFinite(rate) || !Number.isFinite(interval.low) || !Number.isFinite(interval.high)) throw new PaperTradeError("INVALID_REQUEST");
  return { tier, n, wins, losses: n - wins, rate, interval, averageR, episodes: outcomes };
}

const PATTERN_KINDS = ["strategy", "behavioral", "asset", "risk", "execution", "conditional"] as const;
type PatternKind = (typeof PATTERN_KINDS)[number];
export interface CohortFilter {
  asset?: string;
  assetClass?: AssetClass;
  direction?: Direction;
  strategy?: Strategy;
  regime?: Regime;
}
export interface PatternCandidate { kind: PatternKind; statement: string; n: number; wins: number; losses: number; rate: number; interval: Interval; effectSize: number; tier: Exclude<EvidenceTier, "anecdote">; filter: CohortFilter; sourceTradeIds: string[] }
const FILTER_FIELDS = new Set(["asset", "assetClass", "direction", "strategy", "regime"]);
function validatedFilter(untrusted: unknown): CohortFilter {
  const value = plainDataSnapshot(untrusted);
  if (!record(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Reflect.ownKeys(value).some((key) => typeof key !== "string" || !FILTER_FIELDS.has(key))) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  if (("asset" in value && (typeof value.asset !== "string" || !CANONICAL_ASSET.test(value.asset))) ||
      ("assetClass" in value && !ASSET_CLASSES.includes(value.assetClass as AssetClass)) ||
      ("direction" in value && !DIRECTIONS.includes(value.direction as Direction)) ||
      ("strategy" in value && !STRATEGIES.includes(value.strategy as Strategy)) ||
      ("regime" in value && !REGIMES.includes(value.regime as Regime))) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const clone: CohortFilter = {};
  if ("asset" in value) clone.asset = value.asset as string;
  if ("assetClass" in value) clone.assetClass = value.assetClass as AssetClass;
  if ("direction" in value) clone.direction = value.direction as Direction;
  if ("strategy" in value) clone.strategy = value.strategy as Strategy;
  if ("regime" in value) clone.regime = value.regime as Regime;
  return clone;
}
function matchesFilter(outcome: ValidatedOutcome, filter: CohortFilter): boolean {
  return (filter.asset === undefined || outcome.asset === filter.asset) &&
    (filter.assetClass === undefined || outcome.assetClass === filter.assetClass) &&
    (filter.direction === undefined || outcome.direction === filter.direction) &&
    (filter.strategy === undefined || outcome.strategy === filter.strategy) &&
    (filter.regime === undefined || outcome.regime === filter.regime);
}
export function createPatternCandidate(untrusted: unknown): PatternCandidate | null {
  const input = plainDataSnapshot(untrusted);
  if (!record(input) || typeof input.baselineRate !== "number" || !Number.isFinite(input.baselineRate) || input.baselineRate < 0 || input.baselineRate > 1 || !PATTERN_KINDS.includes(input.kind as PatternKind)) throw new PaperTradeError("INVALID_REQUEST");
  const filter = validatedFilter(input.filter);
  const outcomes = outcomesFrom({ outcomes: input.outcomes }).filter((row) => matchesFilter(row, filter));
  const n = outcomes.length;
  const wins = outcomes.filter((row) => row.rMultiple > 0).length;
  const cohort = { n, wins, losses: n - wins, rate: n ? wins / n : null, interval: wilson(wins, n), tier: tierFor(n), avgR: null };
  if (!qualifiesAsPattern(cohort, input.baselineRate)) return null;
  const derivedEffect = effectSize(cohort, input.baselineRate);
  if (cohort.rate === null || !Number.isFinite(cohort.rate) || !Number.isFinite(cohort.interval.low) ||
      !Number.isFinite(cohort.interval.high) || !Number.isFinite(derivedEffect)) throw new PaperTradeError("INVALID_REQUEST");
  return { kind: input.kind as PatternKind, statement: `This filtered cohort is associated with a ${cohort.rate >= input.baselineRate ? "higher" : "lower"} win rate than the trader baseline.`, n, wins, losses: n - wins, rate: cohort.rate, interval: cohort.interval, effectSize: derivedEffect, tier: cohort.tier as Exclude<EvidenceTier, "anecdote">, filter, sourceTradeIds: outcomes.map((row) => row.tradeId) };
}

const CANDIDATE_FIELDS = new Set([
  "kind", "statement", "n", "wins", "losses", "rate", "interval", "effectSize",
  "tier", "filter", "sourceTradeIds",
]);
export function validatePatternCandidate(untrusted: unknown): PatternCandidate {
  const value = plainDataSnapshot(untrusted);
  if (!record(value) || Object.keys(value).length !== CANDIDATE_FIELDS.size ||
      Object.keys(value).some((key) => !CANDIDATE_FIELDS.has(key)) ||
      !PATTERN_KINDS.includes(value.kind as PatternKind) || typeof value.statement !== "string" ||
      !Number.isSafeInteger(value.n) || (value.n as number) < 8 ||
      !Number.isSafeInteger(value.wins) || (value.wins as number) < 0 ||
      !Number.isSafeInteger(value.losses) || (value.losses as number) < 0 ||
      (value.wins as number) + (value.losses as number) !== value.n ||
      typeof value.rate !== "number" || !Number.isFinite(value.rate) || value.rate !== (value.wins as number) / (value.n as number) ||
      !record(value.interval) || Object.keys(value.interval).length !== 2 ||
      typeof value.interval.low !== "number" || typeof value.interval.high !== "number" ||
      !Number.isFinite(value.interval.low) || !Number.isFinite(value.interval.high) ||
      value.interval.low < 0 || value.interval.high > 1 || value.interval.low > value.interval.high ||
      typeof value.effectSize !== "number" || !Number.isFinite(value.effectSize) || value.effectSize === 0 ||
      (value.tier !== "signal" && value.tier !== "established") || value.tier !== tierFor(value.n as number) ||
      !Array.isArray(value.sourceTradeIds) || value.sourceTradeIds.length !== value.n ||
      value.sourceTradeIds.some((id) => !uuid(id)) || new Set(value.sourceTradeIds).size !== value.sourceTradeIds.length) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const expectedInterval = wilson(value.wins as number, value.n as number);
  const baselineRate = value.rate - value.effectSize;
  const expectedStatement = `This filtered cohort is associated with a ${value.effectSize > 0 ? "higher" : "lower"} win rate than the trader baseline.`;
  if (!Number.isFinite(baselineRate) || baselineRate < 0 || baselineRate > 1 ||
      value.interval.low !== expectedInterval.low || value.interval.high !== expectedInterval.high ||
      !qualifiesAsPattern({ n: value.n as number, wins: value.wins as number, losses: value.losses as number,
        rate: value.rate, interval: expectedInterval, tier: value.tier, avgR: null }, baselineRate) ||
      value.statement !== expectedStatement) throw new PaperTradeError("INVALID_REQUEST");
  return {
    kind: value.kind as PatternKind, statement: value.statement, n: value.n as number,
    wins: value.wins as number, losses: value.losses as number, rate: value.rate,
    interval: { low: value.interval.low, high: value.interval.high }, effectSize: value.effectSize,
    tier: value.tier, filter: validatedFilter(value.filter), sourceTradeIds: value.sourceTradeIds.map((id) => id as string),
  };
}

export interface WarningAuditRow { code: WarningCode; timesShown: number; timesHeeded: number; timesDefied: number; rWhenHeeded: number | null; rWhenDefied: number | null }
const WARNING_OBSERVATION_FIELDS = new Set(["tradeId", "code", "shown", "defied", "rMultiple"]);
export function recomputeWarningAudit(untrusted: unknown): WarningAuditRow[] {
  const input = plainDataSnapshot(untrusted);
  if (!Array.isArray(input)) throw new PaperTradeError("INVALID_REQUEST");
  const grouped = new Map<WarningCode, { shown: number; heeded: number[]; defied: number[] }>(); const seen = new Set<string>();
  for (const item of input) {
    if (!record(item) || Object.keys(item).length !== WARNING_OBSERVATION_FIELDS.size ||
        Object.keys(item).some((key) => !WARNING_OBSERVATION_FIELDS.has(key)) ||
        !uuid(item.tradeId) || !WARNING_CODES.includes(item.code as WarningCode) || typeof item.shown !== "boolean" || typeof item.defied !== "boolean" || typeof item.rMultiple !== "number" || !Number.isFinite(item.rMultiple) || !item.shown) throw new PaperTradeError("INVALID_REQUEST");
    const key = `${item.tradeId}:${item.code}`; if (seen.has(key)) throw new PaperTradeError("INVALID_REQUEST"); seen.add(key);
    const code = item.code as WarningCode; const group = grouped.get(code) ?? { shown: 0, heeded: [], defied: [] }; group.shown++; (item.defied ? group.defied : group.heeded).push(item.rMultiple); grouped.set(code, group);
  }
  return [...grouped].map(([code, group]) => ({ code, timesShown: group.shown, timesHeeded: group.heeded.length, timesDefied: group.defied.length, rWhenHeeded: finiteAverage(group.heeded), rWhenDefied: finiteAverage(group.defied) }));
}

const AUDIT_FIELDS = new Set(["code", "timesShown", "timesHeeded", "timesDefied", "rWhenHeeded", "rWhenDefied"]);
export function validateWarningAuditRows(untrusted: unknown): WarningAuditRow[] {
  const input = plainDataSnapshot(untrusted);
  if (!Array.isArray(input)) throw new PaperTradeError("INVALID_REQUEST");
  const seen = new Set<WarningCode>();
  return input.map((item) => {
    if (!record(item) || Object.keys(item).length !== AUDIT_FIELDS.size ||
        Object.keys(item).some((key) => !AUDIT_FIELDS.has(key)) ||
        !WARNING_CODES.includes(item.code as WarningCode) || seen.has(item.code as WarningCode) ||
        !Number.isSafeInteger(item.timesShown) || (item.timesShown as number) < 0 ||
        !Number.isSafeInteger(item.timesHeeded) || (item.timesHeeded as number) < 0 ||
        !Number.isSafeInteger(item.timesDefied) || (item.timesDefied as number) < 0 ||
        (item.timesHeeded as number) + (item.timesDefied as number) !== item.timesShown ||
        !validBranchAverage(item.rWhenHeeded, item.timesHeeded as number) ||
        !validBranchAverage(item.rWhenDefied, item.timesDefied as number)) throw new PaperTradeError("INVALID_REQUEST");
    const code = item.code as WarningCode;
    seen.add(code);
    return {
      code, timesShown: item.timesShown as number, timesHeeded: item.timesHeeded as number,
      timesDefied: item.timesDefied as number, rWhenHeeded: item.rWhenHeeded as number | null,
      rWhenDefied: item.rWhenDefied as number | null,
    };
  });
}
function validBranchAverage(value: unknown, count: number): boolean {
  return count === 0 ? value === null : typeof value === "number" && Number.isFinite(value);
}

export interface PaperMemoryStore {
  loadClosedOutcomes(userId: string): Promise<unknown>;
  loadWarningObservations(userId: string): Promise<unknown>;
  persistMemoryAtomic(userId: string, candidate: PatternCandidate | null, audit: readonly WarningAuditRow[]): Promise<void>;
}
export interface PaperMemoryRefreshResult {
  evidence: CohortEvidence;
  candidate: PatternCandidate | null;
  warningAudit: WarningAuditRow[];
}
const REFRESH_FIELDS = new Set(["kind", "filter", "baselineRate"]);
export async function refreshPaperMemory(
  rawRequest: unknown,
  context: TrustedTenantContext,
  store: PaperMemoryStore,
): Promise<PaperMemoryRefreshResult> {
  const tenant = trustedTenant(context);
  const request = plainDataSnapshot(rawRequest);
  if (!record(request) || Object.keys(request).length !== REFRESH_FIELDS.size ||
      Object.keys(request).some((key) => !REFRESH_FIELDS.has(key)) ||
      !PATTERN_KINDS.includes(request.kind as PatternKind) ||
      typeof request.baselineRate !== "number" || !Number.isFinite(request.baselineRate) ||
      request.baselineRate < 0 || request.baselineRate > 1) throw new PaperTradeError("INVALID_REQUEST");
  const filter = validatedFilter(request.filter);
  try {
    const [storedOutcomes, storedObservations] = await Promise.all([
      store.loadClosedOutcomes(tenant.userId),
      store.loadWarningObservations(tenant.userId),
    ]);
    const validatedOutcomes = outcomesFrom({ outcomes: storedOutcomes });
    const filteredOutcomes = validatedOutcomes.filter((outcome) => matchesFilter(outcome, filter));
    const evidence = recomputeCohortEvidence({ outcomes: filteredOutcomes });
    const candidate = createPatternCandidate({
      outcomes: validatedOutcomes, kind: request.kind, baselineRate: request.baselineRate, filter,
    });
    const warningAudit = recomputeWarningAudit(storedObservations);
    const persistedCandidate = candidate === null ? null : plainDataSnapshot(candidate) as unknown as PatternCandidate;
    const persistedAudit = plainDataSnapshot(warningAudit) as unknown as readonly WarningAuditRow[];
    await store.persistMemoryAtomic(tenant.userId, persistedCandidate, persistedAudit);
    return plainDataSnapshot({ evidence, candidate, warningAudit }) as unknown as PaperMemoryRefreshResult;
  } catch {
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
}
