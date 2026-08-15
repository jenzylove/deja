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
Phase 3, deterministic rule DSL and BLOCK/WARN/PASS evaluation.

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
