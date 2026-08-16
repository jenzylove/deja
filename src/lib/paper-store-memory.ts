import { randomUUID } from "node:crypto";

import {
  PaperTradeError,
  type ClosedTradeOutcome,
  type CloseTradeInput,
  type OpenExecutionInput,
  type OpenExecutionResult,
  type OpenTradeRecord,
  type PatternCandidate,
  type PaperMemoryStore,
  type PaperClosureStore,
  type PaperExecutionStore,
  type WarningAuditRow,
  type WarningCode,
} from "./paper-trade";
import {
  compileRule,
  evaluateRules,
  type RuleField,
} from "./rules";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUserId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** Rule-field identifiers carried by the deterministic rule engine. */
export interface SeededRule {
  id: string;
  predicate: { field: RuleField; op: string; value: number | boolean };
  enforcement: "warn" | "block";
}

/** Deterministic mapping from failed warn rule field to the closed warning taxonomy. */
const FIELD_TO_WARNING: Record<RuleField, WarningCode> = {
  risk_pct: "OVERSIZED_RISK",
  minutes_since_last_loss: "POST_LOSS_REENTRY",
  trades_today: "DAILY_CAP_EXCEEDED",
  has_stop_loss: "NO_STOP_LOSS",
  size_increase_after_loss: "SIZE_ESCALATION",
};

export interface StoredIntent {
  userId: string;
  intentId: string;
  asset: string;
  assetClass: string;
  direction: "long" | "short";
  size: number;
  entry: number;
  stopLoss: number | null;
  takeProfit: number | null;
  riskPct: number;
  thesisRaw: string;
  strategy: string | null;
  regime: string;
  session: string;
  status: "pending" | "executed";
}

interface StoredDecision {
  id: string;
  intentId: string;
  userId: string;
  action: string;
  warningsShown: WarningCode[];
  warningsDefied: WarningCode[];
}

interface StoredTrade {
  id: string;
  intentId: string;
  userId: string;
  asset: string;
  assetClass: string;
  direction: "long" | "short";
  size: number;
  entry: number;
  stop: number | null;
  openedAt: string;
  closedAt: string | null;
  exitFill: number | null;
  exitReason: string | null;
  pnl: number | null;
  rMultiple: number | null;
  durationS: number | null;
  thesisRaw: string;
  strategy: string | null;
  regime: string;
}

function validateIntentId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new PaperTradeError("INVALID_REQUEST");
  }
}

/**
 * In-memory adapter behind the existing paper store interface. Used for local
 * development and tests when no live CockroachDB connection is configured.
 *
 * It fails closed: if constructed with `requireLive` set and no live connection
 * was provided, every persistence operation throws PERSISTENCE_UNAVAILABLE
 * rather than silently pretending to persist.
 */
