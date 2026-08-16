# Deja Builder Contract

## Product outcome

Deja is a paper-trading decision-memory app. A trader states an intent, receives a memory-grounded brief and deterministic BLOCK/WARN/PASS decision, executes a paper trade when permitted, closes it, and sees the outcome change future decisions. The product also exposes evidence-tiered Trading DNA and a warning-compliance ledger.

Preserve the locked product scope in `docs/PRD.md`. Use `docs/ROADMAP.md` as the delivery sequence, but repository truth and the end-to-end acceptance flow below override stale phase labels.

## Workspace and Git

- Work only inside this repository. Do not edit another project.
- `main` is the authoritative released source branch.
- Build each coherent slice on a feature branch, then merge only after verification.
- The main agent owns commit, push, pull request, and merge operations unless explicitly delegated.
- Never force-push or discard uncommitted work.

## Definition of done

The app is complete only when a user can execute this real flow through the browser:

```text
submit trade intent
→ canonicalize and retrieve the user's stored history
→ receive a grounded brief with evidence and deterministic rule results
→ BLOCK, WARN, or PASS
→ record the user's decision and warning disposition
→ execute an allowed paper trade
→ monitor or manually close it
→ persist fills, outcome, R multiple, and behavioral events
→ recompute derived memory and warning outcomes
→ observe that memory in the next decision
→ inspect Trading DNA and the warning-compliance ledger
```

A static fixture, visual prototype, isolated domain library, passing unit suite, merged backend slice, successful build, or deployment command is partial evidence. None of them means the app is done.

Every success state presented as live must come from the real application path. Fixtures are allowed only in tests or screens explicitly labeled as examples, and they must never masquerade as user history or provider output.

## Current state and active sequence

The repository contains tested domain services for rules, retrieval, paper execution, closure-to-memory, evidence tiers, patterns, and warning self-audit. The current browser still uses static example data and has no application API routes.

Build the remaining product in this order:

1. Wire one authenticated, tenant-bound browser intent through a server route into the existing decision services and render the real result.
2. Wire allowed paper execution, decision recording, trade state, manual closure, and refreshed memory.
3. Add monitoring/settlement and automatic behavioral event capture.
4. Build Trading DNA and warning-compliance views from stored outcomes with traceable evidence.
5. Exercise empty, degraded, unauthorized, duplicate, concurrent, retry, and recovery states.
6. Complete production readiness, migration, observability, documentation, and one final release review.
7. Deploy the exact reviewed commit only after explicit authorization, then verify the live end-to-end flow.

Keep exactly one load-bearing slice active. Do not reopen product ideation or insert repeated audit rounds between ordinary implementation slices.

## Trust and correctness invariants

1. Browser input never selects or overrides `user_id`, account ownership, stored entry, stored size, fills, outcomes, evidence lineage, or audit counts.
2. Trusted server authentication binds every operation to one tenant. Missing or ambiguous identity fails closed.
3. A failed `block` rule produces BLOCK and causes zero execution writes. A failed `warn` rule produces WARN unless a block also fails. Executing under WARN records exactly which shown warnings were defied.
4. Rule evaluation is deterministic TypeScript with no LLM, network, database, clock, or environment dependency. Supported fields and operators are closed enums.
5. Every rendered statistic includes `n` and follows the PRD evidence tier. Low-evidence cohorts show episodes rather than unsupported percentages.
6. Pattern and warning claims are derived from complete tenant-scoped stored cohorts, use finite validated values, and preserve exact source-row lineage.
7. Decision, execution, closure, memory refresh, pattern evidence, and warning outcomes remain transactionally coherent and tenant scoped.
8. Provider and persistence outputs are untrusted. Validate them before use, fail closed on malformed data, and return sanitized public errors.
9. No fabricated CockroachDB, Bedrock, price-feed, user-history, deployment, or production evidence.

## Development discipline

1. Use vertical test-driven slices. Add one failing behavior test, run it and confirm the intended RED, implement the minimum safe behavior, then run targeted and affected full checks.
2. Prefer real application seams over mock-only orchestration tests. Add adapter-level tests for production boundaries.
3. Run targeted tests, the full affected suite, TypeScript, lint, production build, dependency audit, diff check, and secret scan before release.
4. Use one independent review for a frozen security-sensitive or release-bound slice. Re-review only when that review reproduces a concrete blocker and the bytes change. Do not spend credits on recurring speculative reviews.
5. Record exact RED/GREEN and release evidence in `BUILD_STATUS.md`. Keep status claims tied to real commands, commits, URLs, or external handles.
6. Push small coherent verified commits when requested. A push is not a deployment.

## External boundaries

Local implementation, tests, API/UI wiring, migrations, and documentation should continue autonomously.

Stop and ask only when the next action requires:

- reading or changing credentials or secret values;
- provisioning or modifying paid/cloud resources;
- running a migration against a live or shared database;
- invoking paid providers without an approved budget;
- deploying publicly;
- destructive or irreversible external actions.

Never expose secret values in logs, tests, commits, screenshots, or chat.

## Commands

- Install: `npm ci`
- Targeted domain tests: `npm run test:paper`
- Full tests: `npm test`
- TypeScript: `npx tsc --noEmit --incremental false`
- Lint: `npm run lint`
- Production build: `npm run build`
- Production dependency audit: `npm audit --omit=dev`

## Release completion

A local release candidate passes only when the full browser journey is wired to real server services, all required non-live acceptance flows pass, fixtures are absent from the success path, tests and static gates pass, one frozen-diff review finds no blocker, the exact commit is pushed, and local and remote SHAs match.

Production completion additionally requires an authorized database/provider configuration, migration, deployment, and live smoke test of the complete user journey. Report local completion and production completion separately.
