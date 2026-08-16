import { randomUUID } from "node:crypto";

import {
  PaperTradeError,
  closePaperTrade,
  type ExitReason,
  type PaperClosureStore,
  type TrustedTenantContext,
} from "./paper-trade";

export const BEHAVIOR_EVENT_VERSION = 1;

export type BehaviorEventType =
  | "decision" | "execution" | "closure" | "monitoring" | "settlement";
export type BehaviorAvailability =
  | "atomic" | "price_feed_available" | "price_feed_unavailable" | "n/a";
export type BehaviorAcceptance =
  | "accepted" | "blocked" | "defied" | "new" | "replayed"
  | "closed" | "already_closed" | "check" | "stop_hit" | "target_hit"
  | "manual_close_only" | "settled" | "already_settled" | "n/a";

export interface BehaviorEventVerification {
  idempotent: boolean;
  decision: "PASS" | "WARN" | "BLOCK" | null;
}

/**
 * Versioned, append-only behavioral event. Every event is derived from real
 * store activity (decision/execution writes, closure writes, monitoring
 * evaluations of actually-open trades, settlement writes) — never fabricated
 * by the browser. `availability` records whether an external source (price
 * feed) was present; `acceptance` records whether the operation was accepted
 * or overridden; `outcome` carries finite sanitized numbers; `verification`
 * records idempotency/replay and the trusted decision.
 */
export interface BehaviorEvent {
  version: number;
  id: string;
  userId: string;
  type: BehaviorEventType;
  at: string;
  subjectKind: "trade" | "intent";
  subjectId: string | null;
  availability: BehaviorAvailability;
  acceptance: BehaviorEventAcceptance;
  outcome: Readonly<Record<string, string | number | boolean | null>> | null;
  verification: Readonly<BehaviorEventVerification>;
}

export type BehaviorEventAcceptance =
  | "accepted" | "blocked" | "defied" | "new" | "replayed"
  | "closed" | "already_closed" | "check" | "stop_hit" | "target_hit"
  | "manual_close_only" | "settled" | "already_settled" | "n/a";

export interface PriceAvailable { available: true; price: number; at: string }
export interface PriceUnavailable { available: false }
export type PriceResolution = PriceAvailable | PriceUnavailable;

/**
 * Injectable simulated price source. The price feed is unavailable in this
 * environment; default wiring provides a feed that always fails closed to
 * manual-close-only, and a deterministic feed is injected only as a test seam
 * or server-config boundary. An adapter returns {available:false} rather than
 * guessing a price, so the system never claims real market data.
 */
export interface PriceFeed {
  resolve(asset: string): Promise<PriceResolution>;
}

/** Default feed: never claims real market data and always fails closed to manual-close-only. */
export const unavailablePriceFeed: PriceFeed = {
  async resolve() {
    return { available: false };
  },
};

export interface MonitorableOpenTrade {
  tradeId: string;
  intentId: string;
  asset: string;
  direction: "long" | "short";
  entryFill: number;
  size: number;
  stop: number | null;
  target: number | null;
  openedAt: string;
}

export interface SettleableTrade {
  tradeId: string;
  asset: string;
  direction: string;
  pnl: number;
  rMultiple: number;
  exitReason: ExitReason;
  closedAt: string;
}

export type SettleAttempt =
  | { state: "settled"; pnl: number; rMultiple: number }
  | { state: "already_settled"; pnl: number; rMultiple: number };

export interface PaperOpsStore extends PaperClosureStore {
  listMonitorableOpenTrades(userId: string): Promise<MonitorableOpenTrade[]>;
  recordBehaviorEvent(event: BehaviorEvent): Promise<void>;
  listBehaviorEvents(userId: string): Promise<BehaviorEvent[]>;
  listSettleableTrades(userId: string): Promise<SettleableTrade[]>;
  settleAtomic(userId: string, tradeId: string, settledAt: string): Promise<SettleAttempt>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string");
}

function trustedTenant(raw: unknown): TrustedTenantContext {
  if (!record(raw) || Object.keys(raw).length !== 1 || !uuid(raw.userId)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  return { userId: raw.userId };
}

/** Capture untrusted data once via descriptors, then validate the frozen copy. */
function snapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const source = value as object;
  const prototype = Object.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  if (Array.isArray(source)) {
    const copy: unknown[] = [];
    for (let index = 0; index < source.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(source, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new PaperTradeError("INVALID_REQUEST");
      copy.push(snapshot(descriptor.value));
    }
    return Object.freeze(copy);
  }
  const copy: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") throw new PaperTradeError("INVALID_REQUEST");
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new PaperTradeError("INVALID_REQUEST");
    copy[key] = snapshot(descriptor.value);
  }
  return Object.freeze(copy);
}