export class MemoryPaperStore
  implements PaperExecutionStore, PaperClosureStore, PaperMemoryStore
{
  private readonly intents = new Map<string, StoredIntent>();
  private readonly decisions = new Map<string, StoredDecision>();
  private readonly trades = new Map<string, StoredTrade>();
  private readonly tradeByIntent = new Map<string, string>();
  private readonly rules = new Map<string, SeededRule[]>();
  private readonly patterns: { userId: string; candidate: PatternCandidate }[] = [];
  private readonly warningAudit = new Map<string, WarningAuditRow[]>();
  private readonly integrityToken: string;

  constructor(
    private readonly options: { requireLive?: boolean; liveConnection?: unknown } = {},
  ) {
    this.integrityToken = randomUUID();
    if (options.requireLive && !options.liveConnection) {
      this.persistUnavailable = true;
    }
  }

  private persistUnavailable = false;

  private guard(): void {
    if (this.persistUnavailable) throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    if (this.integrityToken === "") throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
  }

  private key(userId: string, id: string): string {
    return `${userId}:${id}`;
  }

  upsertRules(userId: string, rules: SeededRule[]): void {
    if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
    this.rules.set(userId, [...rules]);
  }

  /**
   * Deterministically derives the trusted BLOCK/WARN/PASS decision and the
   * shown warning taxonomy from the tenant's compiled rules. This is the same
   * enforcement boundary exercised by the intent service, without any model,
   * network, database, or clock dependency.
   */
  async resolveDecisionFromRules(
    rawIntent: unknown,
    userId: string,
  ): Promise<{ decision: "BLOCK" | "WARN" | "PASS"; warningsShown: WarningCode[] }> {
    if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
    const intent = this.validateMinimalIntent(rawIntent);
    const stored = this.rules.get(userId) ?? [];
    const compiled = stored.map((rule) => compileRule(rule));
    const state = {
      risk_pct: typeof intent.riskPct === "number" ? intent.riskPct : 0,
      minutes_since_last_loss: Number.MAX_SAFE_INTEGER,
      trades_today: 0,
      has_stop_loss: intent.stopLoss != null && Number.isFinite(intent.stopLoss),
      size_increase_after_loss: intent.sizeIncreaseAfterLoss === true,
    };
    const { decision, evidence } = evaluateRules(compiled, state);
    const warningsShown = evidence
      .filter((row) => !row.passed && row.enforcement === "warn" && row.field !== undefined)
      .map((row) => FIELD_TO_WARNING[row.field as RuleField]);
    return { decision, warningsShown: [...new Set(warningsShown)] };
  }

  private validateMinimalIntent(raw: unknown): {
    riskPct: number;
    stopLoss: number | null;
    sizeIncreaseAfterLoss: boolean;
  } {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new PaperTradeError("INVALID_REQUEST");
    }
    const intent = raw as Record<string, unknown>;
    if (typeof intent.riskPct !== "number" || !Number.isFinite(intent.riskPct)) {
      throw new PaperTradeError("INVALID_REQUEST");
    }
    if (intent.stopLoss !== null && typeof intent.stopLoss !== "number" && !Number.isFinite(intent.stopLoss)) {
      throw new PaperTradeError("INVALID_REQUEST");
    }
    if (typeof intent.sizeIncreaseAfterLoss !== "boolean") {
      throw new PaperTradeError("INVALID_REQUEST");
    }
    return {
      riskPct: intent.riskPct,
      stopLoss: typeof intent.stopLoss === "number" && Number.isFinite(intent.stopLoss) ? intent.stopLoss : null,
      sizeIncreaseAfterLoss: intent.sizeIncreaseAfterLoss,
    };
  }

  /** Provisions the tenant-scoped pending intent before execution. */
  registerPendingIntent(input: {
    userId: string;
    intentId: string;
    asset: string;
    assetClass: string;
    direction: "long" | "short";
    size: number;
    entry: number;
    stopLoss: number | null;
    takeProfit: number | null;
    riskPct: number;
    thesisRaw: string;
    strategy: string | null;
    regime: string;
    session: string;
  }): void {
    this.guard();
    if (!validUserId(input.userId)) throw new PaperTradeError("INVALID_REQUEST");
    validateIntentId(input.intentId);
    const key = this.key(input.userId, input.intentId);
    if (this.intents.has(key)) return;
    this.intents.set(key, { ...input, status: "pending" });
  }

  async openAtomic(input: OpenExecutionInput): Promise<OpenExecutionResult> {
    this.guard();
    if (!validUserId(input.userId)) throw new PaperTradeError("INVALID_REQUEST");
    validateIntentId(input.intentId);
    const key = this.key(input.userId, input.intentId);
    const intent = this.intents.get(key);
    if (intent) {
      const existing = this.tradeByIntent.get(key);
      if (existing) {
        const trade = this.trades.get(existing);
        const decision = [...this.decisions.values()].find(
          (row) => row.intentId === input.intentId && row.userId === input.userId,
        );
        if (trade && decision) {
          return { decisionId: decision.id, tradeId: trade.id, replayed: true };
        }
      }
      intent.status = "executed";
    }
    if (!intent) throw new PaperTradeError("TRADE_NOT_FOUND");

    const decisionId = randomUUID();
    this.decisions.set(key, {
      id: decisionId,
      intentId: input.intentId,
      userId: input.userId,
      action: input.action,
      warningsShown: [...input.warningsShown],
      warningsDefied: [...input.warningsDefied],
    });

    const tradeId = randomUUID();
    this.trades.set(tradeId, {
      id: tradeId,
      intentId: input.intentId,
      userId: input.userId,
      asset: intent.asset,
      assetClass: intent.assetClass,
      direction: intent.direction,
      size: intent.size,
      entry: intent.entry,
      stop: intent.stopLoss,
      openedAt: new Date().toISOString(),
      closedAt: null,
      exitFill: null,
      exitReason: null,
      pnl: null,
      rMultiple: null,
      durationS: null,
      thesisRaw: intent.thesisRaw,
      strategy: intent.strategy,
      regime: intent.regime,
    });
    this.tradeByIntent.set(key, tradeId);

    return { decisionId, tradeId, replayed: false };
  }

  private toOpenTradeRecord(trade: StoredTrade): OpenTradeRecord {
    return {
      tradeId: trade.id,
      intentId: trade.intentId,
      userId: trade.userId,
      direction: trade.direction,
      entryFill: trade.entry,
      size: trade.size,
      initialStop: trade.stop,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt,
    };
  }

  async closeAtomic(input: CloseTradeInput): Promise<ClosedTradeOutcome> {
    this.guard();
    if (!validUserId(input.userId)) throw new PaperTradeError("INVALID_REQUEST");
    validateIntentId(input.tradeId);
    const trade = this.trades.get(input.tradeId);
    if (!trade || trade.userId !== input.userId) throw new PaperTradeError("TRADE_NOT_FOUND");
    if (trade.closedAt !== null) throw new PaperTradeError("TRADE_ALREADY_CLOSED");
    const outcome = input.compute(this.toOpenTradeRecord(trade));
    trade.closedAt = input.closedAt;
    trade.exitFill = input.exitFill;
    trade.exitReason = input.exitReason;
    trade.pnl = outcome.pnl;
    trade.rMultiple = outcome.rMultiple;
    trade.durationS = outcome.durationS;
    return outcome;
  }

  async loadClosedOutcomes(userId: string): Promise<unknown[]> {
    this.guard();
    if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
    const rows: {
      tradeId: string; intentId: string; thesisRaw: string; rMultiple: number;
      asset: string; assetClass: string; direction: string; strategy: string | null; regime: string;
    }[] = [];
    for (const trade of this.trades.values()) {
      if (trade.userId !== userId || trade.closedAt === null || trade.rMultiple === null) continue;
      rows.push({
        tradeId: trade.id,
        intentId: trade.intentId,
        thesisRaw: trade.thesisRaw,
        rMultiple: trade.rMultiple,
        asset: trade.asset,
        assetClass: trade.assetClass,
        direction: trade.direction,
        strategy: trade.strategy,
        regime: trade.regime,
      });
    }
    return rows;
  }

  async loadWarningObservations(userId: string): Promise<unknown[]> {
    this.guard();
    if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
    const rows: { tradeId: string; code: WarningCode; shown: boolean; defied: boolean; rMultiple: number }[] = [];
    for (const decision of this.decisions.values()) {
      if (decision.userId !== userId) continue;
      const tradeId = this.tradeByIntent.get(this.key(userId, decision.intentId));
      if (!tradeId) continue;
      const trade = this.trades.get(tradeId);
      if (!trade || trade.closedAt === null || trade.rMultiple === null) continue;
      for (const code of decision.warningsShown) {
        rows.push({
          tradeId: trade.id,
          code,
          shown: true,
          defied: decision.warningsDefied.includes(code),
          rMultiple: trade.rMultiple,
        });
      }
    }
    return rows;
  }

  async persistMemoryAtomic(
    userId: string,
    candidate: PatternCandidate | null,
    audit: readonly WarningAuditRow[],
  ): Promise<void> {
    this.guard();
    if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
    if (candidate) this.patterns.push({ userId, candidate });
    this.warningAudit.set(userId, [...audit]);
  }

  async openTrades(userId: string): Promise<{
    id: string; asset: string; assetClass: string; direction: string;
    size: number; entry: number; stop: number | null; openedAt: string;
  }[]> {
    this.guard();
    if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
    return [...this.trades.values()]
      .filter((trade) => trade.userId === userId && trade.closedAt === null)
      .map((trade) => ({
        id: trade.id,
        asset: trade.asset,
        assetClass: trade.assetClass,
        direction: trade.direction,
        size: trade.size,
        entry: trade.entry,
        stop: trade.stop,
        openedAt: trade.openedAt,
      }));
  }

  async openTradeCount(userId: string): Promise<number> {
    return (await this.openTrades(userId)).length;
  }

  async popOpenTradesForTest(userId: string, asset: string): Promise<number> {
    const open = await this.openTrades(userId);
    let removed = 0;
    for (const trade of open) {
      if (trade.asset === asset) {
        this.trades.delete(trade.id);
        removed++;
      }
    }
    return removed;
  }
}