# Deja — PRD

*"You've been here before."*

A decision-memory layer for traders.

**Hackathon:** CockroachDB × AWS — Build with Agentic Memory
**Submission deadline:** 2026-08-18
**Status:** locked scope, v2 (post-audit)

---

## 0. What changed from v1

v1 was a strong memory design attached to a statistically indefensible claim. v2 keeps the
memory architecture and fixes four things:

1. **Epistemic honesty.** The agent never reports a statistic without `n` and an evidence tier.
   At low `n` it shows raw past episodes instead of fabricated percentages, and says so.
2. **Objective behavioral telemetry.** Self-reported theses are unreliable. The system derives
   honest signals (time-to-submit, minutes since last loss, stop widening, trades today) that
   need no user cooperation. These carry equal weight to the prose.
3. **Deterministic rule enforcement.** Rules compile once from natural language into typed
   predicates, then execute in code. The LLM writes rules; it never adjudicates them.
4. **Hybrid retrieval.** Embeddings are computed over an LLM-normalized *canonical* thesis,
   not raw user text, and vector search runs inside a SQL-prefiltered candidate set.

Also repositioned: this is a **decision-memory layer**, demonstrated on trading because trading
is the rare domain with clean, fast, numeric ground truth on every single decision. The loop
generalizes; trading makes it provable.

---

## 1. Product summary

A trading terminal with a persistent agent that sits **between trade intent and execution**.

Before a trade executes, the trader states why they are taking it. The agent retrieves the
trader's own history — past theses, outcomes, behavioral events, derived patterns, and explicit
rules — and returns a pre-trade brief grounded in that history. Rules can hard-block execution.

The agent does not predict the market. Its question is:

> *What happened the previous times you traded for reasons like this?*

Every closed trade writes new memory. Memory changes what the system says and what it permits.

**Positioning:** not signals, not a journal. Journals are retrospective — they tell you after
you lost. This intervenes at intent time, and it audits itself.

**One-liner:** *You've been here before. Deja remembers what happened.*

**ICP:** discretionary swing/position traders, 1–10 trades per week. The thesis friction is a
feature at that cadence and poison for scalpers. Stated deliberately; not a product for everyone.

---

## 2. The differentiator, stated plainly

Three things, in order of how rare they are:

1. **Memory that gates action.** Most agentic-memory systems use memory as read-only context.
   Here, a retrieved rule memory can prevent an action from happening at all.
2. **A compliance ledger on the agent itself.** Every warning the agent issues is typed and
   logged alongside whether the trader obeyed it and what happened. The system can therefore
   answer *"has this agent actually helped you?"* with evidence — and admit when it hasn't.
3. **An agent that knows the limits of its own memory.** It distinguishes anecdote from
   established pattern and refuses to overclaim.

---

## 3. Core loop

```
TRADE INTENT
  → STATE THESIS (mandatory)
  → CANONICALIZE THESIS (Bedrock → structured attrs + canonical text)
  → EMBED canonical text (Bedrock Titan v2, 1024-dim)
  → RETRIEVE (SQL prefilter → vector ANN → rerank)
  → EVALUATE RULES (deterministic predicates)
  → GENERATE PRE-TRADE BRIEF (Bedrock, grounded only in retrieved rows)
  → BLOCK | WARN | PASS
  → TRADER DECIDES (decision recorded, incl. defiance of warnings)
  → EXECUTE (paper)
  → MONITOR (behavioral events captured automatically)
  → CLOSE → OUTCOME attached to original thesis + brief + warnings
  → NEW MEMORY
  → PATTERN DISCOVERY (scheduled SQL, gated on n and effect size)
  → available to the next trade
```

---

## 4. Data model (CockroachDB)

All tables carry `user_id` and are row-level scoped. Memory rows are **append-only** —
conclusions are superseded by new revisions, never overwritten, so the agent's evolving
understanding is itself auditable.

### 4.1 Identity & config
```sql
users(id, email, created_at, tz)
accounts(id, user_id, name, starting_balance, currency, mode)  -- mode = 'paper'
```

### 4.2 Rules (typed, compiled)
```sql
rules(
  id, user_id, created_at, retired_at,
  source_text,           -- what the user typed
  predicate JSONB,       -- compiled, deterministic
  enforcement,           -- 'warn' | 'block'
  active BOOL
)
```

Predicate DSL — a flat, evaluable JSON object. The LLM produces it once at rule creation,
the user confirms the parse, then it is executed in TypeScript with zero model involvement:

```json
{ "field": "risk_pct",                "op": "lte", "value": 2 }
{ "field": "minutes_since_last_loss", "op": "gte", "value": 20 }
{ "field": "trades_today",            "op": "lt",  "value": 3 }
{ "field": "has_stop_loss",           "op": "eq",  "value": true }
{ "field": "size_increase_after_loss","op": "eq",  "value": false }
```

