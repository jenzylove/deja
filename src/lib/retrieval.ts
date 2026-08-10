import { db, toVector } from "./db";
import { embedQuery } from "./bedrock";
import { summarize, type Cohort } from "./stats";

/**
 * Three-stage hybrid retrieval. PRD §6.
 *
 * Naive top-k cosine over all history returns whatever cluster is densest —
 * measured at 33% strategy purity against a 42% majority class, i.e. it was
 * returning the majority class regardless of the query. Comparability is a
 * property of hard attributes (you cannot learn about a long from a short), so
 * those are enforced in SQL and the vector only ranks *within* what is already
 * comparable.
 *
 *   Stage 1  SQL prefilter, progressively widened if too thin
 *   Stage 2  ANN over the prefiltered set via the distributed vector index
 *   Stage 3  rerank on cosine + attribute overlap + recency
 */

export interface RetrievalQuery {
  userId: string;
  canonicalThesis: string;
  asset: string;
  assetClass: string;
  direction: "long" | "short";
  strategy: string | null;
  riskPct: number | null;
  session: string;
  regime: string;
}

export interface RetrievedTrade {
  intentId: string;
  tradeId: string | null;
  asset: string;
  direction: string;
  strategy: string | null;
  session: string | null;
  regime: string | null;
  riskPct: number | null;
  confidence: string | null;
  thesisRaw: string;
  openedAt: Date;
  closedAt: Date | null;
  rMultiple: number | null;
  win: boolean | null;
  cosine: number;
  score: number;
  ageDays: number;
}

export interface BehaviouralState {
  minutesSinceLastLoss: number | null;
  tradesToday: number;
  lossStreak: number;
  openPositions: number;
  stopWidenedLast30d: number;
}

export interface RetrievalResult {
  trades: RetrievedTrade[];
  cohort: Cohort;
  behaviour: BehaviouralState;
  /** Which prefilter survived, for the brief to disclose honestly. */
  filterUsed: string;
  widened: boolean;
  candidates: number;
  latencyMs: number;
}

/** Half-life in days. A habit from 18 months ago is weaker evidence than one
 *  from last month, but it is not worthless, so this decays rather than cuts. */
const RECENCY_HALF_LIFE = 90;

const WEIGHTS = { cosine: 0.5, attributes: 0.3, recency: 0.2 } as const;

/** Progressive widening. Each level drops the least essential constraint. A
 *  long cannot teach you about a short, so direction is the last to go. */
type Level = { name: string; sql: string; params: (q: RetrievalQuery) => unknown[] };

const LEVELS: Level[] = [
  {
    name: "same direction, asset and strategy",
    sql: `i.direction = $2 AND i.asset = $3 AND i.strategy = $4`,
    params: (q) => [q.direction, q.asset, q.strategy],
  },
  {
    name: "same direction and strategy, any asset",
    sql: `i.direction = $2 AND i.strategy = $3`,
    params: (q) => [q.direction, q.strategy],
  },
  {
    name: "same direction and asset class",
    sql: `i.direction = $2 AND i.asset_class = $3`,
    params: (q) => [q.direction, q.assetClass],
  },
  {
    name: "same direction only",
    sql: `i.direction = $2`,
    params: (q) => [q.direction],
  },
  {
    name: "entire history",
    sql: `true`,
    params: () => [],
  },
];

const MIN_CANDIDATES = 12;
const ANN_LIMIT = 25;
const FINAL_LIMIT = 8;

function attributeOverlap(q: RetrievalQuery, r: {
  strategy: string | null; session: string | null; regime: string | null;
  asset: string; riskPct: number | null;
}): number {
  let score = 0;
  let total = 0;
  const add = (match: boolean, weight: number) => { score += match ? weight : 0; total += weight; };

  add(r.strategy === q.strategy, 3);
  add(r.asset === q.asset, 2);
  add(r.session === q.session, 1);
  add(r.regime === q.regime, 1);
  if (q.riskPct !== null && r.riskPct !== null) {
    // Same risk band matters more than the exact number.
    add(Math.abs(Number(r.riskPct) - q.riskPct) < 0.75, 1);
  }
  return total === 0 ? 0 : score / total;
}

