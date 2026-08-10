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
 * Whether the text is being stored or searched with.
 *
 * This distinction is the whole reason for the embedding model choice. A stored
 * thesis and a query about it play different roles, and a model that embeds
 * them into the same symmetric space cannot express that. Measured on the
 * seeded corpus: Titan v2 scored 60% strategy purity, Cohere v4 with asymmetric
 * input types scored 80%, against a 42% majority-class share. See
 * scripts/compare-embeddings.ts — the comparison is reproducible.
 */
export type EmbedRole = "document" | "query";

function isCohere(modelId: string): boolean {
  return modelId.startsWith("cohere.");
}

async function embedBatch(texts: string[], role: EmbedRole): Promise<number[][]> {
  const e = env();
  const modelId = e.BEDROCK_MODEL_EMBED;

  if (isCohere(modelId)) {
    const res = await bedrock().send(
      new InvokeModelCommand({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          texts,
          input_type: role === "query" ? "search_query" : "search_document",
          embedding_types: ["float"],
          output_dimension: e.EMBED_DIMS,
        }),
      }),
    );
    const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
      embeddings?: { float?: number[][] } | number[][];
    };
    const raw = parsed.embeddings;
    const vecs = Array.isArray(raw) ? raw : raw?.float;
    if (!vecs) throw new Error("No embeddings returned from Cohere");
    return vecs;
  }

  // Titan and similar: symmetric, one text per call, role ignored.
  return Promise.all(
    texts.map(async (text) => {
      const res = await bedrock().send(
        new InvokeModelCommand({
          modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({ inputText: text, dimensions: e.EMBED_DIMS, normalize: true }),
        }),
      );
      const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding?: number[] };
      if (!parsed.embedding) throw new Error("No embedding returned");
      return parsed.embedding;
    }),
  );
}

/**
 * Dimension is asserted against the schema on every call — a model swap that
 * silently changes width would poison every retrieval without erroring.
 */
export async function embed(text: string, role: EmbedRole = "document"): Promise<number[]> {
  const e = env();
  const [vec] = await embedBatch([text], role);
  if (!vec || vec.length !== e.EMBED_DIMS) {
    throw new Error(
      `Embedding dimension mismatch: got ${vec?.length ?? 0}, expected ${e.EMBED_DIMS}. ` +
        `The schema's VECTOR column and EMBED_DIMS must agree.`,
    );
  }
  return vec;
}

/** Embed a search query. Never use embed() for this on an asymmetric model. */
export const embedQuery = (text: string) => embed(text, "query");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isThrottle(err: unknown): boolean {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "ThrottlingException" ||
    e?.$metadata?.httpStatusCode === 429 ||
    /too many requests|throttl/i.test(e?.message ?? "")
  );
}

/**
 * Retries throttling with exponential backoff and jitter. Bedrock's on-demand
 * embedding quota is low enough that any bulk operation will hit it, so this is
 * the normal path rather than an edge case.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isThrottle(err) || i === attempts - 1) throw err;
      // Jitter matters: without it, a throttled batch retries in lockstep and
      // throttles again at exactly the same moment.
      await sleep(Math.min(8000, 2 ** i * 400) + Math.random() * 300);
    }
  }
  throw lastErr;
}

export async function embedMany(
  texts: string[],
  opts: {
    role?: EmbedRole;
    batchSize?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<number[][]> {
  const role = opts.role ?? "document";
  // Cohere accepts many texts per call, which is dramatically cheaper on
  // request quota than one-at-a-time; Titan does not, so the batch degrades to
  // bounded concurrency inside embedBatch.
  const width = opts.batchSize ?? (isCohere(env().BEDROCK_MODEL_EMBED) ? 90 : 3);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += width) {
    const slice = texts.slice(i, i + width);
    out.push(...(await withRetry(() => embedBatch(slice, role))));
    opts.onProgress?.(Math.min(i + width, texts.length), texts.length);
  }
  return out;
}
