import { db } from "./db";
import {
  PaperTradeError,
  type CloseTradeInput,
  type ClosedTradeOutcome,
  type OpenExecutionInput,
  type OpenExecutionResult,
  type OpenTradeRecord,
  type PaperClosureStore,
  type PaperExecutionStore,
  type PaperMemoryStore,
  type PatternCandidate,
  type WarningAuditRow,
  type WarningCode,
  captureDescriptorSafeSqlResult,
  createPatternCandidate,
  validatePatternCandidate,
  validateWarningAuditRows,
} from "./paper-trade";
import {
  type BehaviorEvent,
  type MonitorableOpenTrade,
  type PaperOpsStore,
  type SettleAttempt,
  type SettleableTrade,
  validateBehaviorEvent,
} from "./paper-ops";
import { type InsightsStore } from "./insights";
import { compileRule, evaluateRules, type RuleField } from "./rules";

export interface SqlResult<T = Record<string, unknown>> { rows: T[]; rowCount: number | null }
export interface SqlClient {
  query<T = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<SqlResult<T>>;
  release(): void;
}
export interface SqlPool { connect(): Promise<SqlClient> }

interface IntentRow { asset: string; direction: "long" | "short"; size: string; entry: string; initial_stop: string | null; initial_target: string | null; account_id: string | null }
interface IdRow { id: string }
interface ReplayRow { decision_id: string; trade_id: string }
interface TradeRow { trade_id: string; intent_id: string; user_id: string; direction: "long" | "short"; entry_fill: string; size: string; initial_stop: string | null; opened_at: string; closed_at: string | null }

interface ClosedOutcomeRow {
  trade_id: string;
  intent_id: string;
  thesis_raw: string;
  r_multiple: string;
  asset: string;
  asset_class: string;
  direction: string;
  strategy: string | null;
  regime: string;
}
interface PatternSourceRow extends ClosedOutcomeRow { id: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function validUserId(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function validString(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function validDecimal(value: unknown): value is string {
  return typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value));
}
function capturedResult(
  result: unknown,
  fields: readonly string[],
  lengths?: readonly number[],
) {
  try { return captureDescriptorSafeSqlResult(result, fields, lengths); }
  catch { throw new PaperTradeError("PERSISTENCE_UNAVAILABLE"); }
}
function capturedRows<T extends object>(
  result: unknown,
  fields: readonly string[],
  lengths?: readonly number[],
): readonly Readonly<T>[] {
  return capturedResult(result, fields, lengths).rows as unknown as readonly Readonly<T>[];
}
function malformedSql(): never { throw new PaperTradeError("PERSISTENCE_UNAVAILABLE"); }

/** pg returns Cockroach TIMESTAMPTZ as a JS Date; normalize to an ISO-8601 UTC string. */
function toIsoUtc(value: unknown): string {
  const d = value instanceof Date ? value : new Date(value as string);
  if (!Number.isFinite(d.getTime())) malformedSql();
  return d.toISOString();
}
/** DECIMAL columns come back as strings; convert and fail closed if not a finite number. */
function toFiniteNumber(value: unknown): number {
  const n = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(n)) malformedSql();
  return n;
}

const INTENT_FIELDS = ["asset", "direction", "size", "entry", "initial_stop", "initial_target", "account_id"] as const;
const REPLAY_FIELDS = ["decision_id", "trade_id"] as const;
const ID_FIELDS = ["id"] as const;
const TRADE_FIELDS = ["trade_id", "intent_id", "user_id", "direction", "entry_fill", "size", "initial_stop", "opened_at", "closed_at"] as const;
const CLOSED_FIELDS = ["trade_id", "intent_id", "thesis_raw", "r_multiple", "asset", "asset_class", "direction", "strategy", "regime"] as const;
const PATTERN_SOURCE_FIELDS = ["id", "intent_id", "thesis_raw", "r_multiple", "asset", "asset_class", "direction", "strategy", "regime"] as const;
const WARNING_FIELDS = ["tradeId", "code", "shown", "defied", "rMultiple"] as const;
const PERSISTED_FIELDS = ["trade_id"] as const;
const MONITORABLE_FIELDS = ["trade_id", "intent_id", "asset", "direction", "size", "entry_fill", "stop", "target", "opened_at", "closed_at"] as const;
const SETTLEABLE_FIELDS = ["trade_id", "asset", "direction", "pnl", "r_multiple", "exit_reason", "closed_at"] as const;
const BEHAVIOR_FIELDS = ["id", "version", "type", "at", "subject_kind", "subject_id", "availability", "acceptance", "outcome", "verification"] as const;
const SETTLE_TRADE_FIELDS = ["pnl", "r_multiple", "exit_reason", "closed_at"] as const;
const SETTLE_EXISTING_FIELDS = ["pnl", "r_multiple"] as const;
const OPEN_TRADE_FIELDS = ["t_id", "asset", "asset_class", "direction", "size", "entry_fill", "stop", "opened_at"] as const;

