import { type HistoryOutcome } from "./deja-check";

/**
 * Normalized imported trade record (PRD §3.2). Kept field-for-field with the
 * schema so import from any exchange adapter is a straightforward mapping.
 * Values are validated (fail closed) before any store write; users never
 * re-type these by hand.
 */

export interface ImportedTrade {
  exchange: string;
  exchangeOrderId: string;
  asset: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number | null;
  size: number;
  leverage: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  entryAt: string; // ISO-8601
  exitAt: string | null;
  pnl: number | null;
  fees: number | null;
  orderType: string;
  status: string;
}

export function isValidImportedTrade(value: unknown): value is ImportedTrade {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return typeof t.exchange === "string" && t.exchange.length > 0 &&
    typeof t.exchangeOrderId === "string" && t.exchangeOrderId.length > 0 &&
    typeof t.asset === "string" && t.asset.length > 0 &&
    (t.direction === "long" || t.direction === "short") &&
    typeof t.entryPrice === "number" && Number.isFinite(t.entryPrice) && t.entryPrice > 0 &&
    (t.exitPrice === null || (typeof t.exitPrice === "number" && Number.isFinite(t.exitPrice))) &&
    typeof t.size === "number" && Number.isFinite(t.size) && t.size > 0 &&
    (t.leverage === null || (typeof t.leverage === "number" && Number.isFinite(t.leverage))) &&
    (t.stopLoss === null || typeof t.stopLoss === "number") &&
    (t.takeProfit === null || typeof t.takeProfit === "number") &&
    typeof t.entryAt === "string" && Number.isFinite(new Date(t.entryAt).getTime()) &&
    (t.exitAt === null || typeof t.exitAt === "string") &&
    (t.pnl === null || typeof t.pnl === "number") &&
    (t.orderType === null || typeof t.orderType === "string");
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function iso(v: unknown): string | null {
  return typeof v === "string" && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : null;
}

/** Project an imported trade into the HistoryOutcome shape the Déjà vu check / DNA consume. */
export function toHistoryOutcome(t: ImportedTrade): HistoryOutcome {
  const r = t.exitPrice !== null && t.entryPrice > 0
    ? (t.direction === "long" ? (t.exitPrice - t.entryPrice) / t.entryPrice : (t.entryPrice - t.exitPrice) / t.entryPrice)
    : null;
  return {
    tradeId: t.exchangeOrderId,
    asset: t.asset,
    direction: t.direction,
    size: t.size,
    rMultiple: r === null ? 0 : r,
    openedAt: iso(t.entryAt),
  };
}

export class ImportedTradeError extends Error {}

/**
 * Demo history source (PRD §14): a deterministic, clearly-labeled sandbox
 * dataset that reproduces the demo pattern, so the Déjà vu loop is demonstrable
 * before a live exchange adapter or real credentials exist.
 */
export function sandboxDemoHistory(): ImportedTrade[] {
  const now = Date.now();
  const fiveOf: ImportedTrade[] = [];
  for (let i = 0; i < 6; i += 1) {
    const loss = i < 4;
    const entryAt = new Date(now - (7 - i) * 60 * 60_000).toISOString();
    const exitAt = new Date(now - (7 - i) * 60 * 60_000 + 20 * 60_000).toISOString();
    fiveOf.push({
      exchange: "sandbox-demo",
      exchangeOrderId: `demo-btc-long-${i}`,
      asset: "BTC",
      direction: "long",
      entryPrice: 100,
      exitPrice: loss ? 97 : 104,
      size: 1,
      leverage: 5,
      stopLoss: 96,
      takeProfit: 106,
      entryAt,
      exitAt,
      pnl: loss ? -3 : 4,
      fees: 0.1,
      orderType: "market",
      status: "closed",
    });
  }
  return fiveOf;
}

export { numberOrNull };