Supported fields are a closed enum. If Bedrock cannot map a rule onto the enum, the UI says so
and asks the user to rephrase — it never invents a field.

### 4.3 Intent & thesis
```sql
trade_intents(
  id, user_id, account_id, created_at,
  asset, direction, size, entry, stop_loss, take_profit, risk_pct,
  confidence,                    -- low | medium | high
  thesis_raw TEXT,               -- preserved verbatim, always
  thesis_canonical TEXT,         -- LLM-normalized, template-rendered
  strategy,                      -- enum: breakout_retest | reversal | momentum | range | trend_pullback | news | other
  signals TEXT[],
  market_thesis,                 -- continuation | reversal | mean_revert
  session,                       -- asia | london | ny | off
  regime,                        -- trending | ranging | volatile (from price data)
  thesis_embedding VECTOR(1024),
  seconds_to_submit INT,         -- behavioral: chart-open → submit
  status                         -- pending | blocked | cancelled | executed
)

CREATE VECTOR INDEX idx_thesis ON trade_intents (thesis_embedding vector_cosine_ops);
```

**Why canonical, not raw, is embedded:** short trading prose embeds heavily on asset name and
direction, so "BTC long" swamps the actual setup. Canonicalization renders a fixed template
(`{strategy} on {asset_class} — signals: {...}; context: {regime}, {session}; expecting {market_thesis}`)
so similarity reflects *situation*, not vocabulary. Raw text is kept for display and for citing
the trader's own words back to them.

### 4.4 Brief & warnings (typed taxonomy)
```sql
briefs(id, intent_id, user_id, created_at, body TEXT, retrieved_ids UUID[], evidence_tier, model_id)

warnings(
  id, brief_id, intent_id, user_id,
  code,        -- CLOSED ENUM, see below
  severity,    -- info | caution | severe
  n_evidence INT, stat_summary JSONB
)
```

Warning codes are a closed enum so they can be **counted** — free-text warnings cannot be
aggregated, and the compliance ledger depends on aggregation:

`EARLY_ENTRY` · `OVERSIZED_RISK` · `POST_LOSS_REENTRY` · `DAILY_CAP_EXCEEDED` ·
`NO_STOP_LOSS` · `STOP_WIDENED` · `WEAK_REGIME_MATCH` · `ASSET_UNDERPERFORMANCE` ·
`STRATEGY_DRIFT` · `SIZE_ESCALATION` · `LOW_EVIDENCE`

### 4.5 Decision, execution, behavior
```sql
decisions(id, intent_id, user_id, action, at, warnings_shown TEXT[], warnings_defied TEXT[])
  -- action = executed | cancelled | modified_then_executed

trades(id, intent_id, user_id, opened_at, closed_at, entry_fill, exit_fill,
       size, initial_stop, final_stop, initial_target,
       pnl, r_multiple, duration_s, exit_reason)  -- stop | target | manual | timeout

trade_events(id, trade_id, user_id, at, event_type, payload JSONB)  -- APPEND ONLY
  -- event_type = stop_widened | stop_tightened | target_moved | size_added
  --            | early_manual_exit | rule_overridden | warning_defied
```

`trade_events` is where the honest signal lives. None of it requires the user to journal.

### 4.6 Derived memory
```sql
patterns(
  id, user_id, created_at, superseded_by,
  kind,                 -- strategy | behavioral | asset | risk | execution | conditional
  statement TEXT,       -- LLM-phrased, only after the stats gate passes
  n INT, wins INT, losses INT,
  rate NUMERIC, ci_low NUMERIC, ci_high NUMERIC,   -- Wilson score interval
  effect_size NUMERIC,
  evidence_tier,        -- anecdote | signal | established
  filter JSONB          -- reproducible predicate defining the cohort
)

pattern_evidence(pattern_id, trade_id)   -- every pattern is traceable to its rows
```

### 4.7 Agent self-audit
```sql
warning_outcomes(
  warning_code, user_id,
  times_shown, times_heeded, times_defied,
  r_when_heeded, r_when_defied, computed_at
)  -- materialized by the scheduled job
```

This is the table that lets the product say: *"You've ignored EARLY_ENTRY six times. Five lost,
averaging −1.1R. When you waited, you averaged +0.7R."* And equally: *"This warning has no
measurable effect on your results — we're going to stop showing it."*

---

## 5. Evidence tiers — the credibility fix

No statistic is ever displayed without `n`. Cohort size determines what the agent is *allowed*
to say:

| Tier | n | What the agent may render |
|---|---|---|
| **anecdote** | n < 8 | No percentages. Show the 3 most similar past trades verbatim — the trader's own words and what happened. Agent states explicitly: *"I've only seen 4 of these. This is an anecdote, not a pattern."* |
| **signal** | 8 ≤ n < 30 | Rate with a Wilson 95% interval, always shown. Hedged language: "leans", "so far". |
| **established** | n ≥ 30 | Assert the pattern. Still shows n and interval. |

A `patterns` row is only created when `n ≥ 8` **and** the Wilson interval excludes the user's
own baseline win rate. Otherwise it stays an anecdote and is not promoted to derived memory.

All language is associative, never causal. The system observes only trades *taken* — never the
ones skipped — and cannot separate a behavior from the regime it occurred in. The UI carries a
short, honest note saying exactly that.

**This is a feature, not a hedge.** An agent that knows the limits of its own memory is the
strongest possible demonstration of memory design.

---

## 6. Retrieval (hybrid, three-stage)

Naïve top-k cosine over all history returns vocabulary matches. Three stages:

**Stage 1 — SQL prefilter.** `user_id`, closed trades only, and hard attributes that must match
for comparison to be meaningful: direction, asset class, risk band. Widened progressively if the
candidate set is too small (< 20), and the widening is reported in the brief.

**Stage 2 — Vector ANN.** Cosine search on `thesis_embedding` over the prefiltered set via
CockroachDB's distributed vector index. Top 25.

**Stage 3 — Rerank.** Score = `0.5·cosine + 0.3·attribute_overlap + 0.2·recency_decay`
(half-life 90 days — a pattern from 18 months ago matters less). Top 8 to the LLM.

Retrieval also runs three cheap parallel lookups that need no vectors: active rules,
behavioral state (minutes since last loss, trades today, current streak), and any
`patterns` rows whose `filter` matches this intent.

**The agent never receives full history in its prompt.** It receives 8 retrieved trades, matched
patterns, rule evaluation results, and behavioral state. Everything it asserts must cite a
retrieved row id; unciteable claims are stripped before render.

---

## 7. Rule engine (deterministic)

```
Rule creation:  NL text → Bedrock → predicate JSON → user confirms parse → stored
Rule execution: intent + behavioral state → evaluate predicates in TS → pass | warn | block
```

The LLM is never in the enforcement path. A block is a pure function of the intent and the
database state, so it is reproducible, testable, fast, and — importantly — **still works when
Bedrock is down**. That is also the graceful-degradation story for production readiness.

Two enforcement modes: `warn` (advisory, execution allowed, defiance recorded) and `block`
(execution prevented until the predicate passes).

---

## 8. Architecture

```
Browser (Next.js App Router, TS)
   │
   ├─ POST /api/intents ──────────────► Intent service
   │                                      │
   │                          ┌───────────┴────────────┐
   │                          ▼                        ▼
   │                 Bedrock: Claude            Bedrock: Titan v2
   │                 (canonicalize)             (embed canonical)
   │                          │                        │
   │                          └───────────┬────────────┘
   │                                      ▼
   │                            Retrieval (hybrid)
   │                                      │
   │                    ┌─────────────────┴──────────────────┐
   │                    ▼                                    ▼
   │        CockroachDB Cloud                     CockroachDB MCP Server
   │        · distributed vector index            (agent-issued read-only
   │        · trades / theses / outcomes           memory queries, scoped role)
   │        · rules / events / patterns
   │                    │
   │                    ▼
   │           Rule engine (deterministic, TS)
   │                    │
   │                    ▼
   │        Bedrock: Claude → grounded brief → BLOCK | WARN | PASS
   │
   ├─ Execution (paper fills against price feed)
   ├─ Monitoring (cron: SL/TP settlement, behavioral event capture)
   └─ Pattern discovery (scheduled SQL aggregation + LLM phrasing, gated on stats)

Hosting: AWS Amplify Hosting (Next.js) — satisfies "deployed on AWS"
```

### CockroachDB tools used (≥2 required — we use 3)
| Tool | Use |
|---|---|
| **Distributed vector index** | Semantic retrieval over canonical theses |
| **Cloud Managed MCP Server** | Agent issues its own scoped, read-only memory queries during analysis |
| **ccloud CLI** | Cluster provisioning + schema migration, scripted in `infra/` and committed |

### AWS services
| Service | Use |
|---|---|
| **Bedrock — Claude** | Thesis canonicalization, rule compilation, brief generation, pattern phrasing |
| **Bedrock — Titan Text Embeddings v2** | 1024-dim embeddings |
| **Amplify Hosting** | Application deployment |

No AWS service is added purely to inflate sponsor surface.

---

