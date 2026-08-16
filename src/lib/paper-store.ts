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
  captureDescriptorSafeSqlResult,
  createPatternCandidate,
  validatePatternCandidate,
  validateWarningAuditRows,
} from "./paper-trade";

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

const INTENT_FIELDS = ["asset", "direction", "size", "entry", "initial_stop", "initial_target", "account_id"] as const;
const REPLAY_FIELDS = ["decision_id", "trade_id"] as const;
const ID_FIELDS = ["id"] as const;
const TRADE_FIELDS = ["trade_id", "intent_id", "user_id", "direction", "entry_fill", "size", "initial_stop", "opened_at", "closed_at"] as const;
const CLOSED_FIELDS = ["trade_id", "intent_id", "thesis_raw", "r_multiple", "asset", "asset_class", "direction", "strategy", "regime"] as const;
const PATTERN_SOURCE_FIELDS = ["id", "intent_id", "thesis_raw", "r_multiple", "asset", "asset_class", "direction", "strategy", "regime"] as const;
const WARNING_FIELDS = ["tradeId", "code", "shown", "defied", "rMultiple"] as const;
const PERSISTED_FIELDS = ["trade_id"] as const;

export class CockroachPaperStore implements PaperExecutionStore, PaperClosureStore, PaperMemoryStore {
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
      const updatedResult = await client.query(
        `UPDATE trades
            SET closed_at = $3, exit_fill = $4, pnl = $5, r_multiple = $6,
                duration_s = $7, exit_reason = $8::exit_reason
          WHERE user_id = $1 AND id = $2 AND closed_at IS NULL`,
        [input.userId, input.tradeId, input.closedAt, input.exitFill, result.pnl,
          result.rMultiple, result.durationS, input.exitReason],
      );
      const updated = capturedResult(updatedResult, [], [0]);
      if (updated.rowCount !== 1) throw new PaperTradeError("TRADE_ALREADY_CLOSED");
      await client.query("COMMIT");
      return result;
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
          ORDER BY shown.code, t.closed_at, t.id`, [userId]);
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
           times_defied = excluded.times_defied,
           r_when_heeded = excluded.r_when_heeded,
           r_when_defied = excluded.r_when_defied,
           computed_at = excluded.computed_at
         WHERE warning_outcomes.user_id = $1`,
        [userId, row.code, row.timesShown, row.timesHeeded, row.timesDefied,
          row.rWhenHeeded, row.rWhenDefied],
      );
    }
  }
}
