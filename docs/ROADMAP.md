# Deja — Build Roadmap

**Today:** 2026-08-09 · **Submission:** 2026-08-18 · **Build window:** 8 days + 1 buffer

Stack: Next.js (App Router, TypeScript) · CockroachDB Cloud · AWS Bedrock (Claude + Titan v2) ·
AWS Amplify Hosting · Drizzle ORM · Tailwind.

Every phase ends with a commit and push. Nothing is left uncommitted overnight.

---

### Phase 0 — Foundation · Day 1 (Aug 9)
- Repo init, Next.js + TS + Tailwind scaffold, env handling
- CockroachDB Cloud cluster provisioned via **ccloud CLI**, script committed to `infra/`
- Bedrock access verified (Claude + Titan v2 round-trip)
- **Exit:** app boots, DB connects, both Bedrock models respond. Pushed.

### Phase 1 — Memory schema + ingest · Day 1–2
- Full schema from PRD §4, Drizzle migrations
- `CREATE VECTOR INDEX` on `thesis_embedding`, verified with a real ANN query
- Seeded generator (fixed seed, committed) + **CSV importer** for real trade history
- Canonicalization + embedding pipeline over imported rows
- **Exit:** a few hundred real memories in CockroachDB, vector search returns sane neighbours. Pushed.

### Phase 2 — Retrieval engine · Day 2–3
- Three-stage hybrid retrieval (SQL prefilter → ANN → rerank), PRD §6
- Progressive prefilter widening + candidate-count reporting
- Wilson interval + evidence-tier calculator, unit tested
- **CockroachDB MCP server** wired under a read-only scoped role
- **Exit:** given an intent, returns 8 defensible neighbours + tier + stats. Pushed.

### Phase 3 — Rule engine · Day 3–4
- Predicate DSL, closed field enum, deterministic TS evaluator, unit tested
- NL → predicate compilation via Bedrock + user confirmation UI
- Behavioral state computation (minutes since last loss, trades today, streak)
- warn / block enforcement
- **Exit:** "max 2% risk" typed in plain English blocks a 3% trade, with no model in the path. Pushed.

### Phase 4 — Brief agent · Day 4–5
- Thesis capture UI with `seconds_to_submit` telemetry
- Grounded brief generation, citation guard (uncited claims stripped)
- Typed warning emission against the closed enum
- Evidence-tier-aware rendering — low `n` shows episodes, not percentages
- **Exit:** the full intent → brief → block/warn/pass path works end to end. Pushed.

### Phase 5 — Execution & closure loop · Day 5–6
- Paper execution, decision recording incl. warnings defied
- Cron price poll, SL/TP settlement, P&L + R multiple
- Automatic `trade_events` capture (stop widened, post-loss re-entry, size escalation)
- Outcome attached back to thesis + brief + warnings
- **Exit:** a trade taken in the UI closes and becomes retrievable memory. Loop is closed. Pushed.

### Phase 6 — Pattern discovery + Trading DNA · Day 6–7
- Scheduled SQL aggregation across strategy / behavioral / asset / risk / execution cohorts
- Statistical gate (n ≥ 8 + interval excludes baseline) before promotion to `patterns`
- LLM phrasing of gated patterns only; `pattern_evidence` traceability
- Trading DNA page, evidence-tiered throughout
- **Exit:** DNA page reflects real imported history, every claim traceable to rows. Pushed.

### Phase 7 — Agent self-audit · Day 7
- `warning_outcomes` materialization
- Compliance ledger view: shown / heeded / defied, R when heeded vs defied
- Agent surfaces its own ineffective warnings
- **Exit:** the "has this agent helped you?" screen works. This is the differentiator. Pushed.

### Phase 8 — Production readiness · Day 8
- Multi-region survivability config, tenancy audit, least-privilege role verification
- Bedrock-down degradation path tested (rules + retrieval still enforce)
- Observability: retrieval latency, candidate counts, token usage, retrieved ids per intent
- README with architecture diagram, security posture, disclaimer
- **Exit:** PRD §9 is demonstrably true, not aspirational. Pushed.

### Phase 9 — Demo & submission · Day 8–9 (Aug 16–17)
- Deploy to Amplify Hosting, smoke test on the live URL
- Rehearse PRD §11 demo script, record video
- Devpost writeup leading with: memory that gates action · self-auditing agent · honest about `n`
- **Submit Aug 17.** Aug 18 is not a plan, it is a fire escape.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Bedrock model access not enabled on the account | Verify Phase 0, day one — this is the classic 2-day killer |
| Vector index syntax/version mismatch on CockroachDB Cloud | Verify with a real ANN query in Phase 1, not later |
| Price feed rate limits during monitoring | Single endpoint, cron poll, cached; no websockets |
| Retrieval returns vocabulary matches, not situations | Canonical embedding + hybrid prefilter — the Phase 2 exit criterion tests exactly this |
| Scope creep into charting / live monitoring | Explicitly cut in PRD §10; do not reopen |
| Demo data reads as fabricated | Real CSV import is a Phase 1 must-have, not a nice-to-have |
