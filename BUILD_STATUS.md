# Deja Build Status

## Baseline
- Repository: `jenzylove/deja`
- Branch: `main`
- Baseline commit: `475c873`
- Baseline production build: passed on 2026-08-15
- Baseline lint: zero errors, two existing unused-variable warnings
- Live CockroachDB/Bedrock verification: blocked locally because `.env.local` is absent
- Product UI: default Next.js starter

## Active gate
Phase 5 interface: responsive paper-trade intent form, grounded decision workspace, and honest fixture/degraded/unavailable states. The browser must not choose tenant identity and no unauthenticated service route may be introduced.

## Evidence log

### RED — first BLOCK behavior before production code
Command: `npm run test:rules`

```text
> deja@0.1.0 test:rules
> tsx --test test/rules.test.ts

TAP version 13
# node:internal/modules/cjs/loader:1430
#   const err = new Error(message);
#               ^
# Error: Cannot find module '../src/lib/rules'
# Require stack:
# - /root/deja/test/rules.test.ts
#     at node:internal/modules/cjs/loader:1430:15
#     at nextResolveSimple (/root/deja/node_modules/tsx/dist/register-C557imBs.cjs:10:1006)
#     at /root/deja/node_modules/tsx/dist/register-C557imBs.cjs:9:4959
#     at /root/deja/node_modules/tsx/dist/register-C557imBs.cjs:9:4261
#     at resolveTsPaths (/root/deja/node_modules/tsx/dist/register-C557imBs.cjs:10:759)
#     at /root/deja/node_modules/tsx/dist/register-C557imBs.cjs:10:1199
#     at j._resolveFilename (file:///root/deja/node_modules/tsx/dist/register-C4vWVmug.mjs:2:17957)
#     at defaultResolveImpl (node:internal/modules/cjs/loader:1040:19)
#     at defaultResolve (node:internal/modules/cjs/loader:1075:31)
#     at nextStep (node:internal/modules/customization_hooks:189:26) {
#   code: 'MODULE_NOT_FOUND',
#   requireStack: [ '/root/deja/test/rules.test.ts' ]
# }
# Node.js v22.23.1
# Subtest: test/rules.test.ts
not ok 1 - test/rules.test.ts
  ---
  duration_ms: 489.635024
  type: 'test'
  location: '/root/deja/test/rules.test.ts:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 517.770659
```

Expected failure: the test could not import `src/lib/rules.ts` because the deterministic rule engine did not exist yet.

### GREEN — targeted BLOCK behavior
Command: `npx tsx --test --test-name-pattern="violated block" test/rules.test.ts`

```text
TAP version 13
# Subtest: a violated block rule returns BLOCK with structured evidence
ok 1 - a violated block rule returns BLOCK with structured evidence
  ---
  duration_ms: 2.460602
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 295.850109
```

### GREEN — full deterministic rule suite
Command: `npm run test:rules`

```text
> deja@0.1.0 test:rules
> tsx --test test/rules.test.ts

TAP version 13
# Subtest: a violated block rule returns BLOCK with structured evidence
ok 1 - a violated block rule returns BLOCK with structured evidence
  ---
  duration_ms: 2.762984
  type: 'test'
  ...
# Subtest: a violated warn rule returns WARN
ok 2 - a violated warn rule returns WARN
  ---
  duration_ms: 0.355626
  type: 'test'
  ...
# Subtest: all supported fields and operators evaluate deterministically
ok 3 - all supported fields and operators evaluate deterministically
  ---
  duration_ms: 0.431933
  type: 'test'
  ...
# Subtest: rule compilation rejects an unknown field
ok 4 - rule compilation rejects an unknown field
  ---
  duration_ms: 0.816217
  type: 'test'
  ...
# Subtest: rule compilation rejects an unknown operator
ok 5 - rule compilation rejects an unknown operator
  ---
  duration_ms: 0.335582
  type: 'test'
  ...
# Subtest: rule compilation rejects malformed IDs, enforcement, and predicate values
ok 6 - rule compilation rejects malformed IDs, enforcement, and predicate values
  ---
  duration_ms: 0.476011
  type: 'test'
  ...
# Subtest: rule compilation returns a detached validated rule
ok 7 - rule compilation returns a detached validated rule
  ---
  duration_ms: 0.322517
  type: 'test'
  ...
# Subtest: BLOCK takes precedence over WARN and every rule returns evidence
ok 8 - BLOCK takes precedence over WARN and every rule returns evidence
  ---
  duration_ms: 0.524933
  type: 'test'
  ...
# Subtest: a missing state value fails closed
ok 9 - a missing state value fails closed
  ---
  duration_ms: 0.717083
  type: 'test'
  ...
1..9
# tests 9
# suites 0
# pass 9
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 311.948314
```

### GREEN — lint
Command: `npm run lint`

