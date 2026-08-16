import {
  PaperTradeError,
  recomputeCohortEvidence,
  recomputeWarningAudit,
  validatePatternCandidate,
  WARNING_CODES,
  type CohortEvidence,
  type PatternCandidate,
  type TrustedTenantContext,
  type ValidatedOutcome,
  type WarningAuditRow,
  type WarningCode,
} from "./paper-trade";
import type { EvidenceTier } from "./stats";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read seam for the derived insights views. Tenant id is passed by the caller only. */
export interface InsightsStore {
  loadClosedOutcomes(userId: string): Promise<unknown>;
  loadWarningObservations(userId: string): Promise<unknown>;
  listPatternCandidates(userId: string): Promise<unknown>;
}

export interface DnaEpisode {
  tradeId: string;
  thesisRaw: string;
  rMultiple: number;
  asset: string;
}

export interface DnaRow {
  strategy: string | null;
  n: number;
  tier: EvidenceTier;
  wins: number | null;
  losses: number | null;
  rate: number | null;
  averageR: number | null;
  caveat: string;
  episodes: DnaEpisode[];
}

export interface WarningLedgerRow extends WarningAuditRow {
  defiedWithWin: number;
  defiedWithLoss: number;
}

export interface InsightsView {
  dna: DnaRow[];
  patterns: PatternCandidate[];
  warnings: WarningLedgerRow[];
}

