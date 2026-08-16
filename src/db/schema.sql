-- Deja — memory schema
--
-- Design rules this file follows, from PRD §4:
--   1. Every row is tenant-scoped by user_id. There is no cross-tenant read path.
--   2. Memory is append-only. Conclusions are superseded, never overwritten, so
--      the agent's changing beliefs are themselves auditable.
--   3. Warnings and strategies are closed enums, not free text — the compliance
--      ledger depends on being able to COUNT them.
--   4. Statistics carry n and an interval wherever they are stored, so nothing
--      downstream can render a percentage without knowing how thin it is.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE IF NOT EXISTS direction AS ENUM ('long', 'short');

CREATE TYPE IF NOT EXISTS strategy AS ENUM (
  'breakout_retest', 'reversal', 'momentum', 'range', 'trend_pullback',
  'news', 'scalp', 'other'
);

CREATE TYPE IF NOT EXISTS market_thesis AS ENUM ('continuation', 'reversal', 'mean_revert');

CREATE TYPE IF NOT EXISTS session AS ENUM ('asia', 'london', 'ny', 'off');

CREATE TYPE IF NOT EXISTS regime AS ENUM ('trending', 'ranging', 'volatile', 'unknown');

CREATE TYPE IF NOT EXISTS confidence AS ENUM ('low', 'medium', 'high');

CREATE TYPE IF NOT EXISTS intent_status AS ENUM (
  'pending', 'blocked', 'cancelled', 'executed'
);

CREATE TYPE IF NOT EXISTS decision_action AS ENUM (
  'executed', 'cancelled', 'modified_then_executed'
);

CREATE TYPE IF NOT EXISTS enforcement AS ENUM ('warn', 'block');

CREATE TYPE IF NOT EXISTS severity AS ENUM ('info', 'caution', 'severe');

CREATE TYPE IF NOT EXISTS exit_reason AS ENUM ('stop', 'target', 'manual', 'timeout', 'open');

-- Closed taxonomy. Free-text warnings cannot be aggregated, and the agent's
-- self-audit ("shown 7, defied 6, -1.1R when defied") is the differentiator.
CREATE TYPE IF NOT EXISTS warning_code AS ENUM (
  'EARLY_ENTRY',
  'OVERSIZED_RISK',
  'POST_LOSS_REENTRY',
  'DAILY_CAP_EXCEEDED',
  'NO_STOP_LOSS',
  'STOP_WIDENED',
  'WEAK_REGIME_MATCH',
  'ASSET_UNDERPERFORMANCE',
  'STRATEGY_DRIFT',
  'SIZE_ESCALATION',
  'LOW_EVIDENCE'
);

CREATE TYPE IF NOT EXISTS event_type AS ENUM (
  'stop_widened', 'stop_tightened', 'target_moved', 'size_added',
  'early_manual_exit', 'rule_overridden', 'warning_defied'
);

CREATE TYPE IF NOT EXISTS pattern_kind AS ENUM (
  'strategy', 'behavioral', 'asset', 'risk', 'execution', 'conditional'
);

-- Governs what the agent is permitted to claim. See PRD §5.
--   anecdote (n<8): no percentages, show raw episodes instead
--   signal   (8<=n<30): rate with a Wilson interval, hedged language
--   established (n>=30): assert the pattern
CREATE TYPE IF NOT EXISTS evidence_tier AS ENUM ('anecdote', 'signal', 'established');

CREATE TYPE IF NOT EXISTS trade_source AS ENUM ('deja', 'imported', 'seed');

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       STRING NOT NULL UNIQUE,
  display_name STRING,
  tz          STRING NOT NULL DEFAULT 'UTC',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             STRING NOT NULL,
  starting_balance DECIMAL(18,2) NOT NULL DEFAULT 10000,
  currency         STRING NOT NULL DEFAULT 'USD',
  mode             STRING NOT NULL DEFAULT 'paper',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_accounts_user (user_id)
);

-- ---------------------------------------------------------------------------
-- Rules — compiled to typed predicates, evaluated deterministically.
-- The LLM writes the predicate once at creation; it is never in the
-- enforcement path, so a block is reproducible and survives Bedrock outages.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_text STRING NOT NULL,              -- what the user actually typed
  predicate   JSONB NOT NULL,               -- {field, op, value}
  enforcement enforcement NOT NULL DEFAULT 'warn',
  active      BOOL NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at  TIMESTAMPTZ,
  INDEX idx_rules_user_active (user_id, active)
);