```text
> deja@0.1.0 lint
> eslint


/root/deja/scripts/check-memory.ts
  80:11  warning  'labelOk' is assigned a value but never used  @typescript-eslint/no-unused-vars

/root/deja/src/lib/retrieval.ts
  134:9  warning  'pool' is assigned a value but never used  @typescript-eslint/no-unused-vars

✖ 2 problems (0 errors, 2 warnings)
```

The two warnings are the unchanged baseline warnings.

### GREEN — production build
Command: `npm run build`

```text
> deja@0.1.0 build
> next build

▲ Next.js 16.3.0 (Turbopack)
✓ Running next.config.ts took 102ms

  Creating an optimized production build ...
✓ Compiled successfully in 3.8s
  Running TypeScript ...
  Finished TypeScript in 6.5s ...
  Collecting page data using 1 worker ...
  Generating static pages using 1 worker (0/4) ...
  Generating static pages using 1 worker (1/4)
  Generating static pages using 1 worker (2/4)
  Generating static pages using 1 worker (3/4)
✓ Generating static pages using 1 worker (4/4) in 314ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
└ ○ /_not-found


○  (Static)  prerendered as static content
```

### RED — runtime fail-closed boundary
Command: `npx tsx --test --test-name-pattern="uncompiled rule" test/rules.test.ts`

```text
TAP version 13
# Subtest: evaluation fails closed if an uncompiled rule bypasses the type boundary
not ok 1 - evaluation fails closed if an uncompiled rule bypasses the type boundary
  ---
  duration_ms: 3.890247
  type: 'test'
  location: '/root/deja/test/rules.test.ts:178:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    'PASS' !== 'BLOCK'

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 'BLOCK'
  actual: 'PASS'
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/root/deja/test/rules.test.ts:187:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.start (node:internal/test_runner/test:944:17)
    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 492.755566
```

Expected failure: an uncompiled unknown field could read an extra state property and incorrectly PASS. Runtime enum checks were then added so bypasses also fail closed.

### Final GREEN — complete rule suite
Command: `npm run test:rules`

```text
> deja@0.1.0 test:rules
> tsx --test test/rules.test.ts

TAP version 13
# Subtest: a violated block rule returns BLOCK with structured evidence
ok 1 - a violated block rule returns BLOCK with structured evidence
  ---
  duration_ms: 4.441631
  type: 'test'
  ...
# Subtest: a violated warn rule returns WARN
ok 2 - a violated warn rule returns WARN
  ---
  duration_ms: 0.343593
  type: 'test'
  ...
# Subtest: all supported fields and operators evaluate deterministically
ok 3 - all supported fields and operators evaluate deterministically
  ---
  duration_ms: 0.461723
  type: 'test'
  ...
# Subtest: rule compilation rejects an unknown field
ok 4 - rule compilation rejects an unknown field
  ---
  duration_ms: 1.014596
  type: 'test'
  ...
# Subtest: rule compilation rejects an unknown operator
ok 5 - rule compilation rejects an unknown operator
  ---
  duration_ms: 0.458336
  type: 'test'
  ...
# Subtest: rule compilation rejects malformed IDs, enforcement, and predicate values
ok 6 - rule compilation rejects malformed IDs, enforcement, and predicate values
  ---
  duration_ms: 0.429925
  type: 'test'
  ...
# Subtest: rule compilation returns a detached validated rule
ok 7 - rule compilation returns a detached validated rule
  ---
  duration_ms: 0.411117
  type: 'test'
  ...
# Subtest: BLOCK takes precedence over WARN and every rule returns evidence
ok 8 - BLOCK takes precedence over WARN and every rule returns evidence
  ---
  duration_ms: 0.459567
  type: 'test'
  ...
# Subtest: a missing state value fails closed
ok 9 - a missing state value fails closed
  ---
  duration_ms: 0.493719
  type: 'test'
  ...
# Subtest: evaluation fails closed if an uncompiled rule bypasses the type boundary
ok 10 - evaluation fails closed if an uncompiled rule bypasses the type boundary
  ---
  duration_ms: 0.586979
  type: 'test'
  ...
1..10
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 359.255029
```

Final lint remained at 0 errors with the same two baseline warnings. Final production build passed after the runtime fail-closed change.

### Independent review failure and adversarial RED

The first frozen diff was rejected because unsupported warn predicates could permit execution, non-finite runtime state could pass numeric rules, malformed predicates could throw, and compiled rules remained mutable.

Command: `npm run test:rules`

```text
# tests 14
# pass 10
# fail 4
```

Expected failures reproduced all four findings:

- unsupported warn predicate: `WARN !== BLOCK`
- non-finite runtime state: `PASS !== BLOCK`
- null predicate: `TypeError` before evidence
- compiled rule: `Object.isFrozen(...)` was false

### Final GREEN — repaired fail-closed boundary

Command: `npm run test:rules`

```text
# tests 14
# pass 14
# fail 0
# duration_ms 489.514912
```

The evaluator now treats malformed rules or state as unsafe and returns BLOCK regardless of untrusted warn enforcement, returns structured evidence instead of throwing, rejects non-finite runtime values, and freezes compiled rules and predicates.