/** Maps a violating rule field to the warning the UI shows. Mirrors paper-store-memory. */
const FIELD_TO_WARNING: Record<RuleField, WarningCode> = {
  risk_pct: "OVERSIZED_RISK",
  minutes_since_last_loss: "POST_LOSS_REENTRY",
  trades_today: "DAILY_CAP_EXCEEDED",
  has_stop_loss: "NO_STOP_LOSS",
  size_increase_after_loss: "SIZE_ESCALATION",
};

export class CockroachPaperStore
  implements PaperExecutionStore, PaperClosureStore, PaperMemoryStore, PaperOpsStore, InsightsStore
{
  constructor(private readonly pool: SqlPool = db()) {}

  async openAtomic(input: OpenExecutionInput): Promise<OpenExecutionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimedResult = await client.query<IntentRow>(
        `UPDATE trade_intents
            SET status = 'executed'
          WHERE user_id = $1 AND id = $2 AND status = 'pending'
        RETURNING asset, direction::STRING AS direction, size, entry, stop_loss AS initial_stop,
                  take_profit AS initial_target, account_id`,
        [input.userId, input.intentId],
      );
      const claimed = capturedRows<IntentRow>(claimedResult, INTENT_FIELDS, [0, 1]);
      if (claimed.length === 0) {
        const replayResult = await client.query<ReplayRow>(
          `SELECT d.id AS decision_id, t.id AS trade_id
             FROM decisions d
             JOIN trades t ON t.intent_id = d.intent_id AND t.user_id = $1
            WHERE d.user_id = $1 AND d.intent_id = $2
            LIMIT 1`,
          [input.userId, input.intentId],
        );
        const replay = capturedRows<ReplayRow>(replayResult, REPLAY_FIELDS, [0, 1]);
        if (replay.length === 0) throw new PaperTradeError("TRADE_NOT_FOUND");
        if (!UUID.test(replay[0].decision_id) || !UUID.test(replay[0].trade_id)) malformedSql();
        await client.query("COMMIT");
        return { decisionId: replay[0].decision_id, tradeId: replay[0].trade_id, replayed: true };
      }
      const intent = claimed[0];
      if (!validString(intent.asset) || (intent.direction !== "long" && intent.direction !== "short") ||
          !validDecimal(intent.size) || Number(intent.size) <= 0 || !validDecimal(intent.entry) || Number(intent.entry) <= 0 ||
          (intent.initial_stop !== null && !validDecimal(intent.initial_stop)) ||
          (intent.initial_target !== null && !validDecimal(intent.initial_target)) ||
          (intent.account_id !== null && !validUserId(intent.account_id))) malformedSql();
      const decisionResult = await client.query<IdRow>(
        `INSERT INTO decisions (user_id, intent_id, action, warnings_shown, warnings_defied)
         VALUES ($1, $2, $3, $4::warning_code[], $5::warning_code[])
         RETURNING id`,
        [input.userId, input.intentId, input.action, input.warningsShown, input.warningsDefied],
      );
      const decision = capturedRows<IdRow>(decisionResult, ID_FIELDS, [1]);
      if (!UUID.test(decision[0].id)) malformedSql();
      const tradeResult = await client.query<IdRow>(
        `INSERT INTO trades
           (user_id, intent_id, account_id, asset, direction, size, opened_at,
            entry_fill, initial_stop, final_stop, initial_target, source)
         VALUES ($1, $2, $3, $4, $5::direction, $6, now(), $7, $8, $8, $9, 'deja')
         RETURNING id`,
        [input.userId, input.intentId, intent.account_id, intent.asset, intent.direction,
          intent.size, intent.entry, intent.initial_stop, intent.initial_target],
      );
      const trade = capturedRows<IdRow>(tradeResult, ID_FIELDS, [1]);
      if (!UUID.test(trade[0].id)) malformedSql();
      for (const code of input.warningsDefied) {
        await client.query(
          `INSERT INTO trade_events (user_id, trade_id, event_type, payload)
           VALUES ($1, $2, 'warning_defied', jsonb_build_object('code', $3::STRING))`,
          [input.userId, trade[0].id, code],
        );
      }
      await client.query("COMMIT");
      return { decisionId: decision[0].id, tradeId: trade[0].id, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async closeAtomic(input: CloseTradeInput): Promise<ClosedTradeOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selectedResult = await client.query<TradeRow>(
        `SELECT t.id AS trade_id, t.intent_id, t.user_id, t.direction::STRING AS direction,
                t.entry_fill, t.size, t.initial_stop, t.opened_at, t.closed_at
           FROM trades t
           JOIN trade_intents i ON i.id = t.intent_id AND i.user_id = $1
          WHERE t.user_id = $1 AND t.id = $2
          FOR UPDATE`,
        [input.userId, input.tradeId],
      );
      const selected = capturedRows<TradeRow>(selectedResult, TRADE_FIELDS, [0, 1]);
      if (selected.length === 0) throw new PaperTradeError("TRADE_NOT_FOUND");
      const raw = selected[0];
      if (!UUID.test(raw.trade_id) || raw.trade_id !== input.tradeId ||
          !UUID.test(raw.intent_id) || !UUID.test(raw.user_id) || raw.user_id !== input.userId ||
          (raw.direction !== "long" && raw.direction !== "short") ||
          !validDecimal(raw.entry_fill) || !validDecimal(raw.size) ||
          (raw.initial_stop !== null && !validDecimal(raw.initial_stop)) ||
          !validString(raw.opened_at) || (raw.closed_at !== null && !validString(raw.closed_at))) malformedSql();
      if (raw.closed_at !== null) throw new PaperTradeError("TRADE_ALREADY_CLOSED");
      const opened = new Date(raw.opened_at);
      if (!Number.isFinite(opened.getTime()) || opened.toISOString() !== raw.opened_at) malformedSql();
      const row: OpenTradeRecord = {
        tradeId: raw.trade_id, intentId: raw.intent_id, userId: raw.user_id,
        direction: raw.direction, entryFill: Number(raw.entry_fill), size: Number(raw.size),
        initialStop: raw.initial_stop === null ? null : Number(raw.initial_stop),
        openedAt: raw.opened_at, closedAt: raw.closed_at,
      };
      const result = input.compute(row);
      const durationS = Math.round(result.durationS);
      const updatedResult = await client.query(
        `UPDATE trades
            SET closed_at = $3, exit_fill = $4, pnl = $5, r_multiple = $6,
                duration_s = $7, exit_reason = $8::exit_reason
          WHERE user_id = $1 AND id = $2 AND closed_at IS NULL`,
        [input.userId, input.tradeId, input.closedAt, input.exitFill, result.pnl,
          result.rMultiple, durationS, input.exitReason],
      );
      const updated = capturedResult(updatedResult, [], [0]);
      if (updated.rowCount !== 1) throw new PaperTradeError("TRADE_ALREADY_CLOSED");
      await client.query("COMMIT");
      return { ...result, durationS };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async loadClosedOutcomes(userId: string): Promise<unknown> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<ClosedOutcomeRow>(
        `SELECT t.id AS trade_id, i.id AS intent_id, i.thesis_raw, t.r_multiple,
                i.asset, i.asset_class, i.direction::STRING AS direction,
                i.strategy::STRING AS strategy, i.regime::STRING AS regime
           FROM trades t
           JOIN trade_intents i ON i.id = t.intent_id AND i.user_id = $1
          WHERE t.user_id = $1 AND t.closed_at IS NOT NULL AND t.r_multiple IS NOT NULL
          ORDER BY t.closed_at DESC, t.id ASC`, [userId]);
      const rows = capturedRows<ClosedOutcomeRow>(result, CLOSED_FIELDS);
      if (rows.some((row) => !UUID.test(row.trade_id) || !UUID.test(row.intent_id) ||
          !validString(row.thesis_raw) || !validDecimal(row.r_multiple) ||
          !validString(row.asset) || !validString(row.asset_class) || !validString(row.direction) ||
          (row.strategy !== null && !validString(row.strategy)) || !validString(row.regime))) malformedSql();
      return rows.map((row) => Object.freeze({
        tradeId: row.trade_id, intentId: row.intent_id, thesisRaw: row.thesis_raw,
        rMultiple: Number(row.r_multiple), asset: row.asset, assetClass: row.asset_class,
        direction: row.direction, strategy: row.strategy, regime: row.regime,
      }));
    } catch {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    } finally { client.release(); }
  }

  async loadWarningObservations(userId: string): Promise<unknown[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT DISTINCT t.id AS "tradeId", shown.code::STRING AS code, true AS shown,
                (shown.code = ANY(d.warnings_defied)) AS defied,
                t.r_multiple::FLOAT8 AS "rMultiple"
           FROM decisions d
           JOIN trades t ON t.intent_id = d.intent_id AND t.user_id = $1
           JOIN trade_intents i ON i.id = t.intent_id AND i.user_id = $1
           CROSS JOIN LATERAL unnest(d.warnings_shown) AS shown(code)
          WHERE d.user_id = $1 AND t.closed_at IS NOT NULL AND t.r_multiple IS NOT NULL
          ORDER BY code, "tradeId"`, [userId]);
      const rows = capturedRows<Record<string, unknown>>(result, WARNING_FIELDS);
      if (rows.some((row) => !validUserId(row.tradeId) || !validString(row.code) ||
          row.shown !== true || typeof row.defied !== "boolean" ||
          typeof row.rMultiple !== "number" || !Number.isFinite(row.rMultiple))) malformedSql();
      return rows.map((row) => row);
    } catch {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    } finally { client.release(); }
  }

  async appendPattern(userId: string, candidate: PatternCandidate): Promise<string> {
    if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
    const validated = validatePatternCandidate(candidate);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const patternId = await this.insertPatternWithLineage(client, userId, validated);
      await client.query("COMMIT");
      return patternId;
    } catch {
      await client.query("ROLLBACK");
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    } finally { client.release(); }
  }

  async upsertWarningAudit(userId: string, rows: readonly WarningAuditRow[]): Promise<void> {
    if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
    const validated = validateWarningAuditRows(rows);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.writeWarningAudit(client, userId, validated);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK");
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    } finally { client.release(); }
  }

  async persistMemoryAtomic(
    userId: string,
    candidate: PatternCandidate | null,
    rows: readonly WarningAuditRow[],
  ): Promise<void> {
    if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
    const validatedCandidate = candidate === null ? null : validatePatternCandidate(candidate);
    const validatedAudit = validateWarningAuditRows(rows);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (validatedCandidate !== null) {
        await this.insertPatternWithLineage(client, userId, validatedCandidate);
      }
      await this.writeWarningAudit(client, userId, validatedAudit);
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK");
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    } finally { client.release(); }
  }

  private async insertPatternWithLineage(
    client: SqlClient,
    userId: string,
    candidate: PatternCandidate,
  ): Promise<string> {
    const sourceIds = candidate.sourceTradeIds;
    const eligibleResult = await client.query<PatternSourceRow>(
      `SELECT t.id, i.id AS intent_id, i.thesis_raw, t.r_multiple,
              i.asset, i.asset_class, i.direction::STRING AS direction,
              i.strategy::STRING AS strategy, i.regime::STRING AS regime
         FROM trades t
         JOIN trade_intents i ON i.id = t.intent_id AND i.user_id = $1
        WHERE t.user_id = $1 AND t.closed_at IS NOT NULL AND t.r_multiple IS NOT NULL
        ORDER BY t.id`,
      [userId],
    );
    const eligible = capturedRows<PatternSourceRow>(eligibleResult, PATTERN_SOURCE_FIELDS);
    if (eligible.some((row) => !UUID.test(row.id) || !UUID.test(row.intent_id) ||
        !validString(row.thesis_raw) || !validDecimal(row.r_multiple) ||
        !validString(row.asset) || !validString(row.asset_class) || !validString(row.direction) ||
        (row.strategy !== null && !validString(row.strategy)) || !validString(row.regime))) malformedSql();
    const eligibleIds = eligible.map((row) => row.id);
    if (new Set(eligibleIds).size !== eligibleIds.length) {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    }
    const authoritative = createPatternCandidate({
      outcomes: eligible.map((row) => ({
        tradeId: row.id, intentId: row.intent_id, thesisRaw: row.thesis_raw,
        rMultiple: Number(row.r_multiple), asset: row.asset, assetClass: row.asset_class,
        direction: row.direction, strategy: row.strategy, regime: row.regime,
      })),
      baselineRate: candidate.rate - candidate.effectSize,
      kind: candidate.kind,
      filter: candidate.filter,
    });
    if (authoritative === null ||
        authoritative.n !== candidate.n || authoritative.wins !== candidate.wins ||
        authoritative.losses !== candidate.losses || authoritative.rate !== candidate.rate ||
        authoritative.interval.low !== candidate.interval.low || authoritative.interval.high !== candidate.interval.high ||
        authoritative.effectSize !== candidate.effectSize || authoritative.tier !== candidate.tier ||
        authoritative.statement !== candidate.statement ||
        JSON.stringify(authoritative.filter) !== JSON.stringify(candidate.filter) ||
        authoritative.sourceTradeIds.length !== sourceIds.length ||
        authoritative.sourceTradeIds.some((id) => !sourceIds.includes(id)) ||
        sourceIds.some((id) => !authoritative.sourceTradeIds.includes(id))) {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    }
    const refreshKey = JSON.stringify([
      candidate.kind, candidate.n, candidate.wins, candidate.losses, candidate.rate,
      candidate.interval.low, candidate.interval.high, candidate.effectSize, candidate.tier,
      candidate.filter, [...sourceIds].sort(),
    ]);
    const insertedResult = await client.query<IdRow>(
      `INSERT INTO patterns
         (user_id, refresh_key, kind, statement, n, wins, losses, rate, ci_low, ci_high,
          effect_size, evidence_tier, filter)
       VALUES ($1, $2, $3::pattern_kind, $4, $5, $6, $7, $8, $9, $10, $11,
               $12::evidence_tier, $13::JSONB)
       ON CONFLICT (user_id, refresh_key) DO UPDATE SET refresh_key = excluded.refresh_key
       RETURNING id`,
      [userId, refreshKey, candidate.kind, candidate.statement, candidate.n, candidate.wins,
        candidate.losses, candidate.rate, candidate.interval.low, candidate.interval.high,
        candidate.effectSize, candidate.tier, JSON.stringify(candidate.filter)],
    );
    const inserted = capturedRows<IdRow>(insertedResult, ID_FIELDS, [1]);
    if (!UUID.test(inserted[0].id)) {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    }
    const patternId = inserted[0].id;
    await client.query(
      `INSERT INTO pattern_evidence (user_id, pattern_id, trade_id)
       SELECT $1, $2, t.id
         FROM trades t
         JOIN trade_intents i ON i.id = t.intent_id AND i.user_id = $1
        WHERE t.user_id = $1 AND t.id = ANY($3::UUID[])
       ON CONFLICT (user_id, pattern_id, trade_id) DO NOTHING`,
      [userId, patternId, sourceIds],
    );
    const persistedResult = await client.query<{ trade_id: string }>(
      `SELECT pe.trade_id
         FROM pattern_evidence pe
         JOIN patterns p ON p.id = pe.pattern_id AND p.user_id = $1
         JOIN trades t ON t.id = pe.trade_id AND t.user_id = $1
        WHERE pe.user_id = $1 AND pe.pattern_id = $2
        ORDER BY pe.trade_id`,
      [userId, patternId],
    );
    const persisted = capturedRows<{ trade_id: string }>(persistedResult, PERSISTED_FIELDS);
    const persistedIds = persisted.map((row) => row.trade_id);
    if (persistedIds.length !== candidate.n || persistedIds.some((id) => !UUID.test(id)) ||
        new Set(persistedIds).size !== candidate.n || sourceIds.some((id) => !persistedIds.includes(id))) {
      throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
    }
    return patternId;
  }

  private async writeWarningAudit(
    client: SqlClient,
    userId: string,
    rows: readonly WarningAuditRow[],
  ): Promise<void> {
    await client.query(
      `DELETE FROM warning_outcomes
        WHERE user_id = $1 AND NOT (code = ANY($2::warning_code[]))`,
      [userId, rows.map((row) => row.code)],
    );
    for (const row of rows) {
      await client.query(
        `INSERT INTO warning_outcomes
           (user_id, code, times_shown, times_heeded, times_defied,
            r_when_heeded, r_when_defied, computed_at)
         VALUES ($1, $2::warning_code, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id, code) DO UPDATE SET
           times_shown = excluded.times_shown,
           times_heeded = excluded.times_heeded,
           r_when_heeded = excluded.r_when_heeded,
                     r_when_defied = excluded.r_when_defied,
                     computed_at = excluded.computed_at
                   WHERE warning_outcomes.user_id = $1`,
                   [userId, row.code, row.timesShown, row.timesHeeded, row.timesDefied,
                     row.rWhenHeeded, row.rWhenDefied],
                 );
               }
             }

             // ---- PaperOpsStore: monitoring / settlement / behavioral events ----

             async listMonitorableOpenTrades(userId: string): Promise<MonitorableOpenTrade[]> {
               if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
               const client = await this.pool.connect();
               try {
                 const result = await client.query<Record<string, unknown>>(
                   `SELECT t.id AS trade_id, i.id AS intent_id, i.asset,
                           t.direction::STRING AS direction, t.size, t.entry_fill,
                           t.initial_stop AS stop, t.initial_target AS target,
                           t.opened_at, t.closed_at
                      FROM trades t
                      JOIN trade_intents i ON i.id = t.intent_id AND i.user_id = $1
                     WHERE t.user_id = $1 AND t.closed_at IS NULL
                     ORDER BY t.opened_at DESC, t.id`,
                   [userId],
                 );
                 const rows = capturedRows<Record<string, unknown>>(result, MONITORABLE_FIELDS);
                 if (rows.some(
                   (r) => !UUID.test(r.trade_id as string) || !UUID.test(r.intent_id as string) ||
                     typeof r.asset !== "string" || r.asset.length === 0 ||
                     (r.direction !== "long" && r.direction !== "short") ||
                     !validDecimal(r.size as string) || !validDecimal(r.entry_fill as string) ||
                     (r.stop !== null && !validDecimal(r.stop as string)) ||
                     (r.target !== null && !validDecimal(r.target as string)) ||
                     r.closed_at !== null,
                 )) malformedSql();
                 return rows.map((row) => ({
                   tradeId: row.trade_id, intentId: row.intent_id, asset: row.asset,
                   direction: row.direction, entryFill: toFiniteNumber(row.entry_fill),
                   size: toFiniteNumber(row.size),
                   stop: row.stop === null ? null : toFiniteNumber(row.stop),
                   target: row.target === null ? null : toFiniteNumber(row.target),
                   openedAt: toIsoUtc(row.opened_at), closedAt: null,
                 })) as unknown as MonitorableOpenTrade[];
               } catch {
                 throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
               } finally { client.release(); }
             }

             async recordBehaviorEvent(event: BehaviorEvent): Promise<void> {
               const v = validateBehaviorEvent(event);
               const client = await this.pool.connect();
               try {
                 await client.query(
                   `INSERT INTO behavior_events
                     (user_id, version, type, at, subject_kind, subject_id, availability, acceptance, outcome, verification)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10::JSONB)`,
                   [v.userId, v.version, v.type, v.at, v.subjectKind, v.subjectId ?? null,
                     v.availability, v.acceptance,
                     v.outcome === null ? null : JSON.stringify(v.outcome),
                     JSON.stringify(v.verification)],
                 );
               } catch {
                 throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
               } finally { client.release(); }
             }

             async listBehaviorEvents(userId: string): Promise<BehaviorEvent[]> {
               if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
               const client = await this.pool.connect();
               try {
                 const result = await client.query<Record<string, unknown>>(
                   `SELECT id, version, type, at, subject_kind, subject_id, availability, acceptance, outcome, verification
                      FROM behavior_events WHERE user_id = $1 ORDER BY at DESC, id`,
                   [userId],
                 );
                 const rows = capturedRows<Record<string, unknown>>(result, BEHAVIOR_FIELDS);
                 const events: BehaviorEvent[] = [];
                 for (const row of rows) {
                   try {
                     events.push(validateBehaviorEvent({
                                           version: toFiniteNumber(row.version), id: row.id, userId, type: row.type, at: toIsoUtc(row.at),
                       subjectKind: row.subject_kind, subjectId: row.subject_id ?? null,
                       availability: row.availability, acceptance: row.acceptance,
                       outcome: row.outcome === null ? null : row.outcome,
                       verification: row.verification,
                     }));
                   } catch {
                     malformedSql();
                   }
                 }
                 return events;
                               } catch {
                                 throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
                               } finally { client.release(); }
             }

             async listSettleableTrades(userId: string): Promise<SettleableTrade[]> {
               if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
               const client = await this.pool.connect();
               try {
                 const result = await client.query<Record<string, unknown>>(
                   `SELECT t.id AS trade_id, i.asset, t.direction::STRING AS direction,
                           t.pnl, t.r_multiple, t.exit_reason::STRING AS exit_reason, t.closed_at
                      FROM trades t
                      JOIN trade_intents i ON i.id = t.intent_id AND i.user_id = $1
                     WHERE t.user_id = $1 AND t.closed_at IS NOT NULL AND t.pnl IS NOT NULL AND t.r_multiple IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM settlements s WHERE s.user_id = $1 AND s.trade_id = t.id)
                     ORDER BY t.closed_at DESC, t.id`,
                   [userId],
                 );
                 const rows = capturedRows<Record<string, unknown>>(result, SETTLEABLE_FIELDS);
                 const out: SettleableTrade[] = [];
                 for (const row of rows) {
                   if (!UUID.test(row.trade_id as string) || typeof row.asset !== "string" || row.asset.length === 0 ||
                       (row.direction !== "long" && row.direction !== "short") ||
                       typeof row.exit_reason !== "string" || row.exit_reason.length === 0) malformedSql();
                   out.push({
                     tradeId: row.trade_id as string, asset: row.asset as string, direction: row.direction as string,
                     pnl: toFiniteNumber(row.pnl), rMultiple: toFiniteNumber(row.r_multiple),
                     exitReason: row.exit_reason as SettleableTrade["exitReason"],
                     closedAt: toIsoUtc(row.closed_at),
                   });
                 }
                 return out;
               } catch {
                 throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
               } finally { client.release(); }
             }

             async settleAtomic(userId: string, tradeId: string, settledAt: string): Promise<SettleAttempt> {
               if (!validUserId(userId) || !UUID.test(tradeId)) throw new PaperTradeError("INVALID_REQUEST");
               const client = await this.pool.connect();
               try {
                 await client.query("BEGIN");
                 const tradeResult = await client.query<Record<string, unknown>>(
                   `SELECT pnl, r_multiple, exit_reason::STRING AS exit_reason, closed_at
                      FROM trades WHERE user_id = $1 AND id = $2 FOR UPDATE`,
                   [userId, tradeId],
                 );
                 const tradeRows = capturedRows<Record<string, unknown>>(tradeResult, SETTLE_TRADE_FIELDS);
                 if (tradeRows.length === 0) throw new PaperTradeError("TRADE_NOT_FOUND");
                 const trade = tradeRows[0];
                 if (trade.closed_at === null || trade.pnl === null || trade.r_multiple === null) {
                   throw new PaperTradeError("TRADE_NOT_CLOSED");
                 }
                 const inserted = await client.query<{ id: string }>(
                   `INSERT INTO settlements (user_id, trade_id, pnl, r_multiple, exit_reason, settled_at)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (user_id, trade_id) DO NOTHING
                    RETURNING id`,
                   [userId, tradeId, trade.pnl, trade.r_multiple, trade.exit_reason, settledAt],
                 );
                 if (inserted.rows.length === 0) {
                   const existingResult = await client.query<Record<string, unknown>>(
                     `SELECT pnl, r_multiple FROM settlements WHERE user_id = $1 AND trade_id = $2`,
                     [userId, tradeId],
                   );
                   await client.query("COMMIT");
                   const existing = capturedRows<Record<string, unknown>>(existingResult, SETTLE_EXISTING_FIELDS);
                   if (existing.length === 0 || existing[0].pnl === null || existing[0].r_multiple === null) malformedSql();
                   return {
                     state: "already_settled",
                     pnl: toFiniteNumber(existing[0].pnl),
                     rMultiple: toFiniteNumber(existing[0].r_multiple),
                   };
                 }
                 await client.query("COMMIT");
                 return {
                   state: "settled",
                   pnl: toFiniteNumber(trade.pnl),
                   rMultiple: toFiniteNumber(trade.r_multiple),
                 };
               } catch (error) {
                 await client.query("ROLLBACK").catch(() => {});
                 throw error;
               } finally { client.release(); }
             }

             // ---- InsightsStore: pattern candidates read ----

             async listPatternCandidates(userId: string): Promise<PatternCandidate[]> {
               if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
               const client = await this.pool.connect();
               try {
                 const result = await client.query<Record<string, unknown>>(
                   `SELECT id, kind::STRING AS kind, statement, n, wins, losses, rate,
                           ci_low, ci_high, effect_size, evidence_tier::STRING AS evidence_tier, filter
                      FROM patterns WHERE user_id = $1 AND superseded_by IS NULL
                     ORDER BY created_at DESC, id`,
                   [userId],
                 );
                 const candidates: PatternCandidate[] = [];
                 for (const row of result.rows as Array<Record<string, unknown>>) {
                   const pid = row.id as string;
                   if (!UUID.test(pid)) malformedSql();
                   const evidenceResult = await client.query<{ trade_id: string }>(
                     `SELECT trade_id FROM pattern_evidence WHERE user_id = $1 AND pattern_id = $2 ORDER BY trade_id`,
                     [userId, pid],
                   );
                   const sourceTradeIds = evidenceResult.rows.map((r) => r.trade_id);
                   try {
                     candidates.push(validatePatternCandidate({
                       kind: row.kind,
                       statement: row.statement,
                       n: toFiniteNumber(row.n),
                       wins: toFiniteNumber(row.wins),
                       losses: toFiniteNumber(row.losses),
                       rate: toFiniteNumber(row.rate),
                       interval: { low: toFiniteNumber(row.ci_low), high: toFiniteNumber(row.ci_high) },
                       effectSize: toFiniteNumber(row.effect_size),
                       tier: row.evidence_tier,
                       filter: row.filter,
                       sourceTradeIds,
                     }));
                   } catch {
                     malformedSql();
                   }
                 }
                 return candidates;
                               } catch {
                                 throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
                               } finally { client.release(); }
                             }

                   // ---- Drop-in methods used by the request path (pending intent, open reads) ----

                   /** Provisions a tenant-scoped pending trade intent so execution can claim it. */
                   async registerPendingIntent(input: {
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
                   }): Promise<void> {
                     if (!validUserId(input.userId) || !UUID.test(input.intentId)) throw new PaperTradeError("INVALID_REQUEST");
                     const client = await this.pool.connect();
                     try {
                       await client.query(
                         `INSERT INTO trade_intents
                            (id, user_id, asset, asset_class, direction, size, entry, stop_loss, take_profit,
                             risk_pct, thesis_raw, session, regime, status)
                          VALUES ($1,$2,$3,$4,$5::direction,$6,$7,$8,$9,$10,$11,$12::session,$13::regime,'pending')
                          ON CONFLICT (id) DO NOTHING`,
                         [input.intentId, input.userId, input.asset, input.assetClass, input.direction,
                           input.size, input.entry, input.stopLoss, input.takeProfit, input.riskPct,
                           input.thesisRaw, input.session, input.regime],
                       );
                     } catch {
                       throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
                     } finally { client.release(); }
                   }

                   /** Tenant-scoped list of the actor's open (unclosed) paper trades. */
                   async openTrades(userId: string): Promise<{
                     id: string; asset: string; assetClass: string; direction: string;
                     size: number; entry: number; stop: number | null; openedAt: string;
                   }[]> {
                     if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
                     const client = await this.pool.connect();
                     try {
                       const result = await client.query<Record<string, unknown>>(
                                               `SELECT t.id AS t_id, i.asset, i.asset_class, t.direction::STRING AS direction,
                                                       t.size, t.entry_fill, t.initial_stop AS stop, t.opened_at
                                                  FROM trades t
                                                  JOIN trade_intents i ON i.id = t.intent_id AND i.user_id = $1
                                                 WHERE t.user_id = $1 AND t.closed_at IS NULL
                           ORDER BY t.opened_at DESC, t.id`,
                         [userId],
                       );
                       const rows = capturedRows<Record<string, unknown>>(result, OPEN_TRADE_FIELDS);
                       const out: { id: string; asset: string; assetClass: string; direction: string; size: number; entry: number; stop: number | null; openedAt: string }[] = [];
                       for (const row of rows) {
                         if (!UUID.test(row.t_id as string) || typeof row.asset !== "string" || typeof row.asset_class !== "string" ||
                             (row.direction !== "long" && row.direction !== "short") ||
                             !validDecimal(row.size as string) || !validDecimal(row.entry_fill as string) ||
                             (row.stop !== null && !validDecimal(row.stop as string))) malformedSql();
                         out.push({
                           id: row.t_id as string, asset: row.asset as string, assetClass: row.asset_class as string,
                           direction: row.direction as string, size: toFiniteNumber(row.size),
                           entry: toFiniteNumber(row.entry_fill),
                           stop: row.stop === null ? null : toFiniteNumber(row.stop),
                           openedAt: toIsoUtc(row.opened_at),
                         });
                       }
                       return out;
                     } catch {
                       throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
                     } finally { client.release(); }
                   }

                   async openTradeCount(userId: string): Promise<number> {
                     if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
                     const client = await this.pool.connect();
                     try {
                       const result = await client.query(
                         `SELECT count(*)::INT AS n FROM trades WHERE user_id = $1 AND closed_at IS NULL`,
                         [userId],
                       );
                       const row = result.rows[0] as Record<string, unknown> | undefined;
                       const n = row === undefined ? NaN : toFiniteNumber(row.n);
                       if (!Number.isSafeInteger(n)) malformedSql();
                       return n;
                     } catch {
                       throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
                     } finally { client.release(); }
                   }

                   async resolveDecisionFromRules(
                     rawIntent: unknown,
                     userId: string,
                   ): Promise<{ decision: "BLOCK" | "WARN" | "PASS"; warningsShown: WarningCode[] }> {
                     if (!validUserId(userId)) throw new PaperTradeError("INVALID_REQUEST");
                     if (typeof rawIntent !== "object" || rawIntent === null || Array.isArray(rawIntent)) {
                       throw new PaperTradeError("INVALID_REQUEST");
                     }
                     const intent = rawIntent as Record<string, unknown>;
                     if (typeof intent.riskPct !== "number" || !Number.isFinite(intent.riskPct) ||
                         typeof intent.sizeIncreaseAfterLoss !== "boolean") {
                       throw new PaperTradeError("INVALID_REQUEST");
                     }
                     const stopLoss = typeof intent.stopLoss === "number" && Number.isFinite(intent.stopLoss) ? intent.stopLoss : null;
                     const client = await this.pool.connect();
                     try {
                       const result = await client.query(
                                               `SELECT id, predicate, enforcement::STRING AS enforcement
                                                  FROM rules WHERE user_id = $1 AND active = TRUE AND retired_at IS NULL`,
                                               [userId],
                                             );
                                             const compiled = result.rows.map((row: Record<string, unknown>) =>
                                               compileRule({ id: row.id, predicate: row.predicate, enforcement: row.enforcement as "warn" | "block" }));
                       const state = {
                         risk_pct: typeof intent.riskPct === "number" ? intent.riskPct : 0,
                         minutes_since_last_loss: Number.MAX_SAFE_INTEGER,
                         trades_today: 0,
                         has_stop_loss: stopLoss !== null,
                         size_increase_after_loss: intent.sizeIncreaseAfterLoss === true,
                       };
                       const { decision, evidence } = evaluateRules(compiled, state);
                       const warningsShown = evidence
                         .filter((row) => !row.passed && row.enforcement === "warn" && row.field !== undefined)
                         .map((row) => FIELD_TO_WARNING[row.field as RuleField] as WarningCode);
                       return { decision, warningsShown: [...new Set(warningsShown)] };
                                           } catch {
                                             throw new PaperTradeError("PERSISTENCE_UNAVAILABLE");
                                           } finally { client.release(); }
                   }
                 }
