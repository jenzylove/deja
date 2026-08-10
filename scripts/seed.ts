/**
 * Generates a synthetic trading history so development and the retrieval
 * quality work can proceed before a real CSV export arrives.
 *
 * Deliberately deterministic: a fixed seed and a committed generator mean a
 * reviewer can read exactly what was planted and verify that Deja discovered it
 * rather than being told it. Hand-authored fixtures tuned to flatter the agent
 * are the credibility trap this avoids (PRD §11).
 *
 * The planted structure — which the pattern discovery in Phase 6 must find
 * without being told:
 *   · breakout_retest WITH confirmation      → strong
 *   · breakout_retest WITHOUT confirmation   → weak  (the "early entry" habit)
 *   · any trade opened <20min after a loss   → weak  (revenge trading)
 *   · risk > 2%                              → weak  (oversizing)
 *   · SOL                                    → weak, BTC strong (asset skew)
 *   · widening a stop                        → deepens the average loss
 *
 *   npm run seed
 */
import "./load-env";
import { db, toVector } from "../src/lib/db";
import { embedMany } from "../src/lib/bedrock";
import { sessionForDate, canonicalizeThesis, type Strategy as AnyStrategy } from "../src/lib/canonicalize";

const SEED = 20260810;
const N_TRADES = 180;
const EMAIL = "demo@deja.app";

/** mulberry32 — small, fast, and reproducible across machines. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = rng(SEED);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const chance = (p: number) => r() < p;
const between = (lo: number, hi: number) => lo + r() * (hi - lo);

type Strategy = "breakout_retest" | "reversal" | "momentum" | "range" | "trend_pullback";

const ASSETS = [
  { sym: "BTC", weight: 0.45, price: 68000, edge: +0.10 },
  { sym: "ETH", weight: 0.3, price: 3400, edge: 0.0 },
  { sym: "SOL", weight: 0.25, price: 150, edge: -0.18 },
] as const;

function pickAsset() {
  const x = r();
  let acc = 0;
  for (const a of ASSETS) {
    acc += a.weight;
    if (x <= acc) return a;
  }
  return ASSETS[0];
}

const STRATEGY_MIX: [Strategy, number][] = [
  ["breakout_retest", 0.4],
  ["trend_pullback", 0.2],
  ["momentum", 0.16],
  ["reversal", 0.14],
  ["range", 0.1],
];

function pickStrategy(): Strategy {
  const x = r();
  let acc = 0;
  for (const [s, w] of STRATEGY_MIX) {
    acc += w;
    if (x <= acc) return s;
  }
  return "breakout_retest";
}

/** Thesis wording varies; the underlying situation does not. That gap is
 *  exactly what the canonical embedding has to see through. */
const THESIS: Record<Strategy, { confirmed: string[]; early: string[]; signals: string[][] }> = {
  breakout_retest: {
    confirmed: [
      "broke {lvl} and came back to retest it, the retest held and closed above, volume was strong on the break. looking for continuation",
      "reclaimed the previous range high at {lvl} and it's holding as support now. clean retest, taking continuation",
      "resistance at {lvl} broke on expanding volume, pulled back and buyers defended it. candle closed above, entering",
    ],
    early: [
      "broke {lvl} and it's coming back to retest now, candle hasn't closed yet but i'm taking it early so i don't miss the move",
      "retesting {lvl} as we speak, hasn't held yet but it looks like it will, entering before confirmation",
      "pulled back into the {lvl} breakout level, no confirmation candle yet, getting in ahead of it",
    ],
    signals: [
      ["resistance breakout", "retest holding", "volume expansion"],
      ["range high reclaimed", "support flip", "volume expansion"],
      ["level break", "buyers defending", "momentum"],
    ],
  },
  trend_pullback: {
    confirmed: [
      "uptrend intact, pulled back to the 20ema and bounced with a strong close. adding here",
      "healthy pullback into prior support at {lvl}, trend structure unbroken, taking the continuation",
    ],
    early: [
      "pulling back to the ema now, catching it before it turns",
      "dipping into support at {lvl}, getting in while it's cheap",
    ],
    signals: [
      ["higher lows intact", "ema bounce", "trend continuation"],
      ["pullback to support", "trend structure intact"],
    ],
  },
  momentum: {
    confirmed: [
      "strong impulse leg with volume, riding the momentum, structure supports more upside",
      "breaking out of consolidation with real volume behind it, momentum trade",
    ],
    early: [
      "big candle forming, jumping on the momentum before it runs",
      "moving fast, getting in now",
    ],
    signals: [["impulse leg", "volume expansion", "momentum"], ["consolidation break", "momentum"]],
  },
  reversal: {
    confirmed: [
      "parabolic move into resistance, volume dried up and we got a rejection wick. fading it",
      "exhaustion after an extended run, divergence on the oscillator, taking the reversal",
    ],
    early: [
      "looks overextended here, fading it before the turn",
      "this has run too far too fast, calling the top",
    ],
    signals: [["exhaustion", "volume dried up", "rejection wick"], ["overextension", "divergence"]],
  },
  range: {
    confirmed: [
      "clean range between {lvl} and the highs, buying the low with a rejection candle",
      "range bound, taking the low of the range, tight stop below",
    ],
    early: ["approaching range low, getting in early", "near the bottom of the range, entering"],
    signals: [["range low", "rejection candle"], ["range bound", "mean reversion"]],
  },
};