## Phase 4 service-layer tracer bullet

Phase 4 baseline: `530e318d883cb02e48476781448dc9315168d2f2`.

### RED — service tracer bullet before production code

Command: `npx tsx --test --test-name-pattern="tracer bullet" test/intent-service.test.ts`

```text
TAP version 13
# node:internal/modules/cjs/loader:1430
#   const err = new Error(message);
#               ^
# Error: Cannot find module '../src/lib/intent-service'
# Require stack:
# - /root/deja/test/intent-service.test.ts
#     at node:internal/modules/cjs/loader:1430:15
#     at nextResolveSimple (/root/deja/node_modules/tsx/dist/register-C557imBs.cjs:10:1006)
#     at /root/deja/node_modules/tsx/dist/register-C557imBs.cjs:9:4959
#     at /root/deja/node_modules/tsx/dist/register-C557imBs.cjs:9:4261
#     at resolveTsPaths (/root/deja/node_modules/tsx/dist/register-C557imBs.cjs:10:759)
#     at /root/deja/node_modules/tsx/dist/register-C557imBs.cjs:10:1199
#     at j._resolveFilename (file:///root/deja/node_modules/tsx/dist/register-C4vWVmug.mjs:2:17957)
#     at defaultResolveImpl (node:internal/modules/cjs/loader:1040:19)
#     at defaultResolve (node:internal/modules/cjs/loader:1075:31)
#     at nextStep (node:internal/modules/customization_hooks:189:26) {
#   code: 'MODULE_NOT_FOUND',
#   requireStack: [ '/root/deja/test/intent-service.test.ts' ]
# }
# Node.js v22.23.1
# Subtest: test/intent-service.test.ts
not ok 1 - test/intent-service.test.ts
  ---
  duration_ms: 432.182435
  type: 'test'
  location: '/root/deja/test/intent-service.test.ts:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 447.751103
```

Expected failure: the service module did not exist, so the test could not traverse validation, canonicalization, retrieval, tenant rule loading, rule evaluation, and evidence-safe output.

### Additional vertical-slice RED evidence

Each failure was observed before its corresponding minimum production change.

```text
Command: npx tsx --test --test-name-pattern="unknown intent fields" test/intent-service.test.ts
not ok 1 - validation rejects unknown intent fields before any adapter call
error: The validation function is expected to return "true". Received false
Caught error: Error: must not run
# tests 1
# pass 0
# fail 1
# duration_ms 831.032869

Command: npx tsx --test --test-name-pattern="canonicalization failure" test/intent-service.test.ts
not ok 1 - canonicalization failure still evaluates blocking rules without inventing evidence
error: Bedrock unavailable
# tests 1
# pass 0
# fail 1
# duration_ms 813.620726

Command: npx tsx --test --test-name-pattern="three most similar" test/intent-service.test.ts
not ok 1 - anecdote output exposes only the three most similar raw episodes
error: 4 !== 3
# tests 1
# pass 0
# fail 1
# duration_ms 1075.663107

Command: npx tsx --test --test-name-pattern="production rule loader" test/intent-service.test.ts
not ok 1 - production rule loader uses the tenant ID and active deterministic query
error: '(0 , import_intent_service.loadActiveRulesForUser) is not a function'
# tests 1
# pass 0
# fail 1
# duration_ms 841.39436

Command: npx tsx --test --test-name-pattern="non-UUID" test/intent-service.test.ts
not ok 1 - validation rejects a non-UUID tenant identifier before adapters run
error: Missing expected rejection.
# tests 1
# pass 0
# fail 1
# duration_ms 848.421404
```

### GREEN — targeted Phase 4 service suite

Command: `npm run test:intent`

```text
> deja@0.1.0 test:intent
> tsx --test test/intent-service.test.ts

TAP version 13
# Subtest: tracer bullet evaluates tenant rules and returns anecdote-safe grounded evidence
ok 1 - tracer bullet evaluates tenant rules and returns anecdote-safe grounded evidence
  ---
  duration_ms: 5.431222
  type: 'test'
  ...
# Subtest: validation rejects unknown intent fields before any adapter call
ok 2 - validation rejects unknown intent fields before any adapter call
  ---
  duration_ms: 1.399812
  type: 'test'
  ...
# Subtest: canonicalization failure still evaluates blocking rules without inventing evidence
ok 3 - canonicalization failure still evaluates blocking rules without inventing evidence
  ---
  duration_ms: 0.917111
  type: 'test'
  ...
# Subtest: anecdote output exposes only the three most similar raw episodes
ok 4 - anecdote output exposes only the three most similar raw episodes
  ---
  duration_ms: 1.016296
  type: 'test'
  ...
# Subtest: production rule loader uses the tenant ID and active deterministic query
ok 5 - production rule loader uses the tenant ID and active deterministic query
  ---
  duration_ms: 0.821357
  type: 'test'
  ...
# Subtest: validation rejects a non-UUID tenant identifier before adapters run
ok 6 - validation rejects a non-UUID tenant identifier before adapters run
  ---
  duration_ms: 0.507897
  type: 'test'
  ...
# Subtest: retrieval failure preserves deterministic rule enforcement
ok 7 - retrieval failure preserves deterministic rule enforcement
  ---
  duration_ms: 0.804152
  type: 'test'
  ...
# Subtest: unavailable tenant rules fail closed before retrieval
ok 8 - unavailable tenant rules fail closed before retrieval
  ---
  duration_ms: 0.601906
  type: 'test'
  ...
# Subtest: intent and retrieved behaviour populate every supported rule field
ok 9 - intent and retrieved behaviour populate every supported rule field
  ---
  duration_ms: 1.348852
  type: 'test'
  ...
# Subtest: signal-tier cohort includes its rate and interval
ok 10 - signal-tier cohort includes its rate and interval
  ---
  duration_ms: 1.273438
  type: 'test'
  ...
1..10
# tests 10
# suites 0
# pass 10
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 953.798737
```