## 9. Production readiness (a full quarter of the rubric — do not skip)

- **Tenancy:** every query scoped by `user_id`; no cross-tenant read path exists.
- **Least privilege:** the MCP server connects under a read-only role restricted to memory
  tables. The agent physically cannot write memory or read another tenant.
- **Immutability:** memory is append-only. Patterns are superseded via `superseded_by`, never
  updated in place. The agent's changing beliefs are themselves an audit trail.
- **Graceful degradation:** if Bedrock is unavailable, rule enforcement and retrieval still
  work; the brief degrades to raw retrieved episodes with a banner. The safety layer never
  depends on the model.
- **Grounding guard:** brief claims must cite retrieved row ids. Uncited claims are stripped.
- **Observability:** every intent logs retrieval latency, candidate counts, token usage, model
  id, and the exact retrieved ids — so any brief in the demo can be replayed and explained.
- **Resilience / global:** CockroachDB multi-region survivability; trader memory is
  latency-sensitive at intent time and must survive a region loss without losing decision history.
- **Scale:** vector index is distributed; retrieval cost is bounded by the prefilter, not by
  total history size. A 10-year trader and a 10-day trader have the same retrieval cost profile.
- **Compliance posture:** paper trading only, no custody, no real order routing, disclaimer in-app.

---

## 10. MVP scope

### Must have
- Trading terminal UI, small asset set (BTC / ETH / SOL), paper execution
- Mandatory thesis + confidence at intent time
- Bedrock canonicalization + embedding
- Hybrid retrieval over CockroachDB with distributed vector index
- Grounded pre-trade brief with evidence tiers and `n` on every statistic
- Personal rules: NL → compiled predicate → deterministic warn/block
- Decision recording including defiance of warnings
- Automatic behavioral event capture (stop widening, post-loss re-entry, size escalation)
- Trade closure → outcome attached to thesis, brief and warnings
- Scheduled pattern discovery gated on n + Wilson interval
- Trading DNA page, evidence-tiered
- Agent self-audit view (warning compliance ledger)
- **CSV import of real trade history**
- MCP-mediated agent memory queries

### Explicitly out of scope
Exchange, custody, wallets, order books, real order routing, advanced charting, market making,
automated strategies, price prediction, social/copy trading, indicator library, portfolio
management, mobile.

### Deliberate cuts (time sinks that look cheap and are not)
- **No live websocket position monitoring.** A cron polls one price endpoint and settles SL/TP.
- **Pattern discovery is SQL, not an agent.** It is aggregation. The LLM only phrases the result
  after the statistical gate passes. Cheaper, faster, deterministic.
- **Charting is a plain price line**, not a TradingView integration.

---

## 11. Demo credibility

Preloaded synthetic history is a trap — judges assume the fixture was authored to make the agent
look clever. Mitigation, in order of strength:

1. **CSV import path** for real broker/exchange trade history. Demo runs on a real exported
   account, anonymized. Doubles as the onboarding story: *upload your last 200 trades, get your
   DNA in 30 seconds.*
2. Seed data is generated by a committed, inspectable script with a fixed seed — reviewable,
   not hand-authored.
3. The live portion of the demo creates genuinely new memory on stage.

### Demo script
1. Import a real trade history. DNA page populates — with `n` and intervals visible everywhere.
2. Propose: BTC long, 3% risk, thesis "broke resistance, retesting, volume up, expect continuation."
3. **Blocked** — `OVERSIZED_RISK`, deterministic, instant, no model call.
4. Reduce to 1%. Rule passes. Brief appears: similar setups retrieved semantically (the retrieved
   thesis says *"reclaimed the previous range high"* — different words, same situation — this is
   the vector index earning its place), `EARLY_ENTRY` warning with n and interval shown.
5. Execute anyway. Defiance recorded.
6. Trade closes −1R. Memory written live.
7. Propose a similar trade. The brief now cites the trade from step 6 — *"including the one you
   took four minutes ago."* Memory changed behavior within the demo.
8. Open the self-audit view: *"EARLY_ENTRY: shown 7, defied 6, 5 losses, −1.1R avg when defied
   vs +0.7R when heeded."*
9. Show a low-`n` cohort where the agent **refuses to give a percentage** and says why.

Step 9 is the one that separates this from every other entry.

---

## 12. Success condition

A judge can see: the trader decides → the system remembers *why* → observes what happened →
discovers patterns across decisions → those memories **materially change the next decision, and
can prevent it entirely** → and the system honestly measures whether any of that helped.

Remove CockroachDB and the loop does not degrade; it ceases to exist.

> We are not building an AI that learns how to trade.
> We are building an AI that learns how *you* trade — and is honest about how little it knows.
