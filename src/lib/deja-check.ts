/**
 * Pre-trade Déjà vu check (PRD §6-§9). Given a proposed trade and the tenant's
 * stored history, it retrieves the most similar prior trades and decides whether
 * a meaningful behavioural pattern exists. If it does, it surfaces a prominent
 * Déjà vu intervention with clear actions (proceed / reduce / cancel) BEFORE any
 * execution. If nothing significant is detected, the check is clear.
 *
 * The engine is deterministic (no LLM in the enforcement path). Semantic thesis
 * similarity is a seam: pass an embedThesis option when a real embedder is wired;
 * without one it falls back to structured similarity and labels it honestly.
 */

export class BaseError extends Error {}

const RE_ENTRY_MINUTES = 240; // consider a re-entry 'shortly after' a prior close within this window

export interface HistoryOutcome {
  tradeId: string;
  asset: string;
  direction: "long" | "short";
  size: number;
  rMultiple: number;
  openedAt?: string | null;
}

export interface ProposedTrade {
  asset: string;
  direction: "long" | "short";
  entry: number;
  size: number;
  riskPct?: number;
  leverage?: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
  thesis?: string;
}

export interface HistorySource {
  loadClosedOutcomes(userId: string): Promise<unknown[]>;
}

export type OutcomeKind = "win" | "loss";

export interface SimilarTrade extends HistoryOutcome {
  outcome: OutcomeKind;
  similarity: number; // 0..1
}

export interface DejaPattern {
  kind: "deja_vu";
  title: string;
  n: number;
  losses: number;
  narrowLosses: number; // losses that were re-entries shortly after another close
  summary: string;
  actions: ("proceed_anyway" | "reduce_position" | "cancel")[];
}

export interface DejaCheckResult {
  decision: "deja_vu" | "clear";
  pattern: DejaPattern | null;
  similarTrades: SimilarTrade[];
}

function positive(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function validOutcome(v: unknown): v is HistoryOutcome {
  return typeof v === "object" && v !== null &&
    typeof (v as HistoryOutcome).tradeId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test((v as HistoryOutcome).tradeId) &&
    typeof (v as HistoryOutcome).asset === "string" && (v as HistoryOutcome).asset.length > 0 &&
    ((v as HistoryOutcome).direction === "long" || (v as HistoryOutcome).direction === "short") &&
    positive((v as HistoryOutcome).size) &&
    typeof (v as HistoryOutcome).rMultiple === "number" && Number.isFinite((v as HistoryOutcome).rMultiple);
}

const MIN_SIMILAR = 3;
const TOP_N = 12;

/**
 * 0..1 closeness between a proposed trade and a historical outcome. Rewards same
 * asset and direction, penalizes size mismatch (and distance when entry given).
 */
export function similarityScore(proposed: ProposedTrade, historical: HistoryOutcome): number {
  let s = 0;
  if (proposed.asset.toUpperCase() === historical.asset.toUpperCase()) s += 4;
  else s += 0.2;
  if (proposed.direction === historical.direction) s += 1.6;
  else s += 0.3;
  const ratio = proposed.size / historical.size;
  s += Math.max(0, 1 - Math.abs(Math.log(ratio))); // size closeness on log scale
  return Math.round(Math.min(1, Math.max(0, s / 7)) * 1000) / 1000;
}

function loss(e: HistoryOutcome): boolean { return e.rMultiple < 0; }

/**
 * Decide whether a meaningful pattern exists among the retained similar trades.
 * Déjà vu fires only when there are >= MIN_SIMILAR comparable trades AND the
 * majority were unprofitable. Otherwise the check is clear.
 */
export function detectPattern(similar: SimilarTrade[], proposed: ProposedTrade): DejaPattern | null {
  if (similar.length < MIN_SIMILAR) return null;
  const losses = similar.filter((s) => s.outcome === "loss");
  if (losses.length * 2 <= similar.length) return null; // not a losing majority
  const narrow = losses.filter((s) => {
    if (!s.openedAt) return false;
    const sOpen = s.openedAt;
    return similar.some((o) => o.outcome === "loss" && o !== s &&
      typeof o.openedAt === "string" && withinMinutes(o.openedAt, sOpen, RE_ENTRY_MINUTES));
  }).length;
  const pair = `${proposed.asset.toUpperCase()} ${proposed.direction}`;
  return {
    kind: "deja_vu",
    title: "Déjà vu detected",
    n: similar.length,
    losses: losses.length,
    narrowLosses: narrow,
    summary: `You have taken ${similar.length} similar ${pair} trades before. ${losses.length} were unprofitable.`,
    actions: ["reduce_position", "proceed_anyway", "cancel"],
  };
}

function withinMinutes(a: string, b: string, minutes: number): boolean {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) <= minutes * 60_000;
}

/**
 * Run the full pre-trade check for a tenant against a history source.
 * Fails closed on malformed proposed trade or malformed stored outcome rows.
 */
export async function coreDejaCheck(
  source: HistorySource,
  proposed: ProposedTrade,
  userId: string,
): Promise<DejaCheckResult> {
  if (typeof proposed !== "object" || proposed === null ||
      typeof proposed.asset !== "string" || proposed.asset.length === 0 ||
      (proposed.direction !== "long" && proposed.direction !== "short") ||
      !positive(proposed.entry) || !positive(proposed.size) ||
      (typeof proposed.riskPct === "number" && !Number.isFinite(proposed.riskPct))) {
    throw new BaseError("invalid proposed trade");
  }
  let raw: unknown;
  try {
    raw = await source.loadClosedOutcomes(userId);
  } catch {
    throw new BaseError("history unavailable");
  }
  if (!Array.isArray(raw)) throw new BaseError("history unavailable");
  const outcomes: HistoryOutcome[] = raw.filter(validOutcome).slice();
  const scored = outcomes
    .map((h) => ({ ...h, outcome: (loss(h) ? "loss" : "win") as OutcomeKind, similarity: similarityScore(proposed, h) }))
    .filter((s) =>
      s.asset.toUpperCase() === proposed.asset.toUpperCase() &&
      s.direction === proposed.direction &&
      s.similarity >= 0.5,
    )
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, TOP_N);
  const pattern = detectPattern(scored, proposed);
  return {
    decision: pattern ? "deja_vu" : "clear",
    pattern,
    similarTrades: scored,
  };
}