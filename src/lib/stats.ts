/**
 * The credibility layer. See PRD §5.
 *
 * "12 similar trades, 7W/5L, 58% win rate" is not a finding — the 95% interval
 * on 7/12 spans roughly 28%-85%, which cannot distinguish a good strategy from
 * a coin flip. Every statistic Deja renders passes through here first, and the
 * tier it returns governs what the agent is permitted to say.
 *
 * This is a feature, not a hedge: an agent that knows the limits of its own
 * memory is the strongest demonstration of memory design we can make.
 */

export type EvidenceTier = "anecdote" | "signal" | "established";

export const TIER_THRESHOLDS = { signal: 8, established: 30 } as const;

export function tierFor(n: number): EvidenceTier {
  if (n >= TIER_THRESHOLDS.established) return "established";
  if (n >= TIER_THRESHOLDS.signal) return "signal";
  return "anecdote";
}

export interface Interval {
  low: number;
  high: number;
}

/**
 * Wilson score interval. Chosen over the normal approximation because it stays
 * sane at small n and near 0 or 1 — exactly the conditions a new trader's
 * history is in, and where the naive interval is most misleading.
 */
export function wilson(wins: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { low: 0, high: 1 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

export interface Cohort {
  n: number;
  wins: number;
  losses: number;
  rate: number | null;
  interval: Interval;
  tier: EvidenceTier;
  avgR: number | null;
}

export function summarize(outcomes: { win: boolean; r?: number | null }[]): Cohort {
  const n = outcomes.length;
  const wins = outcomes.filter((o) => o.win).length;
  const rs = outcomes.map((o) => o.r).filter((r): r is number => typeof r === "number");
  return {
    n,
    wins,
    losses: n - wins,
    rate: n > 0 ? wins / n : null,
    interval: wilson(wins, n),
    tier: tierFor(n),
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
  };
}

/**
 * Whether a cohort may be promoted to a stored `patterns` row.
 *
 * Requires enough observations to leave the anecdote tier *and* an interval
 * that excludes the trader's own baseline — otherwise we would be storing the
 * fact that some cohorts differ from others by chance, which every dataset
 * contains and none of which is worth telling anyone.
 */
export function qualifiesAsPattern(cohort: Cohort, baselineRate: number): boolean {
  if (cohort.n < TIER_THRESHOLDS.signal) return false;
  return cohort.interval.high < baselineRate || cohort.interval.low > baselineRate;
}

/** Signed distance from baseline; negative means the cohort underperforms. */
export function effectSize(cohort: Cohort, baselineRate: number): number {
  return cohort.rate === null ? 0 : cohort.rate - baselineRate;
}

/**
 * The single place that decides how a cohort may be described. Callers render
 * this rather than formatting percentages themselves, so it is impossible for
 * a thin cohort to reach the UI wearing a confident number.
 */
export function renderable(cohort: Cohort): {
  tier: EvidenceTier;
  mayStatePercentage: boolean;
  mayAssert: boolean;
  caveat: string;
} {
  switch (cohort.tier) {
    case "established":
      return {
        tier: "established",
        mayStatePercentage: true,
        mayAssert: true,
        caveat: `Based on ${cohort.n} trades.`,
      };
    case "signal":
      return {
        tier: "signal",
        mayStatePercentage: true,
        mayAssert: false,
        caveat:
          `Based on ${cohort.n} trades — treat as a lean, not a law. ` +
          `True rate is somewhere between ${pct(cohort.interval.low)} and ${pct(cohort.interval.high)}.`,
      };
    default:
      return {
        tier: "anecdote",
        mayStatePercentage: false,
        mayAssert: false,
        caveat:
          `Only ${cohort.n} comparable trade${cohort.n === 1 ? "" : "s"}. ` +
          `That is an anecdote, not a pattern — here is what actually happened instead of a percentage.`,
      };
  }
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * Deja observes only trades that were taken, never the ones skipped, and cannot
 * separate a behaviour from the market regime it occurred in. Every surface
 * that shows a pattern shows this too.
 */
export const CAUSATION_NOTE =
  "Deja reports association, not cause. It only sees trades you took, not the " +
  "ones you skipped, and cannot separate a habit from the conditions it happened in.";
