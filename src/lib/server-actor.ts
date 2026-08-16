import type { AuthenticatedTenantContext } from "./intent-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Temporary server configuration boundary for the first tracer slice.
 *
 * This is deliberately not authentication: it accepts no Request, headers,
 * query, body, or cookie and can bind only a deployment configured for one
 * tenant. Missing or malformed configuration returns no actor and the route
 * fails closed. A real authenticated session resolver remains a release blocker.
 */
export async function resolveConfiguredActor(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<AuthenticatedTenantContext | null> {
  if (environment.DEJA_ACTOR_MODE !== "configured-single-tenant") return null;
  const userId = environment.DEJA_ACTOR_USER_ID;
  if (!userId || !UUID.test(userId)) return null;
  return { userId };
}
