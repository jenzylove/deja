import { Pool } from "pg";
import { env } from "./env";

let appPool: Pool | null = null;
let roPool: Pool | null = null;

/** Read/write pool for the application itself. */
export function db(): Pool {
  if (!appPool) {
    appPool = new Pool({
      connectionString: env().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      // Generous: the cluster is multi-region, so first-connection latency is
      // real. The request path guards itself with its own timeouts instead.
      connectionTimeoutMillis: 30_000,
      statement_timeout: 60_000,
    });
  }
  return appPool;
}

/**
 * Read-only pool, used for anything the agent initiates. This is a security
 * boundary, not a convenience: the agent must be unable to write memory or read
 * across tenants even if a prompt tries to make it. Enforced by the role's
 * grants in the database, with this pool as the second line.
 */
export function dbReadOnly(): Pool {
  const url = env().DATABASE_URL_READONLY;
  if (!url) {
    throw new Error(
      "DATABASE_URL_READONLY is not set. The agent's query path requires the " +
        "read-only role — see infra/provision.sh step 3.",
    );
  }
  if (!roPool) {
    roPool = new Pool({
      connectionString: url,
      max: 5,
      connectionTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    });
  }
  return roPool;
}

/** pgvector-compatible literal for a VECTOR column. */
export function toVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