export async function retrieve(q: RetrievalQuery): Promise<RetrievalResult> {
  const started = Date.now();
  const pool = db();
  const vec = toVector(await embedQuery(q.canonicalThesis));

  // --- Stage 1 + 2: widen until the candidate pool is big enough to say
  // anything about. Reported, never hidden — a brief built on a widened filter
  // is weaker evidence and the trader is told so.
  let level = LEVELS[0];
  let rows: RawRow[] = [];
  let widened = false;

  for (let i = 0; i < LEVELS.length; i++) {
    level = LEVELS[i];
    // Skip strategy-dependent levels when the strategy is unknown.
    if (level.sql.includes("i.strategy") && !q.strategy) continue;

    rows = await annSearch(q, level, vec);
    if (rows.length >= MIN_CANDIDATES || i === LEVELS.length - 1) {
      widened = i > 0;
      break;
    }
  }

  // --- Stage 3: rerank ---
  const now = Date.now();
  const scored: RetrievedTrade[] = rows.map((r) => {
    const cosine = 1 - Number(r.distance);
    const ageDays = (now - new Date(r.opened_at).getTime()) / 86_400_000;
    const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE);
    const overlap = attributeOverlap(q, {
      strategy: r.strategy, session: r.session, regime: r.regime,
      asset: r.asset, riskPct: r.risk_pct === null ? null : Number(r.risk_pct),
    });
    return {
      intentId: r.intent_id,
      tradeId: r.trade_id,
      asset: r.asset,
      direction: r.direction,
      strategy: r.strategy,
      session: r.session,
      regime: r.regime,
      riskPct: r.risk_pct === null ? null : Number(r.risk_pct),
      confidence: r.confidence,
      thesisRaw: r.thesis_raw,
      openedAt: new Date(r.opened_at),
      closedAt: r.closed_at ? new Date(r.closed_at) : null,
      rMultiple: r.r_multiple === null ? null : Number(r.r_multiple),
      win: r.r_multiple === null ? null : Number(r.r_multiple) > 0,
      cosine,
      ageDays: Math.round(ageDays),
      score:
        WEIGHTS.cosine * cosine +
        WEIGHTS.attributes * overlap +
        WEIGHTS.recency * recency,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, FINAL_LIMIT);

  // The cohort is computed over the whole comparable set, not the 8 shown. The
  // 8 are illustrations; the statistic must not be drawn from a top-k slice or
  // it would be biased toward whatever the vector happened to like.
  const cohort = summarize(
    scored
      .filter((t) => t.win !== null)
      .map((t) => ({ win: t.win as boolean, r: t.rMultiple })),
  );

  const behaviour = await behaviouralState(q.userId);

  return {
    trades: top,
    cohort,
    behaviour,
    filterUsed: level.name,
    widened,
    candidates: scored.length,
    latencyMs: Date.now() - started,
  };
}

interface RawRow {
  intent_id: string; trade_id: string | null; asset: string; direction: string;
  strategy: string | null; session: string | null; regime: string | null;
  risk_pct: string | null; confidence: string | null; thesis_raw: string;
  opened_at: string; closed_at: string | null; r_multiple: string | null;
  distance: string;
}

async function annSearch(q: RetrievalQuery, level: Level, vec: string): Promise<RawRow[]> {
  const extra = level.params(q);
  // $1 is user_id, the vector is last. Level predicates use $2..$n.
  const vecParam = `$${extra.length + 2}`;
  const sql = `
    SELECT i.id AS intent_id, t.id AS trade_id, i.asset, i.direction, i.strategy,
           i.session, i.regime, i.risk_pct, i.confidence, i.thesis_raw,
           i.created_at AS opened_at, t.closed_at, t.r_multiple,
           i.thesis_embedding <=> ${vecParam} AS distance
      FROM trade_intents i
      LEFT JOIN trades t ON t.intent_id = i.id
     WHERE i.user_id = $1
       AND i.thesis_embedding IS NOT NULL
       AND t.closed_at IS NOT NULL
       AND ${level.sql}
     ORDER BY distance
     LIMIT ${ANN_LIMIT}`;
  const { rows } = await db().query<RawRow>(sql, [q.userId, ...extra, vec]);
  return rows;
}

/**
 * The objective half of the evidence. None of this depends on the trader
 * telling the truth, or telling us anything at all.
 */
export async function behaviouralState(userId: string): Promise<BehaviouralState> {
  const pool = db();
  const [lastLoss, today, streak, open, widened] = await Promise.all([
    pool.query<{ m: string | null }>(
      `SELECT extract(epoch FROM now() - max(closed_at)) / 60 AS m
         FROM trades WHERE user_id = $1 AND closed_at IS NOT NULL AND r_multiple < 0`,
      [userId],
    ),
    pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM trades
        WHERE user_id = $1 AND opened_at >= date_trunc('day', now())`,
      [userId],
    ),
    pool.query<{ r_multiple: string }>(
      `SELECT r_multiple FROM trades
        WHERE user_id = $1 AND closed_at IS NOT NULL
        ORDER BY closed_at DESC LIMIT 20`,
      [userId],
    ),
    pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM trades WHERE user_id = $1 AND closed_at IS NULL`,
      [userId],
    ),
    pool.query<{ c: string }>(
      `SELECT count(*) AS c FROM trade_events
        WHERE user_id = $1 AND event_type = 'stop_widened' AND at > now() - INTERVAL '30 days'`,
      [userId],
    ),
  ]);

  let lossStreak = 0;
  for (const row of streak.rows) {
    if (Number(row.r_multiple) < 0) lossStreak++;
    else break;
  }

  return {
    minutesSinceLastLoss: lastLoss.rows[0]?.m === null || lastLoss.rows[0]?.m === undefined
      ? null
      : Math.floor(Number(lastLoss.rows[0].m)),
    tradesToday: Number(today.rows[0].c),
    lossStreak,
    openPositions: Number(open.rows[0].c),
    stopWidenedLast30d: Number(widened.rows[0].c),
  };
}

/** The trader's own baseline, which every cohort is judged against. */
export async function baselineWinRate(userId: string): Promise<number> {
  const { rows } = await db().query<{ n: string; w: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE r_multiple > 0) AS w
       FROM trades WHERE user_id = $1 AND closed_at IS NOT NULL`,
    [userId],
  );
  const n = Number(rows[0].n);
  return n === 0 ? 0.5 : Number(rows[0].w) / n;
}
