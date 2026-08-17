import { tierFor, type EvidenceTier } from "./stats";
import { type HistoryOutcome } from "./deja-check";

/**
 * Trading DNA behavioural patterns (PRD §11). Derived only from the tenant's
 * complete stored cohort of outcomes, with evidence tiers so a thin cohort shows
 * episodes/anecdote rather than an overconfident claim. Includes BOTH negative
 * patterns (re-entry after loss, poor directional performance, oversizing after
 * loss) and positive ones (a setup that reliably profits). No conclusion from a
 * single trade.
 */

export interface DnaPattern {
  id: string;
  kind: "negative" | "positive";
  title: string;
  n: number;
  tier: EvidenceTier;
  detail: string;
}

const MIN_COHORT = 3;
const RE_ENTRY_MINUTES = 240;
const WIN_RATE_NEGATIVE = 0.45;
const WIN_RATE_POSITIVE = 0.6;
const OVERSIZE_MULT = 1.2;

function isLoss(o: HistoryOutcome): boolean { return o.rMultiple < 0; }
function winRate(wins: number, n: number): number { return n === 0 ? 0 : wins / n; }
function avgR(outcomes: HistoryOutcome[]): number {
  if (outcomes.length === 0) return 0;
  return outcomes.reduce((s, o) => s + o.rMultiple, 0) / outcomes.length;
}

export function deriveDnaPatterns(outcomes: HistoryOutcome[]): DnaPattern[] {
  const patterns: DnaPattern[] = [];
  const valid = outcomes.filter((o) => Number.isFinite(o.rMultiple));

  // 1. Directional cohorts: per asset+direction.
  const byPair = new Map<string, HistoryOutcome[]>();
  for (const o of valid) {
    const k = `${o.asset.toUpperCase()} ${o.direction}`;
    const list = byPair.get(k) ?? [];
    list.push(o);
    byPair.set(k, list);
  }
  for (const [pair, cohort] of byPair) {
    if (cohort.length < MIN_COHORT) continue;
    const wins = cohort.filter((o) => !isLoss(o)).length;
    const rate = winRate(wins, cohort.length);
    const ar = avgR(cohort);
    const tier = tierFor(cohort.length);
    if (rate < WIN_RATE_NEGATIVE) {
      patterns.push({
        id: `pair-neg-${pair.replace(/\s+/g, "-").toLowerCase()}`,
        kind: "negative",
        title: `${pair} has been a losing setup for you`,
        n: cohort.length,
        tier,
        detail: `${cohort.length - wins} of ${cohort.length} ${pair} trades were unprofitable (${Math.round(rate * 100)}% win rate, avg R ${ar.toFixed(2)}).`,
      });
    } else if (rate > WIN_RATE_POSITIVE && ar > 0) {
      patterns.push({
        id: `pair-pos-${pair.replace(/\s+/g, "-").toLowerCase()}`,
        kind: "positive",
        title: `${pair} has been a reliable setup for you`,
        n: cohort.length,
        tier,
        detail: `${wins} of ${cohort.length} ${pair} trades were profitable (${Math.round(rate * 100)}%), avg R ${ar.toFixed(2)}.`,
      });
    }
  }

  // 2. Re-entry after a loss (negative): losses opened shortly after another trade closed.
  const reEntryLosses = valid.filter((o) => {
    if (!isLoss(o) || !o.openedAt) return false;
    const t = new Date(o.openedAt).getTime();
    if (!Number.isFinite(t)) return false;
    return valid.some((p) => p !== o && p.openedAt &&
      Math.abs(new Date(p.openedAt).getTime() - t) <= RE_ENTRY_MINUTES * 60_000);
  });
  if (reEntryLosses.length >= MIN_COHORT) {
    patterns.push({
      id: "reentry-after-loss",
      kind: "negative",
      title: "You tend to re-enter and lose shortly after a loss",
      n: reEntryLosses.length,
      tier: tierFor(reEntryLosses.length),
      detail: `${reEntryLosses.length} losing trades were opened within ${RE_ENTRY_MINUTES / 60}h of another trade.`,
    });
  }

  // 3. Oversizing after a loss (negative): a loss followed by a larger size that also lost.
  let oversizeLosses = 0;
  const byAsset = new Map<string, HistoryOutcome[]>();
  for (const o of valid) {
    const k = o.asset.toUpperCase();
    const list = byAsset.get(k) ?? [];
    list.push(o);
    byAsset.set(k, list);
  }
  for (const cohort of byAsset.values()) {
    const sorted = [...cohort].sort((a, b) => new Date(a.openedAt ?? 0).getTime() - new Date(b.openedAt ?? 0).getTime());
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.openedAt && cur.openedAt && isLoss(prev) && isLoss(cur) && cur.size > prev.size * OVERSIZE_MULT) {
        oversizeLosses += 1;
      }
    }
  }
  if (oversizeLosses >= 2) {
    patterns.push({
      id: "oversizing-after-loss",
      kind: "negative",
      title: "You increase size after a loss and it keeps losing",
      n: oversizeLosses,
      tier: tierFor(oversizeLosses),
      detail: `${oversizeLosses} instances of a bigger losing trade right after a losing trade.`,
    });
  }

  return patterns.sort((a, b) => (a.kind === "negative" ? -1 : 1) - (b.kind === "negative" ? -1 : 1) || b.n - a.n);
}