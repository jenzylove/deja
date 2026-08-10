/**
 * Phase 0 exit criterion: CockroachDB connects, VECTOR columns work, and a
 * distributed vector index actually serves an ANN query.
 *
 * Vector index syntax and availability vary by CockroachDB version, so this is
 * verified against the real cluster on day one rather than assumed. It runs in
 * a scratch table and cleans up after itself.
 *
 *   npm run verify:db
 */
import "./load-env";
import { db, dbReadOnly, toVector } from "../src/lib/db";
import { env } from "../src/lib/env";

function ok(msg: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}
function fail(msg: string) {
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
}
function warn(msg: string) {
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

const TBL = "_deja_vector_check";

async function main() {
  const dims = env().EMBED_DIMS;
  console.log(`\nCockroachDB check — expecting VECTOR(${dims})\n`);
  let failures = 0;
  const pool = db();

  // --- connectivity + version ---
  try {
    const { rows } = await pool.query<{ version: string }>("SELECT version()");
    ok(`connected — ${rows[0].version.split(" ").slice(0, 3).join(" ")}`);
  } catch (err) {
    fail(`connection failed: ${(err as Error).message}`);
    console.log("\n\x1b[31mCannot continue without a connection.\x1b[0m\n");
    process.exit(1);
  }

  try {
    // --- VECTOR type ---
    await pool.query(`DROP TABLE IF EXISTS ${TBL}`);
    await pool.query(
      `CREATE TABLE ${TBL} (
         id INT PRIMARY KEY,
         label STRING,
         bucket STRING,
         v VECTOR(${dims})
       )`,
    );
    ok(`VECTOR(${dims}) column created`);

    // --- distributed vector index ---
    try {
      await pool.query(`CREATE VECTOR INDEX ${TBL}_v_idx ON ${TBL} (v)`);
      ok("distributed vector index created");
    } catch (err) {
      failures++;
      fail(
        `CREATE VECTOR INDEX failed: ${(err as Error).message}\n` +
          `    → Check the cluster version supports vector indexes. This is the\n` +
          `      core CockroachDB capability the project depends on.`,
      );
    }

    // --- ANN query returns the right neighbour ---
    const mk = (seed: number) =>
      Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1) * 0.01));
    const near = mk(1.0);
    const alsoNear = mk(1.02);
    const farAway = mk(9.0);

    await pool.query(
      `INSERT INTO ${TBL} (id, label, bucket, v) VALUES ($1,$2,$3,$4),($5,$6,$7,$8),($9,$10,$11,$12)`,
      [
        1, "target", "a", toVector(near),
        2, "neighbour", "a", toVector(alsoNear),
        3, "unrelated", "b", toVector(farAway),
      ],
    );

    const { rows: ann } = await pool.query<{ label: string; d: number }>(
      `SELECT label, v <=> $1 AS d FROM ${TBL} WHERE id != 1 ORDER BY d LIMIT 1`,
      [toVector(near)],
    );
    if (ann[0]?.label === "neighbour") {
      ok(`cosine ANN returns nearest neighbour (distance ${Number(ann[0].d).toFixed(4)})`);
    } else {
      failures++;
      fail(`ANN returned "${ann[0]?.label}", expected "neighbour"`);
    }

    // --- hybrid retrieval shape: SQL prefilter + vector rank in one query ---
    // This is the exact pattern PRD §6 relies on, so prove it plans and runs.
    const { rows: hybrid } = await pool.query<{ label: string }>(
      `SELECT label FROM ${TBL} WHERE bucket = $1 AND id != 1 ORDER BY v <=> $2 LIMIT 5`,
      ["a", toVector(near)],
    );
    if (hybrid.length === 1 && hybrid[0].label === "neighbour") {
      ok("hybrid query (SQL prefilter + vector rank) works");
    } else {
      failures++;
      fail(`hybrid query returned ${hybrid.length} rows: ${hybrid.map((r) => r.label).join(", ")}`);
    }
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${TBL}`).catch(() => {});
  }

  // --- read-only role really is read-only ---
  if (env().DATABASE_URL_READONLY) {
    try {
      const ro = dbReadOnly();
      await ro.query("SELECT 1");
      ok("read-only role connects");
      try {
        await ro.query(`CREATE TABLE _deja_ro_should_fail (id INT)`);
        failures++;
        fail(
          "read-only role was able to CREATE TABLE — the agent's security " +
            "boundary is not enforced. Re-check grants in infra/provision.sh.",
        );
        await pool.query(`DROP TABLE IF EXISTS _deja_ro_should_fail`).catch(() => {});
      } catch {
        ok("read-only role correctly denied write (agent boundary holds)");
      }
    } catch (err) {
      failures++;
      fail(`read-only role failed to connect: ${(err as Error).message}`);
    }
  } else {
    warn("DATABASE_URL_READONLY not set — skipping agent boundary check (Phase 2 needs it)");
  }

  console.log(
    failures === 0
      ? "\n\x1b[32mCockroachDB ready.\x1b[0m\n"
      : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
  );
  await pool.end().catch(() => {});
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n\x1b[31mUnexpected failure\x1b[0m\n", err);
  process.exit(1);
});