All adapter responses in this test are explicitly labelled deterministic test fixtures, not live provider evidence.

### Final GREEN — complete available test suite

Command: `npm test`

```text
> deja@0.1.0 test
> tsx --test test/*.test.ts

1..24
# tests 24
# suites 0
# pass 24
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1159.656269
```

### Final GREEN — lint

Command: `npm run lint`

```text
> deja@0.1.0 lint
> eslint

/root/deja/scripts/check-memory.ts
  80:11  warning  'labelOk' is assigned a value but never used  @typescript-eslint/no-unused-vars

/root/deja/src/lib/retrieval.ts
  134:9  warning  'pool' is assigned a value but never used  @typescript-eslint/no-unused-vars

✖ 2 problems (0 errors, 2 warnings)
```

The two warnings are unchanged baseline warnings; Phase 4 adds no lint warning or error.

### Final GREEN — production build

Command: `npm run build`

```text
> deja@0.1.0 build
> next build

▲ Next.js 16.3.0 (Turbopack)
✓ Running next.config.ts took 81ms
  Creating an optimized production build ...
✓ Compiled successfully in 926ms
  Running TypeScript ...
  Finished TypeScript in 6.6s ...
  Collecting page data using 1 worker ...
✓ Generating static pages using 1 worker (4/4) in 396ms
  Finalizing page optimization ...

Route (app)
┌ ○ /
└ ○ /_not-found

○  (Static)  prerendered as static content
```

### Final GREEN — production dependency audit

Command: `npm audit --omit=dev`

```text
found 0 vulnerabilities
```

Live CockroachDB and Bedrock verification was not attempted: `.env.local` is absent and this gate prohibits credential reads, cloud calls, and external side effects.

### Independent review FAIL and repair evidence

The first Phase 4 diff was rejected after adversarial probes reproduced five release blockers: caller-selected tenant IDs, Bedrock starting before rules were available, canonicalization failure returning PASS without memory evidence, low-sample percentage leakage from an untrusted tier, and raw provider error leakage.

Each repair was added test-first. The service now separates authenticated tenant context from the closed trade payload, loads and compiles rules before provider work, uses a tenant-scoped SQL-only fallback when canonicalization fails, derives evidence tier and intervals from validated counts, and returns fixed public stage messages.

A final additional RED exposed a sixth unsafe branch:

```text
# tests 15
# pass 14
# fail 1
retrieval failure without active rules: PASS !== BLOCK
```

The retrieval-failure branch was changed to preserve rule evidence while always blocking execution when memory evidence is unavailable.

Final targeted GREEN:

```text
# tests 15
# pass 15
# fail 0
```

The targeted suite also directly verifies that SQL fallback uses the authenticated tenant ID in all six queries and contains no embedding, vector, or `<=>` operation.

### Second independent review FAIL and repair evidence

The second frozen review reproduced three additional blockers: normal retrieval could return PASS with zero episodes, malformed cohort counts escaped as an exception, and the vector query joined trades without independently constraining `trades.user_id`.

Adversarial RED:

```text
# tests 18
# pass 15
# fail 3
empty normal retrieval: complete/PASS instead of degraded/BLOCK
malformed cohort: unhandled Invalid retrieval cohort
vector SQL: tenant-scoped join builder absent
```

Repairs moved evidence validation inside the structured retrieval error boundary, force empty evidence to BLOCK, and constrain both `trade_intents.user_id` and `trades.user_id` in the ANN join.

Targeted GREEN:

```text
# tests 18
# pass 18
# fail 0
```

## Phase 5 interface gate

Phase 5 baseline: `7f62493d55eec6d39a508198976c25af9cab3d87`.

### RED - interface view model before production code

Command: `npx tsx --test test/intent-ui.test.ts`

```text
Error: Cannot find module '../src/lib/intent-ui'
# tests 1
# pass 0
# fail 1
```

Expected failure: the pure interface contract for closed field options, validation, honest workspace states, and fixture-labelled evidence did not exist.

