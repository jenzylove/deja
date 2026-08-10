/**
 * Creates the `deja` database and the read-only role the agent queries through.
 *
 * The read-only role is a security boundary, not a convenience. The agent's
 * retrieval path must be unable to write memory or read another tenant even if
 * a prompt tries to make it — so it gets a separate credential whose grants
 * make writes impossible at the database, and verify-db asserts that.
 *
 *   npm run db:bootstrap
 */
import "./load-env";
import { Client } from "pg";
import { randomBytes } from "node:crypto";

const DB = "deja";
const RO_USER = "deja_agent_ro";

function adminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — see .env.example");
  // Connect to defaultdb to create the target database; the configured URL may
  // already point at a database that does not exist yet.
  const u = new URL(url);
  u.pathname = "/defaultdb";
  return u.toString();
}

async function main() {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();

  const { rows: v } = await client.query<{ version: string }>("SELECT version()");
  console.log(`\nConnected — ${v[0].version.split(" ").slice(0, 3).join(" ")}\n`);

  await client.query(`CREATE DATABASE IF NOT EXISTS ${DB}`);
  console.log(`  ✓ database "${DB}" ready`);

  // Reuse an existing password if the caller already configured one, so reruns
  // do not silently invalidate a working .env.local.
  const existing = process.env.DATABASE_URL_READONLY;
  let roPassword: string | null = null;
  if (existing && !existing.includes("PASSWORD")) {
    try {
      roPassword = decodeURIComponent(new URL(existing).password) || null;
    } catch {
      /* fall through to generating a new one */
    }
  }
  const generated = !roPassword;
  if (!roPassword) roPassword = randomBytes(24).toString("base64url");

  await client.query(
    `CREATE USER IF NOT EXISTS ${RO_USER} WITH PASSWORD $1`,
    [roPassword],
  );
  // Idempotent: also resets the password on rerun so the role and the env agree.
  await client.query(`ALTER USER ${RO_USER} WITH PASSWORD $1`, [roPassword]);
  console.log(`  ✓ role "${RO_USER}" ready${generated ? " (new password generated)" : ""}`);

  await client.query(`GRANT CONNECT ON DATABASE ${DB} TO ${RO_USER}`);
  await client.end();

  // Remaining grants must run inside the target database.
  const inDb = new Client({ connectionString: (() => {
    const u = new URL(process.env.DATABASE_URL!);
    u.pathname = `/${DB}`;
    return u.toString();
  })() });
  await inDb.connect();

  // CockroachDB grants CREATE on the public schema to the built-in `public`
  // role by default, and every user inherits it — so a "read-only" role can
  // still create tables. Revoke it, or the agent's boundary is decorative.
  // Verified by verify-db, which actively attempts a write as this role.
  await inDb.query(`REVOKE CREATE ON SCHEMA public FROM public`);
  await inDb.query(`REVOKE ALL ON DATABASE ${DB} FROM public`);
  await inDb.query(`REVOKE ALL ON SCHEMA public FROM ${RO_USER}`);

  await inDb.query(`GRANT USAGE ON SCHEMA public TO ${RO_USER}`);
  await inDb.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${RO_USER}`);
  await inDb.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${RO_USER}`,
  );
  console.log(`  ✓ SELECT-only grants applied (incl. future tables)`);
  await inDb.end();

  const roUrl = (() => {
    const u = new URL(process.env.DATABASE_URL!);
    u.pathname = `/${DB}`;
    u.username = RO_USER;
    u.password = roPassword!;
    return u.toString();
  })();

  console.log(`\nPut these in .env.local:\n`);
  console.log(`DATABASE_URL_READONLY="${roUrl}"\n`);
  console.log(`Then run: npm run verify:db\n`);
}

main().catch((err) => {
  console.error("\nBootstrap failed:", (err as Error).message);
  process.exit(1);
});