-- ---------------------------------------------------------------------------
-- Trade intent + thesis
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trade_intents (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id     UUID REFERENCES accounts(id) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  asset          STRING NOT NULL,
  asset_class    STRING NOT NULL DEFAULT 'crypto',
  direction      direction NOT NULL,
  size           DECIMAL(24,8) NOT NULL,
  entry          DECIMAL(24,8) NOT NULL,
  stop_loss      DECIMAL(24,8),
  take_profit    DECIMAL(24,8),
  risk_pct       DECIMAL(6,3),

  confidence     confidence,

  -- Both forms are kept on purpose. The raw text lets the agent quote the
  -- trader back to themselves, which is more persuasive than any statistic.
  -- The canonical text is what gets embedded: short trading prose embeds
  -- heavily on asset name and direction, so raw text would retrieve on
  -- vocabulary rather than situation. See PRD §4.3.
  thesis_raw       STRING NOT NULL,
  thesis_canonical STRING,
  thesis_embedding VECTOR(1024),

  strategy       strategy,
  signals        STRING[],
  market_thesis  market_thesis,
  session        session,
  regime         regime NOT NULL DEFAULT 'unknown',

  -- Behavioural telemetry: objective, needs no user cooperation, and immune
  -- to the self-report problem that undermines the stated thesis. PRD §0.2.
  seconds_to_submit INT,

  status         intent_status NOT NULL DEFAULT 'pending',

  INDEX idx_intents_user_created (user_id, created_at DESC),
  INDEX idx_intents_user_strategy (user_id, strategy),
  INDEX idx_intents_prefilter (user_id, direction, asset_class, status)
);

-- The capability the whole retrieval design rests on.
CREATE VECTOR INDEX IF NOT EXISTS idx_intents_thesis_vec
  ON trade_intents (thesis_embedding);

-- ---------------------------------------------------------------------------
-- Brief + typed warnings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS briefs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id     UUID NOT NULL REFERENCES trade_intents(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  body          STRING NOT NULL,
  -- Every claim in body must trace to one of these. Uncited claims are
  -- stripped before render, and this column is what makes that auditable.
  retrieved_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  evidence_tier evidence_tier NOT NULL DEFAULT 'anecdote',
  n_evidence    INT NOT NULL DEFAULT 0,
  model_id      STRING,
  -- Observability: replay any brief in the demo and explain where it came from.
  retrieval_ms  INT,
  candidates    INT,
  input_tokens  INT,
  output_tokens INT,
  degraded      BOOL NOT NULL DEFAULT false,  -- true when Bedrock was unavailable
  INDEX idx_briefs_intent (intent_id),
  INDEX idx_briefs_user (user_id, created_at DESC)
);