### GREEN - targeted interface suite

Command: `npm run test:ui`

```text
# tests 7
# pass 7
# fail 0
```

The UI contract now verifies service-compatible enums, inline validation, distinct empty/loading/unavailable/degraded states, anecdote-safe fixture evidence, repeated fixture labels, rule evidence, filter-widening disclosure, and semantic win/loss outcome tones.

### GREEN - Phase 5 verification

```text
npm test             39 passed, 0 failed
npx tsc --noEmit     passed
npm run lint         0 errors, 1 existing warning in scripts/check-memory.ts
npm run build        passed, static / route generated
npm audit --omit=dev found 0 vulnerabilities
git diff --check     passed
```

Production-browser verification used local production Next.js servers at `127.0.0.1:3100` and `127.0.0.1:3000`. At the 1280px browser viewport, the form, inline error path, empty workspace, fail-closed unavailable result, and opted-in example result rendered without horizontal overflow or clipped controls. The example view visibly repeated fixture labels, distinguished WARN and PASS evidence, stated `n=3` without a percentage, disclosed filter widening, and offered the provider-unavailable fixture state. The CSS has explicit single-column fallbacks at 1060px and 720px, system dark tokens, visible focus treatment, and a reduced-motion override. Browser tooling did not expose viewport emulation, so the mobile fallback was verified from the responsive CSS and build rather than claimed as a device screenshot.

Visual QA found one misleading style: a losing `-1.0R` example used the same accent color as positive outcomes. A regression test failed with `getOutcomeTone is not a function`, then passed after adding deterministic positive, negative, and neutral tone mapping and semantic CSS classes. That repair rerun passed 6/6 UI tests and 38/38 full tests.

### Independent UI review FAIL and contract repair

The frozen UI review reproduced two release blockers. The form omitted five fields required by `validateTradeIntent`, imposed a stricter thesis rule than the service, and briefly claimed to check service availability despite performing no check.

Adversarial RED:

```text
npm run test:ui       7 tests, 5 passed, 2 failed
UI-valid draft rejected by the existing service contract
brief thesis rejected by UI but accepted by validateTradeIntent
```

The repair adds position size, entry, optional stop loss, optional take profit, and post-loss sizing to the draft and rendered form. `toTradeIntentInput` converts that draft to the exact service payload, and the test passes the converted payload through `validateTradeIntent`. Asset and asset class are no longer artificially closed to three crypto choices. UI validation now mirrors service semantics, including accepting any non-empty thesis. The fake loading state and animation-frame transition were removed. Valid submission goes directly to the honest unavailable BLOCK state.

Repair GREEN:

```text
npm run test:ui       7 passed, 0 failed
npm test              39 passed, 0 failed
npx tsc --noEmit      passed
npm run lint          0 errors, 1 existing warning
npm run build         passed
npm audit --omit=dev  0 vulnerabilities
git diff --check      passed
```

Production-browser verification at `127.0.0.1:3000` confirmed the contract-complete form renders without clipping or horizontal overflow. The service-valid thesis `brief` transitioned directly to unavailable with no loading copy, no field errors, and zero `/api/` resources.

No API route, tenant input, live provider request, credential access, paper execution, deployment, commit, or push was added or performed.

## Phase 6 gate - paper execution and closure-to-memory

Baseline: `2089fb5`

Scope is limited to a trusted-server domain and persistence seam for paper execution, deterministic closure, outcome memory, evidence-tier recomputation, statistically gated pattern candidates, and warning compliance self-audit. Every query and mutation must be tenant-scoped. BLOCK must perform no persistence. WARN execution must record shown versus explicitly defied warnings. Statistics are recomputed from validated stored outcomes and anecdote cohorts cannot expose percentages. No API route, browser integration, fake price feed, timer, provider call, live database access, credential use, scheduled job, deployment, or cloud change is authorized.

### Phase 6 RED evidence

Each vertical behavior was exercised before its production implementation:

```text
npx tsx --test test/paper-trade.test.ts
Error: Cannot find module '../src/lib/paper-trade'
# tests 1, pass 0, fail 1

npx tsx --test --test-name-pattern="closure|close replay" test/paper-trade.test.ts
TypeError: closePaperTrade is not a function
# tests 6, pass 0, fail 6

npx tsx --test --test-name-pattern="evidence|boundaries|outcomes|pattern candidate|self-audit" test/paper-trade.test.ts
TypeError: recomputeCohortEvidence/createPatternCandidate/recomputeWarningAudit is not a function
# tests 6, pass 0, fail 6

npx tsx --test --test-name-pattern="Cockroach|production cohort" test/paper-trade.test.ts
Error: Cannot find module '../src/lib/paper-store'
# tests 1, pass 0, fail 1

npx tsx --test --test-name-pattern="schema enforces|pattern append" test/paper-trade.test.ts
missing UNIQUE (user_id, intent_id); store.appendPattern is not a function
# tests 2, pass 0, fail 2
```