const EVT_FIELDS = new Set([
  "version", "id", "userId", "type", "at", "subjectKind", "subjectId",
  "availability", "acceptance", "outcome", "verification",
]);
const VERIFICATION_FIELDS = new Set(["idempotent", "decision"]);
const EVENT_TYPES = ["decision", "execution", "closure", "monitoring", "settlement"] as const;

/** Validate an untrusted behavioral event against the versioned contract. */
export function validateBehaviorEvent(untrusted: unknown): BehaviorEvent {
  const value = snapshot(untrusted);
  if (!record(value) || Object.keys(value).length !== EVT_FIELDS.size ||
      Object.keys(value).some((key) => !EVT_FIELDS.has(key)) ||
      value.version !== BEHAVIOR_EVENT_VERSION ||
      !uuid(value.id) || !uuid(value.userId) || !instant(value.at) ||
      !EVENT_TYPES.includes(value.type as BehaviorEventType) ||
      (value.subjectKind !== "trade" && value.subjectKind !== "intent") ||
      (value.subjectId !== null && !uuid(value.subjectId)) ||
      typeof value.availability !== "string" || typeof value.acceptance !== "string" ||
      (value.outcome !== null && !record(value.outcome))) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  if (!record(value.verification) || Object.keys(value.verification).length !== VERIFICATION_FIELDS.size ||
      Object.keys(value.verification).some((key) => !VERIFICATION_FIELDS.has(key)) ||
      typeof value.verification.idempotent !== "boolean" ||
      (value.verification.decision !== null && value.verification.decision !== "PASS" &&
        value.verification.decision !== "WARN" && value.verification.decision !== "BLOCK")) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const event: unknown = snapshot(value);
  const typed = event as Record<string, unknown>;
  return {
    version: BEHAVIOR_EVENT_VERSION,
    id: typed.id as string,
    userId: typed.userId as string,
    type: typed.type as BehaviorEventType,
    at: typed.at as string,
    subjectKind: typed.subjectKind as "trade" | "intent",
    subjectId: typed.subjectId as string | null,
    availability: typed.availability as BehaviorEvent["availability"],
    acceptance: typed.acceptance as BehaviorEventAcceptance,
    outcome: (typed.outcome === null ? null : Object.freeze({ ...(typed.outcome as Record<string, unknown>) })) as BehaviorEvent["outcome"],
    verification: Object.freeze({
      idempotent: (typed.verification as Record<string, unknown>).idempotent as boolean,
      decision: (typed.verification as Record<string, unknown>).decision as "PASS" | "WARN" | "BLOCK" | null,
    }),
  };
}

/** Build a fresh, validated behavioral event for real store activity. */
export function buildBehaviorEvent(input: Omit<BehaviorEvent, "id" | "version">): BehaviorEvent {
  return validateBehaviorEvent({ version: BEHAVIOR_EVENT_VERSION, ...input, id: randomUUID() });
}

/** Validate a full untrusted list of behavioral events; fail closed on malformed. */
export function validateBehaviorEventList(untrusted: unknown): BehaviorEvent[] {
  const value = snapshot(untrusted);
  if (!Array.isArray(value)) throw new PaperTradeError("INVALID_REQUEST");
  return value.map((event) => validateBehaviorEvent(event));
}

const MONITOR_FIELDS = new Set([
  "tradeId", "intentId", "asset", "direction", "entryFill", "size", "stop", "target", "openedAt", "closedAt",
]);

function parseMonitorable(row: unknown): MonitorableOpenTrade {
  const value = snapshot(row);
  if (!record(value) || Object.keys(value).length !== MONITOR_FIELDS.size ||
      Object.keys(value).some((key) => !MONITOR_FIELDS.has(key)) ||
      !uuid(value.tradeId) || !uuid(value.intentId) ||
      typeof value.asset !== "string" || value.asset.length === 0 ||
      (value.direction !== "long" && value.direction !== "short") ||
      !positive(value.entryFill) || !positive(value.size) || !instant(value.openedAt) ||
      (value.stop !== null && !positive(value.stop)) ||
      (value.target !== null && !positive(value.target)) ||
      (value.closedAt !== null && !instant(value.closedAt))) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  return {
    tradeId: value.tradeId as string, intentId: value.intentId as string, asset: value.asset as string,
    direction: value.direction as "long" | "short", entryFill: value.entryFill as number,
    size: value.size as number, stop: value.stop as number | null, target: value.target as number | null,
    openedAt: value.openedAt as string,
  };
}

