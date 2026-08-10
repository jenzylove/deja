/**
 * Trade-history import.
 *
 * Deliberately not a set of per-exchange schemas. Every broker names its
 * columns differently and changes them without notice, so hard-coding
 * "Binance format" produces something that breaks on the one file that matters.
 * Instead this maps columns by header synonym and reports the mapping it
 * inferred, so a wrong guess is visible before anything is written rather than
 * discovered later in a statistic.
 */

export interface ImportedTrade {
  openedAt: Date;
  closedAt: Date | null;
  asset: string;
  direction: "long" | "short";
  size: number;
  entry: number;
  exit: number | null;
  stop: number | null;
  target: number | null;
  pnl: number | null;
  /** Present only when a stop was recorded; never fabricated. */
  rMultiple: number | null;
}

export interface ImportResult {
  trades: ImportedTrade[];
  mapping: Record<string, string | null>;
  headers: string[];
  skipped: { row: number; reason: string }[];
  detected: string;
}

// ---------------------------------------------------------------------------
// CSV parsing (RFC 4180: quoted fields, embedded commas and newlines, BOM)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\r") continue;
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

// ---------------------------------------------------------------------------
// Column inference
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Order matters: the first synonym that matches a header wins. */
const SYNONYMS: Record<string, string[]> = {
  openedAt: ["opentime", "entrytime", "opendate", "tradetime", "datetime", "date", "time", "createtime", "timestamp", "openedat"],
  closedAt: ["closetime", "exittime", "closedate", "closingtime", "closedat", "updatetime"],
  asset: ["symbol", "market", "pair", "instrument", "ticker", "contracts", "contract", "asset"],
  direction: ["side", "direction", "type", "positionside", "closingdirection", "tradeside", "longshort"],
  size: ["qty", "quantity", "size", "volume", "amount", "filledqty", "lots", "contractsqty"],
  // Bare "price" is last on purpose: it must never win against an explicit
  // entry/exit column, but MT5 and Binance label the fill price with it alone.
  entry: ["entryprice", "openprice", "avgentryprice", "priceopen", "openavgprice", "entry", "price"],
  exit: ["exitprice", "closeprice", "avgexitprice", "priceclose", "exit", "closeavgprice"],
  stop: ["stoploss", "sl", "stopprice", "stop"],
  target: ["takeprofit", "tp", "targetprice", "target"],
  // "P&L" normalises to "pl" once punctuation is stripped, which is why the
  // pnl variants are spelled both ways.
  pnl: ["realizedpnl", "realizedpl", "realisedpnl", "realisedpl", "realizedprofit",
        "closedpnl", "closedpl", "netpnl", "netpl", "profitloss", "pnl", "pl",
        "profit", "netprofit", "grossprofit"],
};

function inferMapping(headers: string[]): Record<string, string | null> {
  const normed = headers.map(norm);
  const used = new Set<number>();
  const mapping: Record<string, string | null> = {};

  for (const [field, syns] of Object.entries(SYNONYMS)) {
    let found: number | null = null;
    // Exact normalised match first — far safer than substring, which would let
    // "price" capture "stopprice".
    for (const syn of syns) {
      const i = normed.findIndex((h, idx) => h === syn && !used.has(idx));
      if (i !== -1) { found = i; break; }
    }
    if (found === null) {
      for (const syn of syns) {
        const i = normed.findIndex((h, idx) => h.includes(syn) && !used.has(idx));
        if (i !== -1) { found = i; break; }
      }
    }
    if (found !== null) { used.add(found); mapping[field] = headers[found]; }
    else mapping[field] = null;
  }
  return mapping;
}