These were expected feature-absence failures, not live provider or database results.

### Phase 6 GREEN evidence

```text
npm run test:paper   23 passed, 0 failed
npm test             62 passed, 0 failed
npx tsc --noEmit     passed
npm run lint         0 errors, 1 unchanged warning in scripts/check-memory.ts
npm run build        passed; static / and /_not-found routes generated
npm audit --omit=dev found 0 vulnerabilities
git diff --check     passed
secret-pattern scan  0 matches in Phase 6/status/schema/package files
```

The deterministic fixture suite covers tenant injection and unknown fields before persistence, BLOCK zero calls, warning subset/enum checks, atomic duplicate open, missing/cross-tenant/replayed closure, long/short PnL and R, zero risk, low-n suppression and three raw episodes, signal/established boundaries, Wilson significance gating, malformed outcomes/statistics, self-audit branch averages/nulls, append-only pattern writes, sanitized persistence errors, schema replay protection, and tenant scope on every participating join/write/upsert.

No live CockroachDB/provider verification was attempted or claimed. The CockroachDB adapter was exercised only through injected deterministic SQL clients; applying and validating the changed schema against a real cluster remains a later authorized integration step.

### Phase 6 adversarial security repair

Parent review found that the first implementation accepted the decision and size from the execution command, sourced self-audit rows from the warning table rather than the recorded decision, silently accepted missing pattern lineage, and could overflow derived averages. Focused RED tests reproduced each issue before repair. The boundary now receives decision authorization separately from the closed untrusted command, rejects authorization and size injection, and takes size only from the tenant-scoped claimed intent. Adapter result IDs are runtime-validated. Self-audit unnests `decisions.warnings_shown`. Missing tenant lineage rolls back the pattern transaction. Derived statistics reject non-finite results.

The final focused RED required one warning observation per trade and code:

```text
npm run test:paper
# tests 29
# pass 28
# fail 1
production cohort and warning joins scope every participating table by user_id
Expected warning-audit SQL to match SELECT DISTINCT
```

After adding SQL-boundary deduplication, the complete repaired gate passed:

```text
npm run test:paper             29 passed, 0 failed
npm test                       68 passed, 0 failed
npx tsc --noEmit --incremental false  passed
npm run lint                   0 errors, 1 unchanged warning
npm run build                  passed; static routes generated
npm audit --omit=dev           0 vulnerabilities
git diff --check               passed
```

No API route, UI integration, live database/provider call, credential access, scheduled job, deployment, commit, or push was performed in this gate.

### Independent Phase 6 review and second repair

Independent read-only review `deleg_da53217a` returned **FAIL** on the frozen 29-test candidate. It reproduced three release blockers: unchanged WARN execution could be counted as heeded, direct pattern persistence accepted empty or incomplete lineage, and lossy/unbound filters allowed derived memory that could not be reproduced from its stored predicate.

Focused RED tests were added before each repair. They now enforce complete explicit defiance for unchanged WARN execution, allow mixed disposition only for `modified_then_executed`, reject duplicate intent outcomes, apply a closed canonical filter before deriving statistics and lineage, validate direct persistence inputs before connecting, and route tenant-stored outcomes plus warning observations through one atomic memory-refresh seam with retry identity.

A final compile RED caught a duplicate test fixture declaration:

```text
npm run test:paper
Transform failed: test/paper-trade.test.ts:565:8
The symbol "candidate" has already been declared
# tests 1, pass 0, fail 1
```

After that repair, parent review added two more trust-boundary RED assertions. The untrusted execution command still controlled `entryFill`, allowing evaluated risk to drift, and refresh evidence described all outcomes rather than the requested filtered cohort. The RED run produced 29 passes and 9 failures, including missing rejection of `entryFill`, valid command shape failures, filtered evidence `10 !== 8`, and absent canonical entry in the trade insert.

The final implementation removes fill from the untrusted command, takes both size and paper entry from the tenant-scoped claimed intent, and returns evidence derived from the same validated filter used for the pattern candidate.

```text
npm run test:paper                    38 passed, 0 failed
npm test                              77 passed, 0 failed
npx tsc --noEmit --incremental false passed
npm run lint                          0 errors, 1 unchanged warning
npm run build                         passed; static routes generated
npm audit --omit=dev                  0 vulnerabilities
git diff --check                      passed
```

No live CockroachDB, provider, API, UI paper execution, credential, timer, random feed, deployment, commit, or push was used or performed. Existing databases would require an authorized migration because fresh-schema edits do not alter an already provisioned cluster.

### Second Phase 6 FAIL review and third repair

The second independent FAIL report reproduced three remaining blockers: mathematically valid pattern claims could commit against authoritative rows with different outcomes/filter fields, symbol-keyed and custom-prototype values bypassed exact object boundaries, and full warning-audit refreshes left obsolete materialized codes in place.

Strict vertical RED runs reproduced each blocker before production changes:

```text
pattern source-coherence RED: INSERT INTO patterns was reached (true !== false)
exact-boundary RED: symbol-keyed execution command reached the store (missing expected rejection)
stale-audit RED: no DELETE FROM warning_outcomes was issued (-1)
```

The repair now reloads every source trade's authoritative outcome and cohort fields inside the pattern transaction and independently reproduces the candidate before insertion. Exact object boundaries reject symbol keys and non-plain prototypes. Full warning-audit persistence tenant-scopes a stale-code cleanup before upserting the recomputed rows in the same transaction.

```text
npm run test:paper                    41 passed, 0 failed
npm test                              80 passed, 0 failed
npx tsc --noEmit --incremental false passed
npm run lint                          0 errors, 1 unchanged warning
npm run build                         passed; static routes generated
npm audit --omit=dev                  0 vulnerabilities
git diff --check                      passed
```

No live database/provider call, API/UI addition, dependency change, credential access, deployment, commit, or push was performed.

Parent adversarial review then identified a remaining subset attack: direct persistence could verify all caller-supplied source rows while ignoring additional tenant outcomes that matched the same filter. A RED fixture modeled eight selected wins plus eight omitted matching losses. The existing `ANY(source_ids)` query reached `INSERT INTO patterns`, failing the no-insert assertion.

The transaction-time verifier now loads the full tenant-owned closed outcome set, applies the validated filter through the same domain derivation, and requires exact candidate statistics and exact source-set equality before any pattern insert.

```text
npm run test:paper                    42 passed, 0 failed
npm test                              81 passed, 0 failed
npx tsc --noEmit --incremental false passed
npm run lint                          0 errors, 1 unchanged warning
npm run build                         passed; static routes generated
npm audit --omit=dev                  0 vulnerabilities
git diff --check                      passed
```

No live database/provider call, API/UI change, credential access, deployment, commit, or push was performed.

### Third independent Phase 6 FAIL and fourth security repair

The third independent FAIL found that descriptor-unsafe validation could read a trusted authorization getter more than once, allowing a value that was BLOCK during validation to become PASS before persistence. It also found that non-enumerable properties were invisible to `Object.keys`, and that nested arrays and adapter outputs were not uniformly protected from sparse, accessor, symbol, extra-property, custom-prototype, or Proxy inputs.

The focused RED run captured all four adversarial groups failing before production repair:

```text
npx tsx --test --test-name-pattern='stateful decision accessor|non-enumerable properties|recursive boundaries|Proxy get traps' test/paper-trade.test.ts
# tests 4
# pass 0
# fail 4
stateful decision accessor: getter invoked 3 times (3 !== 0)
non-enumerable properties: missing expected rejection
recursive boundaries: malformed array reached warning-defiance validation
Proxy get trap: missing expected rejection
```

A second adapter-output RED proved that accessor output was initially surfaced as `INVALID_REQUEST` instead of a sanitized persistence failure:

```text
npx tsx --test --test-name-pattern='malformed execution adapter output' test/paper-trade.test.ts
# tests 1
# pass 0
# fail 1
caught PaperTradeError: Paper trade request is invalid
```

The repair introduces recursive immutable plain-data snapshots built only from own property descriptors. Records must use `Object.prototype` or a null prototype and contain only enumerable own string data properties. Arrays must be ordinary, dense, and contain exactly `length` plus canonical own enumerable data indices. Accessors, symbols, hidden properties, extra array keys, custom prototypes, Proxies, and cycles fail closed without invoking getters. Domain validation and every subsequent read operate on the detached snapshot. This is applied to tenant/auth/execution, close request and store row/outcome, evidence outcomes/filter/candidates, warning observations/audit rows, refresh requests and stored adapter outputs. Existing exact-key and finite-number checks remain in force; malformed public adapter results are sanitized as persistence failures.

Final verification:

```text
npm run test:paper                         46 passed, 0 failed
npm test                                   85 passed, 0 failed
npx tsc --noEmit --incremental false       passed
npm run lint                               0 errors, 1 unchanged warning in scripts/check-memory.ts
npm run build                              passed; static / and /_not-found routes generated
npm audit --audit-level=high               exit 0; 4 moderate dev-tool vulnerabilities reported, high threshold clear
npm audit --omit=dev                       found 0 vulnerabilities
git diff --check                           passed
```

No live database/provider/API/UI call, credential access, dependency change, deployment, commit, or push was performed.

### Fourth independent Phase 6 FAIL and fifth security repair

The fourth independent frozen-diff review returned **FAIL** because Cockroach adapter results were still read through `result.rows`, row objects, and `rowCount` without a descriptor-safe capture. Accessor-backed or Proxy/exotic adapter values could therefore execute getters or influence derived inserts/updates before rollback. The review also found that `refreshPaperMemory` passed the same mutable candidate and warning-audit objects to persistence and then returned them, allowing a stateful store to rewrite returned evidence aliases (`rate = Infinity`, empty lineage, and `timesShown = 999`).

The focused RED run reproduced the trust gaps before production repair:

