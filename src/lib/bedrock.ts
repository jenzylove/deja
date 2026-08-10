import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ConverseCommand,
  type Message,
} from "@aws-sdk/client-bedrock-runtime";
import { env } from "./env";

let cached: BedrockRuntimeClient | null = null;

export function bedrock(): BedrockRuntimeClient {
  if (cached) return cached;
  const e = env();

  // The SDK picks up AWS_BEARER_TOKEN_BEDROCK from the environment on its own,
  // so an explicit credentials object is only needed for the IAM keypair path.
  cached = new BedrockRuntimeClient({
    region: e.AWS_REGION,
    ...(e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: e.AWS_ACCESS_KEY_ID,
            secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });
  return cached;
}

export type ChatTier = "fast" | "reasoning";

function modelFor(tier: ChatTier): string {
  const e = env();
  return tier === "fast" ? e.BEDROCK_MODEL_FAST : e.BEDROCK_MODEL_REASONING;
}

/**
 * Single chat entry point. `fast` handles the high-volume canonicalization on
 * every intent; `reasoning` handles brief generation and rule compilation,
 * where getting it wrong is expensive.
 */
export async function chat(opts: {
  tier: ChatTier;
  system?: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
}): Promise<{ text: string; modelId: string; inputTokens: number; outputTokens: number }> {
  const modelId = modelFor(opts.tier);

  const res = await bedrock().send(
    new ConverseCommand({
      modelId,
      system: opts.system ? [{ text: opts.system }] : undefined,
      messages: opts.messages,
      inferenceConfig: {
        maxTokens: opts.maxTokens ?? 2048,
        // Default to 0: briefs are grounded reports over retrieved rows, and
        // run-to-run variation in a statistical claim is not a feature.
        temperature: opts.temperature ?? 0,
      },
    }),
  );

  const text =
    res.output?.message?.content
      ?.map((c) => ("text" in c ? c.text : ""))
      .join("")
      .trim() ?? "";

  return {
    text,
    modelId,
    inputTokens: res.usage?.inputTokens ?? 0,
    outputTokens: res.usage?.outputTokens ?? 0,
  };
}

/**
 * Titan Text Embeddings V2. Dimension must match the VECTOR(n) column — a
 * mismatch here silently poisons every retrieval, so it is asserted.
 */
export async function embed(text: string): Promise<number[]> {
  const e = env();

  const res = await bedrock().send(
    new InvokeModelCommand({
      modelId: e.BEDROCK_MODEL_EMBED,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text,
        dimensions: e.EMBED_DIMS,
        normalize: true,
      }),
    }),
  );

  const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
    embedding?: number[];
  };
  const vec = parsed.embedding;

  if (!vec || vec.length !== e.EMBED_DIMS) {
    throw new Error(
      `Embedding dimension mismatch: got ${vec?.length ?? 0}, expected ${e.EMBED_DIMS}. ` +
        `The schema's VECTOR column and EMBED_DIMS must agree.`,
    );
  }
  return vec;
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  // Titan has no batch endpoint; bound the concurrency so bulk CSV import
  // doesn't trip throttling.
  const out: number[][] = [];
  const width = 5;
  for (let i = 0; i < texts.length; i += width) {
    const slice = texts.slice(i, i + width);
    out.push(...(await Promise.all(slice.map(embed))));
  }
  return out;
}