/** Descriptor-safe plain-data snapshot producing a deep-frozen detached copy. */
function snapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const source = value as object;
  if (Array.isArray(source)) {
    const copy: unknown[] = [];
    for (let index = 0; index < source.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new PaperTradeError("INVALID_REQUEST");
      copy.push(snapshot(descriptor.value));
    }
    return Object.freeze(copy);
  }
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) throw new PaperTradeError("INVALID_REQUEST");
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") throw new PaperTradeError("INVALID_REQUEST");
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new PaperTradeError("INVALID_REQUEST");
    copy[key] = snapshot(descriptor.value);
  }
  return Object.freeze(copy);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function trustedTenant(value: unknown): TrustedTenantContext {
  const captured = snapshot(value);
  if (!record(captured) || Object.keys(captured).length !== 1 || !uuid(captured.userId)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  return { userId: captured.userId };
}

/**
 * Build the evidence-tiered Trading DNA and warning self-audit views purely
 * from the tenant's stored closed outcomes, stored warning observations, and
 * already-qualified pattern candidates. Every statistic carries its cohort n;
 * anecdote cohorts render raw episodes and a caveat, never a percentage.
 * Persistence or malformed-store failures fail closed to a sanitized error.
 */
export async function buildInsightsView(
  context: TrustedTenantContext,
  store: InsightsStore,
): Promise<InsightsView> {
  const tenant = trustedTenant(context);
  let outcomes: unknown;
  let observations: unknown;
  let patterns: unknown;
  try {
    [outcomes, observations, patterns] = await Promise.all([
      store.loadClosedOutcomes(tenant.userId),
      store.loadWarningObservations(tenant.userId),
      store.listPatternCandidates(tenant.userId),
    ]);
  } catch {
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
  const dna = deriveDna(outcomes);
  const warnings = deriveWarnings(observations);
  const candidateRows = derivePatterns(patterns);
  return snapshot({ dna, patterns: candidateRows, warnings }) as unknown as InsightsView;
}

function derivePatterns(untrusted: unknown): PatternCandidate[] {
  if (!Array.isArray(untrusted)) throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  let captured: unknown;
  try {
    captured = snapshot(untrusted);
  } catch {
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
  const rows: PatternCandidate[] = [];
  try {
    for (const item of captured as unknown[]) {
      rows.push(validatePatternCandidate(item));
    }
  } catch {
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
  return snapshot(rows) as unknown as PatternCandidate[];
}

/**
 * Per-strategy evidence cohort rows derived only from the supplied outcomes.
 * A small cohort exposes raw episodes and a caveat instead of a percentage.
 */
export function deriveDna(untrustedOutcomes: unknown): DnaRow[] {
  let evidence: CohortEvidence;
  try {
    evidence = recomputeCohortEvidence({ outcomes: untrustedOutcomes });
  } catch {
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
  const grouped = new Map<string | null, ValidatedOutcome[]>();
  for (const outcome of evidence.episodes) {
    const list = grouped.get(outcome.strategy) ?? [];
    list.push(outcome);
    grouped.set(outcome.strategy, list);
  }
  const rows: DnaRow[] = [];
  for (const [strategy, outcomesForStrategy] of grouped) {
    const cohort = recomputeCohortEvidence({ outcomes: outcomesForStrategy });
    rows.push(toDnaRow(strategy, cohort));
  }
  rows.sort((a, b) => (a.strategy ?? "").localeCompare(b.strategy ?? ""));
  return snapshot(rows) as unknown as DnaRow[];
}

export function toDnaRow(strategy: string | null, cohort: CohortEvidence): DnaRow {
  const episodes: DnaEpisode[] = cohort.episodes.map((episode) => ({
    tradeId: episode.tradeId,
    thesisRaw: episode.thesisRaw,
    rMultiple: episode.rMultiple,
    asset: episode.asset,
  }));
  const base: DnaRow = {
    strategy,
    n: cohort.n,
    tier: cohort.tier,
    wins: null,
    losses: null,
    rate: null,
    averageR: null,
    caveat: "",
    episodes,
  };
  if (cohort.tier === "anecdote") {
    base.caveat = `Only ${cohort.n} comparable trade${cohort.n === 1 ? "" : "s"} for ${strategy ?? "no strategy"}. ` +
      `That's an anecdote, not a pattern — here is what happened instead of a percentage.`;
    return base;
  }
  base.wins = cohort.wins;
  base.losses = cohort.losses;
  base.rate = cohort.rate;
  base.averageR = cohort.averageR as number;
  base.caveat = `Based on ${cohort.n} trades — an ${cohort.tier} evidence tier.`;
  return base;
}

const OBSERVATION_FIELDS = new Set(["tradeId", "code", "shown", "defied", "rMultiple"]);

interface ValidatedObservation {
  code: WarningCode;
  defied: boolean;
  rMultiple: number;
}

function parseObservations(untrusted: unknown): ValidatedObservation[] {
  const captured = snapshot(untrusted ?? []);
  if (!Array.isArray(captured)) throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  const seen = new Set<string>();
  const rows: ValidatedObservation[] = [];
  for (const item of captured) {
    if (!record(item) || Object.keys(item).length !== OBSERVATION_FIELDS.size ||
        Object.keys(item).some((key) => !OBSERVATION_FIELDS.has(key)) ||
        !uuid(item.tradeId) ||
        !WARNING_CODES.includes(item.code as WarningCode) ||
        typeof item.shown !== "boolean" || item.shown !== true ||
        typeof item.defied !== "boolean" ||
        typeof item.rMultiple !== "number" || !Number.isFinite(item.rMultiple)) {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    }
    const key = `${item.tradeId}:${item.code}`;
    if (seen.has(key)) throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    seen.add(key);
    rows.push({ code: item.code as WarningCode, defied: item.defied, rMultiple: item.rMultiple });
  }
  return rows;
}

/**
 * Warning-compliance ledger: shown / heeded / defied plus a win-loss split
 * only for the *defied* branch, all derived from the tenant's stored
 * observation rows. The audit rows are reused from the shared
 * recomputeWarningAudit so counts cannot drift from the stored records.
 */
export function deriveWarnings(untrustedObservations: unknown): WarningLedgerRow[] {
  let audit: WarningAuditRow[];
  try {
    audit = recomputeWarningAudit(untrustedObservations);
  } catch {
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
  const observations = parseObservations(untrustedObservations);
  const defiedLossByCode = new Map<WarningCode, number>();
  const defiedWinByCode = new Map<WarningCode, number>();
  for (const observation of observations) {
    if (!observation.defied) continue;
    const { code, rMultiple } = observation;
    if (rMultiple > 0) defiedWinByCode.set(code, (defiedWinByCode.get(code) ?? 0) + 1);
    else defiedLossByCode.set(code, (defiedLossByCode.get(code) ?? 0) + 1);
  }
  const rows: WarningLedgerRow[] = audit.map((row) => ({
    ...row,
    defiedWithWin: defiedWinByCode.get(row.code) ?? 0,
    defiedWithLoss: defiedLossByCode.get(row.code) ?? 0,
  }));
  return snapshot(rows) as unknown as WarningLedgerRow[];
}