export interface MonitorClosedCredit {
  tradeId: string;
  exitReason: ExitReason;
  exitFill: number;
  pnl: number;
  rMultiple: number;
}

export interface MonitorResult {
  priceFeed: "available" | "unavailable";
  open: MonitorableOpenTrade[];
  closed: MonitorClosedCredit[];
}

export interface MonitorDependencies {
  store: PaperOpsStore;
  priceFeed: PriceFeed;
  now(): string;
}

function stopOrTargetSignal(
  trade: MonitorableOpenTrade,
  price: number,
): { exitFill: number; exitReason: "stop" | "target" } | null {
  const stopHit = trade.stop !== null &&
    (trade.direction === "long" ? price <= trade.stop : price >= trade.stop);
  if (stopHit) return { exitFill: trade.stop as number, exitReason: "stop" };
  const targetHit = trade.target !== null &&
    (trade.direction === "long" ? price >= trade.target : price <= trade.target);
  if (targetHit) return { exitFill: trade.target as number, exitReason: "target" };
  return null;
}

/**
 * Evaluate the tenant's open paper trades against the injected simulated price
 * feed and auto-close any whose stop or target is hit — reusing the SAME
 * closePaperTrade/computeClosure/store.closeAtomic closure path and never
 * fabricating a fill (the fill is the resolved stop/target level). When the
 * price feed is entirely unavailable this fails closed to a manual-close-only
 * result and performs zero closure writes. Behavioral events are derived only
 * from the real store's open trades and the real closure outcomes.
 */
