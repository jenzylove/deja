/**
 * Applies src/db/schema.sql to the configured cluster.
 *
 * The schema is written idempotently (CREATE ... IF NOT EXISTS throughout), so
 * this is safe to rerun. Statements are executed one at a time so a failure
 * names the statement that broke rather than the whole file.
 *
 *   npm run db:push
 */
import "./load-env";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db } from "../src/lib/db";

/** Split on semicolons at statement level, ignoring those inside quotes. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: string | null = null;

  const lines = sql.split(/\r?\n/).filter((l) => !/^\s*--/.test(l));
  const flat = lines.join("\n");

  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    if (quote) {
      if (ch === quote) quote = null;
      buf += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === ";") {
      if (buf.trim()) out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function label(stmt: string): string {
  const m = stmt.match(
    /^(CREATE\s+(?:VECTOR\s+)?(?:TABLE|TYPE|INDEX)(?:\s+IF\s+NOT\s+EXISTS)?)\s+([^\s(]+)/i,
  );
  return m ? `${m[1].replace(/\s+/g, " ")} ${m[2]}` : stmt.slice(0, 60).replace(/\s+/g, " ");
}

async function main() {
  const sql = readFileSync(resolve(process.cwd(), "src/db/schema.sql"), "utf8");
  const stmts = statements(sql);
  const pool = db();

  console.log(`\nApplying schema — ${stmts.length} statements\n`);
  let applied = 0;
  let skipped = 0;

  for (const stmt of stmts) {
    try {
      await pool.query(stmt);
      applied++;
    } catch (err) {
      const msg = (err as Error).message;
      // CockroachDB has no IF NOT EXISTS for some object kinds across all
      // versions; treat "already exists" as success so reruns stay clean.
      if (/already exists/i.test(msg)) {
        skipped++;
        continue;
      }
      console.error(`\n\x1b[31m✗ ${label(stmt)}\x1b[0m\n  ${msg}\n`);
      process.exit(1);
    }
  }

  const { rows: tables } = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
  );
  const { rows: vec } = await pool.query<{ index_name: string }>(
    `SELECT index_name FROM information_schema.statistics
      WHERE table_schema = 'public' AND index_name = 'idx_intents_thesis_vec' LIMIT 1`,
  );

  console.log(`  \x1b[32m✓\x1b[0m ${applied} applied, ${skipped} already present\n`);
  console.log(`  tables (${tables.length}): ${tables.map((t) => t.table_name).join(", ")}`);
  console.log(
    vec.length
      ? `  \x1b[32m✓\x1b[0m vector index present on trade_intents.thesis_embedding\n`
      : `  \x1b[33m!\x1b[0m vector index not found — retrieval will fall back to a scan\n`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error("\nSchema push failed:", (err as Error).message);
  process.exit(1);
});
