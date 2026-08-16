import { z } from "zod";

/**
 * Environment parsing for Deja. In a live CockroachDB/price-feed deployment the
 * provider values are present; in a standalone in-memory deploy they are
 * OPTIONAL and the app degrades gracefully (in-memory store, manual-close-only
 * monitoring) instead of refusing to boot. Only the provider scripts that
 * really need credentials enforce strictness (see scripts/*).
 *
 * Use env(true) when a caller truly requires a live credential and the action
 * cannot proceed without it.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_URL_READONLY: z.string().min(1).optional(),

  AWS_REGION: z.string().default("us-east-1"),
  AWS_BEARER_TOKEN_BEDROCK: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  BEDROCK_MODEL_FAST: z.string().min(1).default(""),
  BEDROCK_MODEL_REASONING: z.string().min(1).default(""),
  BEDROCK_MODEL_EMBED: z.string().min(1).default(""),
  EMBED_DIMS: z.coerce.number().int().positive().default(1024),

  PRICE_API_BASE: z.string().url().default("https://api.coinbase.com/v2"),
});

export type Env = z.infer<typeof schema>;

export interface EnvStatus {
  hasDatabase: boolean;
  hasBedrock: boolean;
}

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment.\n${
      parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")
    }\n\nSee .env.example.`);
  }

  cached = parsed.data;
  return parsed.data;
}

/** Report which live integrations are configured, without throwing on absence. */
export function envStatus(): EnvStatus {
  const e = env();
  const hasDatabase = Boolean(e.DATABASE_URL);
  const hasBearer = Boolean(e.AWS_BEARER_TOKEN_BEDROCK);
  const hasKeypair = Boolean(e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY);
  return { hasDatabase, hasBedrock: hasBearer || hasKeypair };
}

/** True when the configured integrations let the app boot standalone (degraded) mode. */
export function isStandalone(): boolean {
  return !envStatus().hasDatabase;
}