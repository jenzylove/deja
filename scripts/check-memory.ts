/**
 * Phase 1 exit criterion.
 *
 * Two questions, both of which have to be answered against real rows rather
 * than asserted:
 *   1. Does vector retrieval return situationally similar trades, or is it
 *      matching vocabulary? Measured as strategy purity of the top-k.
 *   2. Do the planted behavioural patterns survive the statistical gate — and
 *      do the ones that are genuinely thin correctly fail it?
 *
 *   npm run check:memory
 */
import "./load-env";
import { db, toVector } from "../src/lib/db";
import { embedQuery } from "../src/lib/bedrock";
import { canonicalizeThesis } from "../src/lib/canonicalize";
import { summarize, qualifiesAsPattern, pct, renderable } from "../src/lib/stats";

const EMAIL = "demo@deja.app";

async function main() {
  const pool = db();
  const { rows: u } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE email = $1`,
    [EMAIL],
  );
  if (!u.length) throw new Error("No demo user — run: npm run seed");
  const userId = u[0].id;

  const { rows: base } = await pool.query<{ n: string; w: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE r_multiple > 0) AS w
       FROM trades WHERE user_id = $1 AND closed_at IS NOT NULL`,
    [userId],
  );
  const baseline = Number(base[0].w) / Number(base[0].n);
  console.log(`\nBaseline: ${base[0].w}W / ${Number(base[0].n) - Number(base[0].w)}L (${pct(baseline)}) over ${base[0].n} trades\n`);

  // ---- 1. retrieval quality -------------------------------------------------
  console.log("Retrieval quality — strategy purity of top-8 by cosine\n");

  // Probes are RAW TRADER PROSE and go through the real path: the LLM
  // canonicalises, then the canonical form is embedded. An earlier version of
  // this check embedded hand-written pseudo-canonical text, which is not a path
  // the product ever takes, and it hid the actual defect — strategy
  // misclassification, not embedding quality.
  const probes: { label: string; raw: string; direction: string; expect: string }[] = [
    {
      label: "reversal",
      raw: "this thing has gone vertical for three days straight, volume is drying up and we just printed a big wick into resistance. fading it here",
      direction: "short",
      expect: "reversal",
    },
    {
      label: "breakout retest",
      raw: "cleared the old high, came back down to tap it and buyers stepped in. closed above so im taking continuation",
      direction: "long",
      expect: "breakout_retest",
    },
    {
      label: "range",
      raw: "been chopping between two levels all week, price is at the bottom again and bouncing. buying the low",
      direction: "long",
      expect: "range",
    },
    {
      label: "momentum",
      raw: "huge candle just broke out of the coil with massive volume, riding this",
      direction: "long",
      expect: "momentum",
    },
  ];

  let purityTotal = 0;
  for (const p of probes) {
    const canon = await canonicalizeThesis({
      thesisRaw: p.raw, direction: p.direction,
      assetClass: "crypto", regime: "trending", session: "ny",
    });
    const v = await embedQuery(canon.canonical);
    const labelOk = canon.strategy === p.expect;
    const { rows } = await pool.query<{ strategy: string; d: string }>(
      `SELECT strategy, thesis_embedding <=> $2 AS d
         FROM trade_intents
        WHERE user_id = $1 AND thesis_embedding IS NOT NULL
        ORDER BY d LIMIT 8`,
      [userId, toVector(v)],
    );
    const hits = rows.filter((x) => x.strategy === p.expect).length;
    const purity = hits / rows.length;
    purityTotal += purity;
    const mark = purity >= 0.5 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(
      `  ${mark} ${p.label}\n      ${hits}/8 are ${p.expect} ` +
        `(nearest d=${Number(rows[0].d).toFixed(4)})  [${rows.map((x) => x.strategy.slice(0, 6)).join(" ")}]`,
    );
  }
  const avgPurity = purityTotal / probes.length;
  console.log(`\n  average purity: ${pct(avgPurity)} (random baseline would be ~${pct(1 / 5)})\n`);

  // ---- 2. do the planted patterns clear the gate? ---------------------------
  console.log("Pattern discovery — does the statistical gate find what was planted?\n");

  const cohorts: { label: string; where: string; params: unknown[] }[] = [
    {
      label: "breakout_retest, confirmation stated",
      where: `i.strategy = 'breakout_retest' AND i.confidence = 'high'`,
      params: [],
    },
    {
      label: "breakout_retest, NO confirmation (early entry)",
      where: `i.strategy = 'breakout_retest' AND i.confidence = 'medium'`,
      params: [],
    },
    {
      label: "risk over 2%",
      where: `i.risk_pct > 2`,
      params: [],
    },
    {
      label: "SOL",
      where: `t.asset = 'SOL'`,
      params: [],
    },
    {
      label: "BTC",
      where: `t.asset = 'BTC'`,
      params: [],
    },
    {
      label: "re-entered within 20min of a loss",
      where: `EXISTS (SELECT 1 FROM trade_events e WHERE e.trade_id = t.id AND e.event_type = 'rule_overridden')`,
      params: [],
    },
    {
      label: "stop was widened mid-trade",
      where: `EXISTS (SELECT 1 FROM trade_events e WHERE e.trade_id = t.id AND e.event_type = 'stop_widened')`,
      params: [],
    },
  ];

  for (const c of cohorts) {
    const { rows } = await pool.query<{ r_multiple: string }>(
      `SELECT t.r_multiple FROM trades t
         JOIN trade_intents i ON i.id = t.intent_id
        WHERE t.user_id = $1 AND t.closed_at IS NOT NULL AND ${c.where}`,
      [userId, ...c.params],
    );
    const cohort = summarize(
      rows.map((x) => ({ win: Number(x.r_multiple) > 0, r: Number(x.r_multiple) })),
    );
    const promoted = qualifiesAsPattern(cohort, baseline);
    const view = renderable(cohort);
    const badge = promoted ? "\x1b[32mPATTERN\x1b[0m" : "\x1b[33mnot promoted\x1b[0m";

    console.log(`  ${c.label}`);
    console.log(
      `    n=${cohort.n} ${cohort.wins}W/${cohort.losses}L  ` +
        (view.mayStatePercentage ? `${pct(cohort.rate ?? 0)} ` : "(no % — anecdote) ") +
        `[${pct(cohort.interval.low)}–${pct(cohort.interval.high)}]  ` +
        `avgR=${cohort.avgR?.toFixed(2) ?? "—"}  tier=${cohort.tier}  ${badge}`,
    );
  }

  console.log("");
  await pool.end();
}

main().catch((err) => {
  console.error("\nCheck failed:", (err as Error).message);
  process.exit(1);
});