CREATE TABLE IF NOT EXISTS warnings (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id     UUID NOT NULL REFERENCES briefs(id) ON DELETE CASCADE,
  intent_id    UUID NOT NULL REFERENCES trade_intents(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code         warning_code NOT NULL,
  severity     severity NOT NULL DEFAULT 'caution',
  n_evidence   INT NOT NULL DEFAULT 0,
  stat_summary JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  INDEX idx_warnings_user_code (user_id, code),
  INDEX idx_warnings_intent (intent_id)
);

-- ---------------------------------------------------------------------------
-- Decision, execution, behaviour
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id       UUID NOT NULL REFERENCES trade_intents(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action          decision_action NOT NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Defiance is the signal that makes the agent measurable: it is the only way
  -- to compare outcomes when advice was heeded against when it was ignored.
  warnings_shown  warning_code[] NOT NULL DEFAULT ARRAY[]::warning_code[],
  warnings_defied warning_code[] NOT NULL DEFAULT ARRAY[]::warning_code[],
  rules_blocked   UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  UNIQUE (user_id, intent_id),
  INDEX idx_decisions_user (user_id, at DESC),
  INDEX idx_decisions_intent (intent_id)
);

CREATE TABLE IF NOT EXISTS trades (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id      UUID REFERENCES trade_intents(id) ON DELETE SET NULL,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id     UUID REFERENCES accounts(id) ON DELETE CASCADE,

  asset          STRING NOT NULL,
  direction      direction NOT NULL,
  size           DECIMAL(24,8) NOT NULL,

  opened_at      TIMESTAMPTZ NOT NULL,
  closed_at      TIMESTAMPTZ,
  entry_fill     DECIMAL(24,8) NOT NULL,
  exit_fill      DECIMAL(24,8),

  initial_stop   DECIMAL(24,8),
  final_stop     DECIMAL(24,8),
  initial_target DECIMAL(24,8),

  pnl            DECIMAL(18,2),
  r_multiple     DECIMAL(10,3),
  duration_s     INT,
  exit_reason    exit_reason NOT NULL DEFAULT 'open',

  -- Imported trades carry outcome and behaviour but no thesis; the UI must say
  -- so rather than imply the trader wrote a rationale they never wrote.
  source         trade_source NOT NULL DEFAULT 'deja',

  UNIQUE (user_id, intent_id),
  INDEX idx_trades_user_closed (user_id, closed_at DESC),
  INDEX idx_trades_user_asset (user_id, asset),
  INDEX idx_trades_intent (intent_id)
);

-- Append-only. This is where the honest signal lives — none of it requires the
-- trader to journal anything.
CREATE TABLE IF NOT EXISTS trade_events (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id   UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type event_type NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::JSONB,
  INDEX idx_events_trade (trade_id, at),
  INDEX idx_events_user_type (user_id, event_type)
);

-- ---------------------------------------------------------------------------
-- Derived memory
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS patterns (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Superseded rather than updated: January's "70% from 10 trades" and
  -- August's "62% from 61" are both true, and the revision history is itself
  -- evidence that the memory layer learns.
  superseded_by UUID REFERENCES patterns(id) ON DELETE SET NULL,
  refresh_key   STRING NOT NULL,

  kind          pattern_kind NOT NULL,
  statement     STRING NOT NULL,

  n             INT NOT NULL,
  wins          INT NOT NULL DEFAULT 0,
  losses        INT NOT NULL DEFAULT 0,
  rate          DECIMAL(6,4),
  ci_low        DECIMAL(6,4),          -- Wilson score interval
  ci_high       DECIMAL(6,4),
  effect_size   DECIMAL(8,4),
  avg_r         DECIMAL(10,3),
  evidence_tier evidence_tier NOT NULL,

  -- Reproducible cohort definition, so any pattern can be recomputed from raw
  -- rows rather than trusted because it is stored.
  filter        JSONB NOT NULL DEFAULT '{}'::JSONB,

  UNIQUE (user_id, refresh_key),
  INDEX idx_patterns_user_live (user_id, kind, superseded_by)
);

CREATE TABLE IF NOT EXISTS pattern_evidence (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pattern_id UUID NOT NULL REFERENCES patterns(id) ON DELETE CASCADE,
  trade_id   UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, pattern_id, trade_id),
  INDEX idx_pattern_evidence_trade (trade_id)
);

-- ---------------------------------------------------------------------------
-- Agent self-audit — "has this agent actually helped you?"
-- Materialised by the scheduled job in Phase 7.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS warning_outcomes (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code          warning_code NOT NULL,
  times_shown   INT NOT NULL DEFAULT 0,
  times_heeded  INT NOT NULL DEFAULT 0,
  times_defied  INT NOT NULL DEFAULT 0,
  r_when_heeded DECIMAL(10,3),
  r_when_defied DECIMAL(10,3),
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, code)
);

-- ---------------------------------------------------------------------------
-- Behavioral events (append-only) and paper settlements, added when the live
-- Cockroach store was wired as the runtime adapter. Both are tenant-scoped and
-- append-only, mirroring the in-memory adapter's semantics.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS behavior_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version      INT NOT NULL DEFAULT 1,
  type         STRING NOT NULL,
  at           TIMESTAMPTZ NOT NULL,
  subject_kind STRING NOT NULL,
  subject_id   UUID,
  availability STRING NOT NULL,
  acceptance   STRING NOT NULL,
  outcome      JSONB,
  verification JSONB NOT NULL DEFAULT '{}'::JSONB,
  INDEX idx_behavior_user (user_id, at DESC)
);

CREATE TABLE IF NOT EXISTS settlements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id    UUID NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  pnl         DECIMAL(18,2) NOT NULL,
  r_multiple  DECIMAL(10,3) NOT NULL,
  exit_reason exit_reason NOT NULL,
  settled_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, trade_id),
  INDEX idx_settlements_user (user_id, settled_at DESC)
);
