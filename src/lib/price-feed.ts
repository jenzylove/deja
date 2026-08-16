import type { PriceFeed, PriceResolution } from "./paper-ops";

/**
 * Free, no-key crypto price source (CoinGecko public simple-price endpoint).
 * Used as the default monitoring feed so stop/target auto-close resolves real
 * prices without any signup. Fails closed: any network error, non-200, or
 * malformed/untrusted body returns `{available:false}` (manual close only) and
 * never fabricates a price.
 */

const SYMBOL_TO_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  DOT: "polkadot",
  AVAX: "avalanche-2",
  LINK: "chainlink",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
  LTC: "litecoin",
  BNB: "binancecoin",
  USDC: "usd-coin",
  USDT: "tether",
};

export interface CoinGeckoFetch {
  (input: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

function priceFromBody(untrusted: unknown, id: string): number | null {
  if (typeof untrusted !== "object" || untrusted === null || Array.isArray(untrusted)) return null;
  const body = untrusted as Record<string, unknown>;
  const byId = body[id];
  if (typeof byId !== "object" || byId === null || Array.isArray(byId)) return null;
  const usd = (byId as Record<string, unknown>).usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return null;
  return usd;
}

export function coinGeckoPriceFeed(
  options: {
    fetch?: CoinGeckoFetch;
    base?: string;
    now?: () => string;
  } = {},
): PriceFeed {
  const fetchImpl = options.fetch ?? ((input) => fetch(input));
  const base = options.base ?? "https://api.coingecko.com/api/v3";
  const now = options.now ?? (() => new Date().toISOString());

  return {
    async resolve(asset: string): Promise<PriceResolution> {
      const id = SYMBOL_TO_ID[(asset || "").trim().toUpperCase()];
      if (!id) return { available: false };
      let raw: unknown;
      try {
        const response = await fetchImpl(`${base}/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=usd`);
        if (!response.ok || response.status !== 200) return { available: false };
        raw = await response.json();
      } catch {
        return { available: false };
      }
      const price = priceFromBody(raw, id);
      if (price === null) return { available: false };
      return { available: true, price, at: now() };
    },
  };
}

export const defaultPriceFeed: PriceFeed = coinGeckoPriceFeed();

export const SYMBOLS_SUPPORTED = Object.keys(SYMBOL_TO_ID).sort();