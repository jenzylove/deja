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

  // These MUST be paraphrases, never the canonical strings themselves. Probing
  // with text identical to what was seeded measures exact string match and
  // returns a meaningless 100% at distance 0.0000. Real user theses are worded
  // differently from anything already in memory, so the probe has to be too.
  const probes: { label: string; text: string; expect: string }[] = [
    {
      label: "breakout retest (paraphrased)",
      text: "level flip; ceiling gave way then price came back and the old ceiling acted as a floor, participation picked up; expecting the move to extend",
      expect: "breakout_retest",
    },
    {
      label: "reversal into exhaustion (paraphrased)",
      text: "fade; move went vertical then buyers disappeared and it printed a long upper shadow; expecting the trend to turn",
      expect: "reversal",
    },
    {
      label: "range mean-reversion (paraphrased)",
      text: "boundary trade; price sitting at the floor of a sideways band and refusing to break it; expecting a snap back to the middle",
      expect: "range",
    },
  ];

  let purityTotal = 0;
  for (const p of probes) {
    const v = await embedQuery(p.text);
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