interface Row {
  openedAt: Date;
  asset: string;
  price: number;
  direction: "long" | "short";
  strategy: AnyStrategy;
  confirmed: boolean;
  riskPct: number;
  thesisRaw: string;
  signals: string[];
  marketThesis: "continuation" | "reversal" | "mean_revert";
  canonical: string;
  regime: "trending" | "ranging" | "volatile";
  session: string;
  win: boolean;
  rMultiple: number;
  postLoss: boolean;
  minutesSinceLoss: number | null;
  stopWidened: boolean;
  secondsToSubmit: number;
  durationS: number;
}

function build(): Row[] {
  const rows: Row[] = [];
  // ~9 months back, so cohorts have room to accumulate and recency decay bites.
  let t = new Date(Date.UTC(2025, 10, 15, 9, 0, 0)).getTime();
  let lastLossAt: number | null = null;

  for (let i = 0; i < N_TRADES; i++) {
    // Irregular cadence, except after a loss: a re-entry sometimes follows
    // within minutes, which is what creates the revenge-trading cohort. This
    // has to be decided before the clock advances, or the normal 4-46h gap
    // swamps it and the pattern never appears in the data at all.
    const revengeNow = lastLossAt !== null && chance(0.28);
    t += revengeNow ? between(3, 17) * 60 * 1000 : between(4, 46) * 3600 * 1000;
    const openedAt = new Date(t);

    const asset = pickAsset();
    const strategy = pickStrategy();
    const direction: "long" | "short" = strategy === "reversal" ? (chance(0.7) ? "short" : "long") : chance(0.78) ? "long" : "short";

    // The early-entry habit is a *habit*: it shows up often, not occasionally.
    const confirmed = chance(0.55);

    const minutesSinceLoss = lastLossAt === null ? null : Math.round((t - lastLossAt) / 60000);
    // Revenge trading is more likely soon after a loss, not uniformly random.
    const postLoss = minutesSinceLoss !== null && minutesSinceLoss < 20;

    const riskPct = chance(0.16) ? between(2.1, 3.4) : between(0.5, 2.0);

    // --- planted edge structure ---
    let p = 0.5;
    p += strategy === "breakout_retest" ? (confirmed ? 0.2 : -0.24) : confirmed ? 0.08 : -0.1;
    p += asset.edge;
    if (postLoss) p -= 0.24;
    if (riskPct > 2) p -= 0.14;
    p = Math.min(0.9, Math.max(0.08, p));
    const win = chance(p);

    // Must be possible on winners too. If widening only ever happened on
    // losses, the cohort could not contain a win by construction, and "trades
    // where you widened the stop: 0% win rate" would be a tautology dressed up
    // as an insight.
    const stopWidened = win ? chance(0.09) : chance(postLoss ? 0.45 : 0.20);
    const rMultiple = win
      ? Number(between(0.8, 2.8).toFixed(2))
      : Number((stopWidened ? between(-2.2, -1.25) : between(-1.05, -0.85)).toFixed(2));

    const bank = THESIS[strategy];
    const template = pick(confirmed ? bank.confirmed : bank.early);
    const lvl = Math.round(asset.price * between(0.97, 1.03));
    const thesisRaw = template.replace("{lvl}", String(lvl));
    const signals = pick(bank.signals);
    const marketThesis: Row["marketThesis"] =
      strategy === "reversal" ? "reversal" : strategy === "range" ? "mean_revert" : "continuation";

    rows.push({
      openedAt,
      asset: asset.sym,
      price: Number((asset.price * between(0.9, 1.1)).toFixed(2)),
      direction,
      strategy,
      confirmed,
      riskPct: Number(riskPct.toFixed(2)),
      thesisRaw,
      signals,
      marketThesis,
      canonical: [
        strategy.replace(/_/g, " "),
        signals.join(", "),
        `expecting ${marketThesis.replace(/_/g, " ")}`,
      ].join("; "),
      regime: pick(["trending", "ranging", "volatile"] as const),
      session: sessionForDate(openedAt),
      win,
      rMultiple,
      postLoss,
      minutesSinceLoss,
      stopWidened,
      // Rushed entries are rushed: early setups get submitted faster.
      secondsToSubmit: Math.round(confirmed ? between(40, 240) : between(6, 45)),
      durationS: Math.round(between(1800, 172800)),
    });

    lastLossAt = win ? null : t;
  }
  return rows;
}

