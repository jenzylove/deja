import { chat, embed } from "./bedrock";
import type { Message } from "@aws-sdk/client-bedrock-runtime";

/**
 * Turns a trader's free-text rationale into structured attributes plus a
 * canonical rendering that is stable enough to embed.
 *
 * Why not embed the raw text: short trading prose is dominated by asset name
 * and direction, so "BTC long, broke resistance" and "BTC long, bought the dip"
 * land close together while the same setup on ETH lands far away. Embedding a
 * fixed template of *situation* rather than *wording* is what lets retrieval
 * connect "broke resistance and retested" to "reclaimed the range high and held
 * it as support" — different words, same trade. PRD §4.3.
 */

export const STRATEGIES = [
  "breakout_retest", "reversal", "momentum", "range", "trend_pullback",
  "news", "scalp", "other",
] as const;
export type Strategy = (typeof STRATEGIES)[number];

export const MARKET_THESES = ["continuation", "reversal", "mean_revert"] as const;
export type MarketThesis = (typeof MARKET_THESES)[number];

export interface CanonicalThesis {
  strategy: Strategy;
  signals: string[];
  marketThesis: MarketThesis;
  /** Whether the trader's own words indicate the setup has confirmed yet. */
  confirmationStated: boolean;
  canonical: string;
}

const SYSTEM = `You normalise a trader's stated reason for a trade into structured attributes.

Rules:
- Choose exactly one strategy from: ${STRATEGIES.join(", ")}
- Choose exactly one market_thesis from: ${MARKET_THESES.join(", ")}
- market_thesis describes what the trader expects the PRICE to do next, in the
  direction of their position — not the shape of the setup:
    continuation = expects the prevailing move to extend
    reversal     = expects the prevailing move to turn
    mean_revert  = expects a stretched price to snap back to an average
  "Sold into exhaustion expecting a pullback" is reversal, not continuation.
- signals: 2-5 short lowercase noun phrases naming the observable conditions the
  trader cited (e.g. "resistance breakout", "volume expansion", "retest holding").
  Only what they actually said. Do not infer signals they did not mention.
- confirmation_stated: true only if the trader explicitly says the setup has
  already confirmed (candle closed, retest held, level reclaimed and held).
  Anticipation ("looks like it will hold", "expecting") is false.
- Never judge the trade. Never predict the market. You are normalising language.

Respond with JSON only, no prose:
{"strategy":"...","signals":["..."],"market_thesis":"...","confirmation_stated":true|false}`;

/**
 * Carries only what distinguishes one setup from another.
 *
 * Asset, direction, asset class, regime and session are all excluded on
 * purpose. Every one of them is either a hard SQL prefilter or a rerank
 * attribute, so including them here adds text identical across most rows —
 * shared boilerplate that dominates cosine similarity and compresses the range
 * the vector can actually discriminate over. Measured: including the context
 * scaffolding put a paraphrase at 0.695 and an unrelated setup at 0.666, a gap
 * of 0.03. Stripping it widens that materially.
 */
function renderCanonical(input: {
  strategy: Strategy;
  signals: string[];
  marketThesis: MarketThesis;
}): string {
  return [
    input.strategy.replace(/_/g, " "),
    input.signals.join(", ") || "no signals stated",
    `expecting ${input.marketThesis.replace(/_/g, " ")}`,
  ].join("; ");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON object in model output: ${text.slice(0, 200)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

function coerce<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

export async function canonicalizeThesis(input: {
  thesisRaw: string;
  direction: string;
  assetClass: string;
  regime: string;
  session: string;
}): Promise<CanonicalThesis> {
  const messages: Message[] = [
    {
      role: "user",
      content: [
        {
          text:
            `Trade: ${input.direction} on ${input.assetClass}, ` +
            `${input.regime} market, ${input.session} session.\n\n` +
            `Trader's stated reason:\n"""${input.thesisRaw}"""`,
        },
      ],
    },
  ];

  // Fast tier: this runs on every single intent, and it is normalisation, not
  // judgement — the expensive model is reserved for the brief.
  const res = await chat({ tier: "fast", system: SYSTEM, messages, maxTokens: 400 });
  const parsed = extractJson(res.text) as Record<string, unknown>;

  const strategy = coerce(parsed.strategy, STRATEGIES, "other");
  const marketThesis = coerce(parsed.market_thesis, MARKET_THESES, "continuation");
  const signals = Array.isArray(parsed.signals)
    ? parsed.signals.filter((s): s is string => typeof s === "string").slice(0, 5)
    : [];

  return {
    strategy,
    signals,
    marketThesis,
    confirmationStated: parsed.confirmation_stated === true,
    canonical: renderCanonical({ strategy, signals, marketThesis }),
  };
}

/** Canonicalise and embed in one step — the shape the intent path needs. */
export async function canonicalizeAndEmbed(input: {
  thesisRaw: string;
  direction: string;
  assetClass: string;
  regime: string;
  session: string;
}): Promise<CanonicalThesis & { embedding: number[] }> {
  const c = await canonicalizeThesis(input);
  return { ...c, embedding: await embed(c.canonical) };
}

/** UTC hour → trading session. Used for both context and behavioural cohorts. */
export function sessionForDate(d: Date): "asia" | "london" | "ny" | "off" {
  const h = d.getUTCHours();
  if (h >= 0 && h < 7) return "asia";
  if (h >= 7 && h < 13) return "london";
  if (h >= 13 && h < 21) return "ny";
  return "off";
}