```text
npx tsx --test --test-name-pattern='refresh persistence receives|Cockroach open rejects accessor|Cockroach open fails closed|Cockroach close rejects an accessor|pattern lineage rejects accessor' test/paper-trade.test.ts
# tests 5
# pass 0
# fail 5
refresh aliasing: Infinity !== 1
open canonical row: accessor values were consumed and a derived insert path was reached
open exotic rows: malformed adapter output surfaced after derived work
close lock row: accessor values reached compute instead of failing closed
pattern full cohort: 80 getter reads (80 !== 0)
```

The repair exports `captureDescriptorSafeSqlResult`, which snapshots each consumed SQL result once from own data-property descriptors, rejects accessor/Proxy/hidden/symbol/custom-prototype/sparse/extra containers, validates exact result and row shapes plus safe `rowCount`, and exposes only detached frozen rows. Every Cockroach result boundary used for a read or derived write now passes through that capture: intent claim/replay, decision and trade IDs, close lock/update, closed outcomes, warning observations, authoritative full-cohort rows, inserted pattern IDs, and persisted lineage. Boundary-specific primitive, UUID, decimal, date, row-count, tenant, and row-length checks run before derived writes. Malformed adapter output remains sanitized as `PERSISTENCE_UNAVAILABLE`; transactional paths roll back and do not commit.

Refresh persistence now receives independently captured deep-frozen candidate and audit snapshots. The returned evidence/candidate/audit is a separate deep-frozen capture, so attempted persistence mutation cannot alter finite rates, lineage, counts, or returned aliases. Earlier accessor BLOCK, hidden-field, full-cohort cherry-pick, and stale-warning cleanup regressions remain covered.

Final verification:

```text
npm run test:paper                         53 passed, 0 failed
npm test                                   92 passed, 0 failed
npx tsc --noEmit --incremental false       passed
npm run lint                               0 errors, 1 unchanged warning in scripts/check-memory.ts
npm run build                              passed; static / and /_not-found routes generated
npm audit --audit-level=high               exit 0; 4 moderate dev-tool vulnerabilities reported, high threshold clear
npm audit --omit=dev                       found 0 vulnerabilities
git diff --check                           passed
```

No live database/provider/API/UI call, credential access, dependency change, deployment, commit, or push was performed.

Parent compatibility review then found that the initial descriptor-safe SQL wrapper expected a plain two-field object. The installed `pg` driver returns a custom `Result` instance with own metadata fields such as `command`, `oid`, `fields`, and parser state, so every real Cockroach result would have failed closed before row validation.

A RED test using that installed node-postgres result shape failed with `INVALID_REQUEST`. The capture now recognizes only plain/null containers or a `Result` prototype, requires every own key to be an enumerable data descriptor from the closed node-postgres metadata set, and captures only own `rows` and `rowCount` descriptor values. Row arrays and row objects still pass through recursive descriptor-safe cloning, while unknown, hidden, symbolic, accessor, Proxy, sparse, and custom row inputs remain blocked.

```text
npm run test:paper                         54 passed, 0 failed
npm test                                   93 passed, 0 failed
npx tsc --noEmit --incremental false       passed
npm run lint                               0 errors, 1 unchanged warning in scripts/check-memory.ts
npm run build                              passed; static / and /_not-found routes generated
npm audit --audit-level=high               exit 0; 4 moderate dev-tool vulnerabilities reported, high threshold clear
npm audit --omit=dev                       found 0 vulnerabilities
git diff --check                           passed
```

No live CockroachDB query, provider/API/UI call, credential access, dependency change, deployment, commit, or push was performed.

### Fifth independent Phase 6 FAIL and prototype-trap repair

The fifth frozen-diff review returned **FAIL** because a normal SQL result object could inherit from a Proxy prototype. Inspecting that prototype's `constructor` descriptor invoked its trap before the result's own `rows` and `rowCount` were captured, allowing the trap to replace empty rows with forged data.

The focused RED reproduced the issue: the Proxy prototype trap executed and surfaced its sentinel error instead of `INVALID_REQUEST`. Capture now rejects Proxy prototypes before any descriptor inspection. Parent review also closed the adjacent path where a prototype's own constructor value is itself a Proxy function, replacing direct `.name` access with Proxy rejection and an own data-descriptor read of the function name. Regression tests prove both trap counts stay zero and the original result rows remain unchanged.

```text
npm run test:paper                         56 passed, 0 failed
npm test                                   95 passed, 0 failed
npx tsc --noEmit --incremental false       passed
npm run lint                               0 errors, 1 unchanged warning in scripts/check-memory.ts
npm run build                              passed; static / and /_not-found routes generated
npm audit --audit-level=high               exit 0; 4 moderate dev-tool vulnerabilities reported, high threshold clear
npm audit --omit=dev                       found 0 vulnerabilities
git diff --check                           passed
```

No live CockroachDB query, provider/API/UI call, credential access, dependency change, deployment, commit, or push was performed.