async function main() {
  const pool = db();
  const rows = build();
  console.log(`\nSeeding ${rows.length} trades (seed ${SEED})\n`);

  // Idempotent: wipe and rebuild the demo user so reruns are clean.
  await pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);
  const { rows: u } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, display_name, tz) VALUES ($1,$2,$3) RETURNING id`,
    [EMAIL, "Demo Trader", "UTC"],
  );
  const userId = u[0].id;
  const { rows: a } = await pool.query<{ id: string }>(
    `INSERT INTO accounts (user_id, name, starting_balance) VALUES ($1,$2,$3) RETURNING id`,
    [userId, "Paper", 10000],
  );
  const accountId = a[0].id;

  await pool.query(
    `INSERT INTO rules (user_id, source_text, predicate, enforcement) VALUES
      ($1, 'Never risk more than 2% on a single trade', '{"field":"risk_pct","op":"lte","value":2}', 'block'),
      ($1, 'Do not open another position within 20 minutes of being stopped out', '{"field":"minutes_since_last_loss","op":"gte","value":20}', 'block'),
      ($1, 'Maximum three trades per day', '{"field":"trades_today","op":"lt","value":3}', 'warn'),
      ($1, 'Never enter without a stop loss', '{"field":"has_stop_loss","op":"eq","value":true}', 'block')`,
    [userId],
  );
  console.log("  ✓ user, account, 4 rules");

  // Classify through the same path production uses. The generator knows what
  // it intended, but if stored labels come from the generator while live
  // queries are labelled by the classifier, the two disagree over identical
  // prose and cohorts silently split in half.
  console.log(`  … classifying ${rows.length} theses through the live classifier`);
  let relabelled = 0;
  const width = 4;
  for (let i = 0; i < rows.length; i += width) {
    const batch = rows.slice(i, i + width);
    const out = await Promise.all(
      batch.map((x) =>
        canonicalizeThesis({
          thesisRaw: x.thesisRaw, direction: x.direction,
          assetClass: "crypto", regime: x.regime, session: x.session,
        }).catch(() => null),
      ),
    );
    out.forEach((c, j) => {
      if (!c) return;
      if (c.strategy !== batch[j].strategy) relabelled++;
      batch[j].strategy = c.strategy;
      batch[j].signals = c.signals;
      batch[j].canonical = c.canonical;
      batch[j].confirmed = c.confirmationStated;
    });
    if ((i + width) % 60 === 0 || i + width >= rows.length) {
      console.log(`      ${Math.min(i + width, rows.length)}/${rows.length}`);
    }
  }
  console.log(`  ✓ classified (${relabelled} differed from the generator's intent)`);

  console.log(`  … embedding ${rows.length} canonical theses`);
  const vectors = await embedMany(rows.map((x) => x.canonical), {
    onProgress: (d, t) => { if (d % 60 === 0 || d === t) console.log(`      ${d}/${t}`); },
  });
  console.log("  ✓ embeddings done");

  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const x = rows[i];
    const stop = x.direction === "long" ? x.price * 0.985 : x.price * 1.015;
    const target = x.direction === "long" ? x.price * 1.03 : x.price * 0.97;
    const closedAt = new Date(x.openedAt.getTime() + x.durationS * 1000);
    const exitFill = x.win ? target : x.direction === "long" ? stop * 0.999 : stop * 1.001;

    const { rows: ir } = await pool.query<{ id: string }>(
      `INSERT INTO trade_intents
        (user_id, account_id, created_at, asset, direction, size, entry, stop_loss,
         take_profit, risk_pct, confidence, thesis_raw, thesis_canonical, thesis_embedding,
         strategy, signals, market_thesis, session, regime, seconds_to_submit, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'executed')
       RETURNING id`,
      [
        userId, accountId, x.openedAt, x.asset, x.direction,
        Number((10000 * (x.riskPct / 100) / Math.abs(x.price - stop)).toFixed(8)),
        x.price, stop, target, x.riskPct,
        x.confirmed ? "high" : "medium",
        x.thesisRaw, x.canonical, toVector(vectors[i]),
        x.strategy, x.signals, x.marketThesis, x.session, x.regime, x.secondsToSubmit,
      ],
    );
    const intentId = ir[0].id;

    const { rows: tr } = await pool.query<{ id: string }>(
      `INSERT INTO trades
        (intent_id, user_id, account_id, asset, direction, size, opened_at, closed_at,
         entry_fill, exit_fill, initial_stop, final_stop, initial_target, pnl, r_multiple,
         duration_s, exit_reason, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'seed')
       RETURNING id`,
      [
        intentId, userId, accountId, x.asset, x.direction, 1,
        x.openedAt, closedAt, x.price, exitFill, stop,
        x.stopWidened ? stop * (x.direction === "long" ? 0.99 : 1.01) : stop,
        target,
        Number((x.rMultiple * 10000 * (x.riskPct / 100)).toFixed(2)),
        x.rMultiple, x.durationS, x.win ? "target" : "stop",
      ],
    );
    const tradeId = tr[0].id;

    await pool.query(
      `INSERT INTO decisions (intent_id, user_id, action, at) VALUES ($1,$2,'executed',$3)`,
      [intentId, userId, x.openedAt],
    );

    if (x.stopWidened) {
      await pool.query(
        `INSERT INTO trade_events (trade_id, user_id, at, event_type, payload)
         VALUES ($1,$2,$3,'stop_widened',$4)`,
        [
          tradeId, userId,
          new Date(x.openedAt.getTime() + x.durationS * 300),
          JSON.stringify({ from: stop, to: stop * (x.direction === "long" ? 0.99 : 1.01) }),
        ],
      );
    }
    if (x.postLoss) {
      await pool.query(
        `INSERT INTO trade_events (trade_id, user_id, at, event_type, payload)
         VALUES ($1,$2,$3,'rule_overridden',$4)`,
        [tradeId, userId, x.openedAt, JSON.stringify({ rule: "post_loss_cooldown", minutes_since_loss: x.minutesSinceLoss })],
      );
    }
    if (++n % 40 === 0) console.log(`  … ${n}/${rows.length}`);
  }

  const wins = rows.filter((x) => x.win).length;
  console.log(`\n  ✓ ${n} trades written`);
  console.log(`    baseline: ${wins}W / ${rows.length - wins}L (${Math.round((wins / rows.length) * 100)}%)`);
  console.log(`    user: ${userId}\n`);
  await pool.end();
}

main().catch((err) => {
  console.error("\nSeed failed:", (err as Error).message);
  process.exit(1);
});