export async function evaluateDejaPositions(
  context: TrustedTenantContext,
  deps: MonitorDependencies,
): Promise<MonitorResult> {
  const tenant = trustedTenant(context);
  const { store, priceFeed, now } = deps;
  let rowsUntrusted: unknown;
  try {
    rowsUntrusted = await store.listMonitorableOpenTrades(tenant.userId);
  } catch {
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
  const rows = snapshot(rowsUntrusted ?? []);
  if (!Array.isArray(rows)) throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  const open = rows.map((row) => parseMonitorable(row));

  const assetToPrice = new Map<string, PriceResolution>();
  let atLeastRecentAvailable = false;
  for (const asset of new Set(open.map((trade) => trade.asset))) {
    let resolution: PriceResolution;
    try {
      const captured = snapshot(await priceFeed.resolve(asset));
      if (record(captured) &&
          (captured.available === false || (captured.available === true && positive(captured.price)))) {
        if (captured.available === true) {
          resolution = {
            available: true,
            price: captured.price as number,
            at: typeof captured.at === "string" ? captured.at : now(),
          };
          atLeastRecentAvailable = true;
        } else {
          resolution = { available: false };
        }
      } else {
        resolution = { available: false };
      }
    } catch {
      resolution = { available: false };
    }
    assetToPrice.set(asset, resolution);
  }
  const anyAvailable = open.length > 0 && atLeastRecentAvailable;

  const remaining: MonitorableOpenTrade[] = [];
  const closed: MonitorClosedCredit[] = [];

  for (const trade of open) {
    const resolution = assetToPrice.get(trade.asset);
    if (!resolution || resolution.available !== true) {
      remaining.push(trade);
      await store.recordBehaviorEvent(buildBehaviorEvent({
        userId: tenant.userId, type: "monitoring", subjectKind: "trade", subjectId: trade.tradeId,
        at: now(), availability: "price_feed_unavailable", acceptance: "manual_close_only",
        outcome: { tradeId: trade.tradeId, asset: trade.asset },
        verification: { idempotent: false, decision: null },
      }));
      continue;
    }
    const price = resolution.price;
    const trigger = stopOrTargetSignal(trade, price);
    if (trigger === null) {
      remaining.push(trade);
      await store.recordBehaviorEvent(buildBehaviorEvent({
        userId: tenant.userId, type: "monitoring", subjectKind: "trade", subjectId: trade.tradeId,
        at: now(), availability: "price_feed_available", acceptance: "check",
        outcome: { tradeId: trade.tradeId, price },
        verification: { idempotent: false, decision: null },
      }));
      continue;
    }
    const outcome = await closePaperTrade({
      tradeId: trade.tradeId, exitFill: trigger.exitFill, exitReason: trigger.exitReason, closedAt: now(),
    }, { userId: tenant.userId }, deps.store);
    closed.push({
      tradeId: trade.tradeId, exitReason: outcome.exitReason, exitFill: outcome.exitFill,
      pnl: outcome.pnl, rMultiple: outcome.rMultiple,
    });
    await store.recordBehaviorEvent(buildBehaviorEvent({
      userId: tenant.userId, type: "monitoring", subjectKind: "trade", subjectId: trade.tradeId,
      at: now(), availability: "price_feed_available",
      acceptance: trigger.exitReason === "stop" ? "stop_hit" : "target_hit",
      outcome: {
        tradeId: trade.tradeId, price, exitFill: outcome.exitFill, exitReason: outcome.exitReason,
        pnl: outcome.pnl, rMultiple: outcome.rMultiple,
      },
      verification: { idempotent: false, decision: null },
    }));
  }
  return { priceFeed: anyAvailable ? "available" : "unavailable", open: remaining, closed };
}

export interface SettleDependencies {
  store: PaperOpsStore;
  settledAt(): string;
}

export interface SettleResultRow {
  tradeId: string;
  outcome: "settled" | "already_settled";
  pnl: number;
  rMultiple: number;
}

export interface SettleResult {
  state: "settled";
  results: SettleResultRow[];
}

const SETTLE_FIELDS = new Set(["tradeIds"]);

/**
 * Settle closed ("done") paper positions for the tenant: an append-only record
 * (never money movement). Repeated settlement of the same trade is idempotent
 * — the second attempt reports already_settled with the same stored P&L/R and
 * writes nothing new. Cross-tenant and not-yet-closed trades are rejected.
 */
export async function settleDoneTrades(
  rawRequest: unknown,
  context: TrustedTenantContext,
  deps: SettleDependencies,
): Promise<SettleResult> {
  const tenant = trustedTenant(context);
  const request = snapshot(rawRequest);
  if (!record(request) || Object.keys(request).length !== SETTLE_FIELDS.size ||
      Object.keys(request).some((key) => !SETTLE_FIELDS.has(key)) ||
      !Array.isArray(request.tradeIds) || request.tradeIds.length === 0 ||
      request.tradeIds.some((id) => !uuid(id))) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  const unique = [...new Set(request.tradeIds as string[])];
  const results: SettleResultRow[] = [];
  for (const tradeId of unique) {
    let attempt: SettleAttempt;
    try {
      attempt = await deps.store.settleAtomic(tenant.userId, tradeId, deps.settledAt());
    } catch (error) {
      if (error instanceof PaperTradeError) throw error;
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    }
    const captured = snapshot(attempt);
    if (!record(captured) || (captured.state !== "settled" && captured.state !== "already_settled") ||
        !finite(captured.pnl) || !finite(captured.rMultiple)) {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    }
    results.push({
      tradeId,
      outcome: captured.state as "settled" | "already_settled",
      pnl: captured.pnl as number,
      rMultiple: captured.rMultiple as number,
    });
  }
  return { state: "settled", results };
}

const SETTLEABLE_FIELDS = new Set(["tradeId", "asset", "direction", "pnl", "rMultiple", "exitReason", "closedAt"]);
const EXIT_REASONS = new Set(["stop", "target", "manual", "timeout"]);

function parseSettleable(row: unknown): SettleableTrade {
  const value = snapshot(row);
  if (!record(value) || Object.keys(value).length !== SETTLEABLE_FIELDS.size ||
      Object.keys(value).some((key) => !SETTLEABLE_FIELDS.has(key)) ||
      !uuid(value.tradeId) || typeof value.asset !== "string" || value.asset.length === 0 ||
      (value.direction !== "long" && value.direction !== "short") ||
      !finite(value.pnl) || !finite(value.rMultiple) ||
      !EXIT_REASONS.has(value.exitReason as string) || !instant(value.closedAt)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
  return {
    tradeId: value.tradeId as string, asset: value.asset as string,
    direction: value.direction as string, pnl: value.pnl as number,
    rMultiple: value.rMultiple as number, exitReason: value.exitReason as ExitReason,
    closedAt: value.closedAt as string,
  };
}

export async function listSettleablePositions(
  context: TrustedTenantContext,
  store: PaperOpsStore,
): Promise<SettleableTrade[]> {
  const tenant = trustedTenant(context);
  let rows: unknown;
  try {
    rows = await store.listSettleableTrades(tenant.userId);
  } catch {
    throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }
  const value = snapshot(rows ?? []);
  if (!Array.isArray(value)) throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  return value.map((row) => parseSettleable(row));
}