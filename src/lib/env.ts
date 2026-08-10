import { z } from "zod";

/**
 * Fail loudly at boot rather than at the first Bedrock call. A missing model id
 * discovered mid-demo is a much worse outcome than a refusal to start.
 */
const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_READONLY: z.string().min(1).optional(),

  AWS_REGION: z.string().default("us-east-1"),
  AWS_BEARER_TOKEN_BEDROCK: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  BEDROCK_MODEL_FAST: z.string().min(1),
  BEDROCK_MODEL_REASONING: z.string().min(1),
  BEDROCK_MODEL_EMBED: z.string().min(1),
  EMBED_DIMS: z.coerce.number().int().positive().default(1024),

  PRICE_API_BASE: z.string().url().default("https://api.coinbase.com/v2"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment.\n${missing}\n\nSee .env.example.`);
  }

  const e = parsed.data;
  const hasBearer = Boolean(e.AWS_BEARER_TOKEN_BEDROCK);
  const hasKeypair = Boolean(e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY);
  if (!hasBearer && !hasKeypair) {
    throw new Error(
      "No Bedrock credentials. Set AWS_BEARER_TOKEN_BEDROCK (Bedrock console → " +
        "API keys), or both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.",
    );
  }

  cached = e;
  return e;
}