function detectSource(headers: string[]): string {
  const h = headers.map(norm).join("|");
  if (h.includes("closedpnl") && h.includes("contracts")) return "Bybit (closed P&L)";
  if (h.includes("realizedprofit") || (h.includes("symbol") && h.includes("quoteqty"))) return "Binance";
  if (h.includes("swap") && h.includes("commission")) return "MetaTrader";
  if (h.includes("closedpnl") || h.includes("realizedpnl")) return "exchange export";
  return "generic CSV";
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  // Strip currency symbols, thousands separators, and parenthesised negatives.
  let s = v.trim().replace(/[$€£,\s]/g, "");
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (s.endsWith("%")) s = s.slice(0, -1);
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function date(v: string | undefined): Date | null {
  if (!v?.trim()) return null;
  const s = v.trim();
  // Epoch seconds or millis.
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return new Date(Number(s));
  // "2026-01-04 13:22:05" — treat naive timestamps as UTC rather than letting
  // the importer's local zone silently shift every session bucket.
  const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (naive) {
    const [, y, mo, d, h, mi, se] = naive;
    return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se ?? 0)));
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function direction(v: string | undefined): "long" | "short" | null {
  if (!v) return null;
  const s = norm(v);
  // Checked first: "Close Long" names what the POSITION was, not the action
  // that closed it. Reading it as a sell inverts every direction cohort.
  if (s.includes("closelong") || s.includes("sellclose")) return "long";
  if (s.includes("closeshort") || s.includes("buyclose")) return "short";
  if (/^(buy|long|b|bull)/.test(s)) return "long";
  if (/^(sell|short|s|bear)/.test(s)) return "short";
  return null;
}

/**
 * Strips a crypto quote currency, and only that.
 *
 * Bare "USD" is excluded deliberately: XAUUSD and EURUSD are indivisible forex
 * symbols, and cutting the suffix turns gold into "XAU" and the euro pair into
 * "EUR" — two instruments that do not exist, silently splitting a trader's
 * history into cohorts that cannot be compared.
 */
function baseSymbol(sym: string): string {
  const stripped = sym.replace(/[-_/]?(USDT|USDC|BUSD|PERP)$/i, "");
  return stripped || sym;
}

// ---------------------------------------------------------------------------

export function importCsv(text: string): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    return { trades: [], mapping: {}, headers: [], skipped: [], detected: "empty" };
  }

  const headers = rows[0].map((h) => h.trim());
  const mapping = inferMapping(headers);
  const detected = detectSource(headers);
  const idx = (field: string) => {
    const col = mapping[field];
    return col === null ? -1 : headers.indexOf(col);
  };

  const cols = Object.fromEntries(
    Object.keys(SYNONYMS).map((f) => [f, idx(f)]),
  ) as Record<string, number>;

  const trades: ImportedTrade[] = [];
  const skipped: { row: number; reason: string }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const raw = rows[i];
    const get = (f: string) => (cols[f] >= 0 ? raw[cols[f]] : undefined);

    const openedAt = date(get("openedAt"));
    const asset = get("asset")?.trim().toUpperCase();
    const dir = direction(get("direction"));
    const entry = num(get("entry"));
    const pnl = num(get("pnl"));

    // A row without a time, an instrument or a direction cannot participate in
    // any cohort, so it is dropped loudly rather than imported half-formed.
    if (!openedAt) { skipped.push({ row: i + 1, reason: "no parseable date" }); continue; }
    if (!asset) { skipped.push({ row: i + 1, reason: "no symbol" }); continue; }
    if (!dir) { skipped.push({ row: i + 1, reason: `unrecognised side "${get("direction") ?? ""}"` }); continue; }
    if (entry === null && pnl === null) {
      skipped.push({ row: i + 1, reason: "neither entry price nor P&L" });
      continue;
    }

    const exit = num(get("exit"));
    const stop = num(get("stop"));

    // R is only computed when a real stop was recorded. Inferring risk from
    // position size would invent the denominator, and every downstream R
    // statistic would then be measuring a guess.
    let rMultiple: number | null = null;
    if (stop !== null && entry !== null && exit !== null && stop !== entry) {
      const risk = Math.abs(entry - stop);
      const move = dir === "long" ? exit - entry : entry - exit;
      rMultiple = Number((move / risk).toFixed(3));
    }

    trades.push({
      openedAt,
      closedAt: date(get("closedAt")) ?? null,
      asset: baseSymbol(asset),
      direction: dir,
      size: num(get("size")) ?? 0,
      entry: entry ?? 0,
      exit,
      stop,
      target: num(get("target")),
      pnl,
      rMultiple,
    });
  }

  trades.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  return { trades, mapping, headers, skipped, detected };
}


