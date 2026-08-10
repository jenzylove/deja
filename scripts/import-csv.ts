/**
 * Imports a broker or exchange trade-history export.
 *
 *   npm run import -- <file.csv> [--email you@example.com] [--dry-run]
 *
 * Imported trades carry outcome and behaviour but no thesis — an exchange
 * export records what you did, never why. Deja labels them source='imported'
 * and the UI must say so rather than implying the trader wrote a rationale
 * they never wrote. Their value is the behavioural and outcome cohorts; the
 * semantic layer builds from trades taken inside Deja.
 */
import "./load-env";
import { readFileSync } from "node:fs";
import { db } from "../src/lib/db";
import { importCsv, deriveRevengeEntries, pairFills, looksLikeFillLog } from "../src/lib/import/csv";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) {
    console.error("\nUsage: npm run import -- <file.csv> [--email you@example.com] [--dry-run]\n");
    process.exit(1);
  }
  const email = arg("email") ?? "demo@deja.app";
  const dryRun = process.argv.includes("--dry-run");

  const result = importCsv(readFileSync(file, "utf8"));

  // A fill log must be paired before anything else looks at it, or every
  // statistic is computed over half-trades.
  const isFillLog = looksLikeFillLog(result.trades, result.mapping);
  if (isFillLog) {
    const before = result.trades.length;
    result.trades = pairFills(result.trades);
    console.log(
      "\n\x1b[33m!\x1b[0m Detected a fill log, not round-trip trades.\n" +
        `  Paired ${before} fills into ${result.trades.length} trades (flat-to-flat FIFO).`,
    );
  }

  console.log(`\nFile:     ${file}`);
  console.log(`Detected: ${result.detected}`);
  console.log(`Headers:  ${result.headers.join(", ")}\n`);

  console.log("Inferred column mapping — check this before trusting anything downstream:");
  for (const [field, col] of Object.entries(result.mapping)) {
    const required = ["openedAt", "asset", "direction"].includes(field);
    const mark = col ? "\x1b[32m✓\x1b[0m" : required ? "\x1b[31m✗\x1b[0m" : "\x1b[33m–\x1b[0m";
    console.log(`  ${mark} ${field.padEnd(10)} ${col ?? "(not found)"}`);
  }

  console.log(`\nParsed ${result.trades.length} trades, skipped ${result.skipped.length}`);
  for (const s of result.skipped.slice(0, 8)) console.log(`  row ${s.row}: ${s.reason}`);
  if (result.skipped.length > 8) console.log(`  … and ${result.skipped.length - 8} more`);

  if (!result.trades.length) {
    console.log("\nNothing to import.\n");
    process.exit(1);
  }

  const withR = result.trades.filter((t) => t.rMultiple !== null).length;
  const withPnl = result.trades.filter((t) => t.pnl !== null).length;
  const revenge = deriveRevengeEntries(result.trades);
  const first = result.trades[0].openedAt.toISOString().slice(0, 10);
  const last = result.trades[result.trades.length - 1].openedAt.toISOString().slice(0, 10);

  console.log(`\nRange:        ${first} → ${last}`);
  console.log(`With P&L:     ${withPnl}/${result.trades.length}`);
  console.log(
    `With R:       ${withR}/${result.trades.length}` +
      (withR === 0 ? "  (no stops recorded — R cannot be computed and will not be invented)" : ""),
  );
  console.log(`Post-loss re-entries derived from timestamps: ${revenge.size}`);

  console.log("\nSample:");
  for (const t of result.trades.slice(0, 3)) {
    console.log(
      `  ${t.openedAt.toISOString().slice(0, 16)}  ${t.asset.padEnd(6)} ${t.direction.padEnd(5)} ` +
        `entry=${t.entry}  exit=${t.exit ?? "—"}  pnl=${t.pnl ?? "—"}  R=${t.rMultiple ?? "—"}`,
    );
  }

  if (dryRun) {
    console.log("\n\x1b[33mDry run — nothing written.\x1b[0m\n");
    process.exit(0);
  }

  const pool = db();
  const { rows: u } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, display_name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = excluded.email
     RETURNING id`,
    [email, email.split("@")[0]],
  );
  const userId = u[0].id;
  const { rows: acc } = await pool.query<{ id: string }>(
    `SELECT id FROM accounts WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const accountId =
    acc[0]?.id ??
    (
      await pool.query<{ id: string }>(
        `INSERT INTO accounts (user_id, name) VALUES ($1, 'Imported') RETURNING id`,
        [userId],
      )
    ).rows[0].id;

  let written = 0;
  for (let i = 0; i < result.trades.length; i++) {
    const t = result.trades[i];
    const lost = t.pnl !== null ? t.pnl < 0 : (t.rMultiple ?? 0) < 0;
    const closedAt = t.closedAt ?? t.openedAt;

    const { rows: tr } = await pool.query<{ id: string }>(
      `INSERT INTO trades
         (user_id, account_id, asset, direction, size, opened_at, closed_at,
          entry_fill, exit_fill, initial_stop, final_stop, initial_target,
          pnl, r_multiple, duration_s, exit_reason, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,'imported')
       RETURNING id`,
      [
        userId, accountId, t.asset, t.direction, t.size, t.openedAt, closedAt,
        t.entry, t.exit, t.stop, t.target, t.pnl, t.rMultiple,
        Math.max(0, Math.round((closedAt.getTime() - t.openedAt.getTime()) / 1000)),
        lost ? "stop" : "target",
      ],
    );

    if (revenge.has(i)) {
      await pool.query(
        `INSERT INTO trade_events (trade_id, user_id, at, event_type, payload)
         VALUES ($1,$2,$3,'rule_overridden',$4)`,
        [
          tr[0].id, userId, t.openedAt,
          JSON.stringify({ rule: "post_loss_cooldown", derived_from: "timestamps" }),
        ],
      );
    }
    if (++written % 100 === 0) console.log(`  … ${written}/${result.trades.length}`);
  }

  console.log(`\n  \x1b[32m✓\x1b[0m ${written} trades imported for ${email}`);
  console.log(`    ${revenge.size} post-loss re-entries flagged\n`);
  await pool.end();
}

main().catch((err) => {
  console.error("\nImport failed:", (err as Error).message);
  process.exit(1);
});
