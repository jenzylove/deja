/**
 * Phase 2 exit criterion: hybrid retrieval returns defensible neighbours, the
 * reranker earns its weight, and progressive widening reports itself.
 *
 *   npm run check:retrieval
 */
import "./load-env";
import { db } from "../src/lib/db";
import { canonicalizeThesis } from "../src/lib/canonicalize";
import { retrieve, baselineWinRate } from "../src/lib/retrieval";
import { renderable, pct } from "../src/lib/stats";

const EMAIL = "demo@deja.app";

const CASES = [
  { raw: "cleared the old high, came back down to tap it and buyers stepped in. closed above so im taking continuation",
    asset: "BTC", direction: "long" as const, risk: 1.0 },
  { raw: "this has gone vertical for days, volume drying up, big wick into resistance. fading it",
    asset: "ETH", direction: "short" as const, risk: 1.5 },
  { raw: "breaking the level right now, not waiting for the retest, jumping in before it runs",
    asset: "SOL", direction: "long" as const, risk: 2.8 },
];

async function main() {
  const pool = db();
  const { rows: u } = await pool.query<{id:string}>(`SELECT id FROM users WHERE email=$1`,[EMAIL]);
  const userId = u[0].id;
  const baseline = await baselineWinRate(userId);
  console.log(`\nBaseline win rate: ${pct(baseline)}\n`);

  for (const c of CASES) {
    const canon = await canonicalizeThesis({
      thesisRaw: c.raw, direction: c.direction, assetClass: "crypto",
      regime: "trending", session: "ny",
    });
    const res = await retrieve({
      userId, canonicalThesis: canon.canonical, asset: c.asset, assetClass: "crypto",
      direction: c.direction, strategy: canon.strategy, riskPct: c.risk,
      session: "ny", regime: "trending",
    });
    const view = renderable(res.cohort);

    console.log(`── ${c.asset} ${c.direction} — "${c.raw.slice(0,52)}…"`);
    console.log(`   classified: ${canon.strategy}  confirmed=${canon.confirmationStated}`);
    console.log(`   filter: ${res.filterUsed}${res.widened ? "  \x1b[33m(widened)\x1b[0m" : ""}  candidates=${res.candidates}  ${res.latencyMs}ms`);
    console.log(`   cohort: n=${res.cohort.n} ${res.cohort.wins}W/${res.cohort.losses}L  tier=${res.cohort.tier}  ` +
      (view.mayStatePercentage ? `${pct(res.cohort.rate??0)} [${pct(res.cohort.interval.low)}–${pct(res.cohort.interval.high)}]` : "no % permitted") +
      `  avgR=${res.cohort.avgR?.toFixed(2) ?? "—"}`);
    const pure = res.trades.filter(t=>t.strategy===canon.strategy).length;
    console.log(`   top-${res.trades.length}: ${pure}/${res.trades.length} same strategy`);
    for (const t of res.trades.slice(0,3)) {
      console.log(`     · ${t.asset} ${t.direction} ${t.strategy} ${t.ageDays}d ago  R=${t.rMultiple?.toFixed(2) ?? "—"}  cos=${t.cosine.toFixed(3)} score=${t.score.toFixed(3)}`);
      console.log(`       "${t.thesisRaw.slice(0,72)}…"`);
    }
    console.log(`   behaviour: ${res.behaviour.tradesToday} trades today, loss streak ${res.behaviour.lossStreak}, ` +
      `${res.behaviour.minutesSinceLastLoss ?? "—"}min since last loss, ${res.behaviour.stopWidenedLast30d} stop widenings/30d`);
    console.log("");
  }
  await pool.end();
}
main().catch(e=>{console.error("\nFailed:",e.message);process.exit(1)});