/**
 * Pairs a fill log into round-trip trades.
 *
 * Binance and several others export one row per FILL, not per trade: a buy row
 * and a sell row are two halves of the same position. Imported as-is they
 * become phantom trades with no exit and an entry of zero, and every statistic
 * downstream inherits that. Detected by the absence of an exit column combined
 * with both directions appearing for the same symbol.
 *
 * Flat-to-flat FIFO: same-direction fills accumulate into a weighted-average
 * entry, an opposite-direction fill closes the position. Partial closes settle
 * the matched quantity and leave the remainder open, which is the behaviour a
 * scale-out produces.
 */
export function pairFills(trades: ImportedTrade[]): ImportedTrade[] {
  const bySymbol = new Map<string, ImportedTrade[]>();
  for (const t of trades) {
    if (!bySymbol.has(t.asset)) bySymbol.set(t.asset, []);
    bySymbol.get(t.asset)!.push(t);
  }

  const out: ImportedTrade[] = [];
  for (const [, fills] of bySymbol) {
    let side: "long" | "short" | null = null;
    let qty = 0;
    let cost = 0;
    let openedAt: Date | null = null;
    let pnlAccum = 0;

    for (const f of fills) {
      const price = f.entry || f.exit || 0;
      const size = Math.abs(f.size) || 0;

      if (side === null || f.direction === side) {
        if (side === null) { side = f.direction; openedAt = f.openedAt; }
        qty += size;
        cost += size * price;
        pnlAccum += f.pnl ?? 0;
        continue;
      }

      // Opposite direction: closes up to `qty`.
      const matched = Math.min(qty, size);
      if (matched > 0 && openedAt) {
        const avgEntry = qty > 0 ? cost / qty : 0;
        pnlAccum += f.pnl ?? 0;
        out.push({
          openedAt,
          closedAt: f.openedAt,
          asset: f.asset,
          direction: side,
          size: matched,
          entry: Number(avgEntry.toFixed(8)),
          exit: price,
          stop: null,
          target: null,
          // Prefer the exchange's own realised figure; only fall back to
          // deriving it from prices when the export omits one.
          pnl: pnlAccum !== 0
            ? Number(pnlAccum.toFixed(2))
            : Number(((side === "long" ? price - avgEntry : avgEntry - price) * matched).toFixed(2)),
          rMultiple: null,
        });
      }
      const leftover = size - matched;
      qty -= matched;
      cost = qty > 0 ? (cost / (qty + matched)) * qty : 0;
      pnlAccum = 0;
      if (qty <= 1e-12) {
        if (leftover > 1e-12) { side = f.direction; qty = leftover; cost = leftover * price; openedAt = f.openedAt; }
        else { side = null; qty = 0; cost = 0; openedAt = null; }
      }
    }
  }

  return out.sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
}

/** True when rows look like individual fills rather than round-trip trades. */
export function looksLikeFillLog(
  trades: ImportedTrade[],
  mapping: Record<string, string | null>,
): boolean {
  if (mapping.exit !== null) return false;
  const sides = new Map<string, Set<string>>();
  for (const t of trades) {
    if (!sides.has(t.asset)) sides.set(t.asset, new Set());
    sides.get(t.asset)!.add(t.direction);
  }
  return [...sides.values()].some((s) => s.size > 1);
}

/**
 * Derives post-loss re-entries from timestamps alone.
 *
 * This is the honest half of the behavioural signal: it needs no journalling,
 * no cooperation, and works on any flat export. A trader who would never admit
 * to revenge trading still leaves it in the timestamps.
 */
export function deriveRevengeEntries(
  trades: ImportedTrade[],
  withinMinutes = 20,
): Set<number> {
  const flagged = new Set<number>();
  let lastLossAt: number | null = null;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    if (lastLossAt !== null && (t.openedAt.getTime() - lastLossAt) / 60000 < withinMinutes) {
      flagged.add(i);
    }
    const lost = t.pnl !== null ? t.pnl < 0 : t.rMultiple !== null ? t.rMultiple < 0 : false;
    lastLossAt = lost ? (t.closedAt ?? t.openedAt).getTime() : null;
  }
  return flagged;
}
