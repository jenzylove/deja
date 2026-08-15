import assert from "node:assert/strict";
import test from "node:test";

import {
  compileRule,
  evaluateRules,
  RuleCompilationError,
  type Rule,
  type RuleState,
} from "../src/lib/rules";

test("a violated block rule returns BLOCK with structured evidence", () => {
  const rules: Rule[] = [
    {
      id: "max-risk",
      predicate: { field: "risk_pct", op: "lte", value: 2 },
      enforcement: "block",
    },
  ];

  assert.deepEqual(evaluateRules(rules, { risk_pct: 3 }), {
    decision: "BLOCK",
    evidence: [
      {
        ruleId: "max-risk",
        field: "risk_pct",
        expected: 2,
        actual: 3,
        operator: "lte",
        enforcement: "block",
        passed: false,
      },
    ],
  });
});

test("a violated warn rule returns WARN", () => {
  const rules: Rule[] = [
    {
      id: "max-risk-warning",
      predicate: { field: "risk_pct", op: "lte", value: 2 },
      enforcement: "warn",
    },
  ];

  assert.equal(evaluateRules(rules, { risk_pct: 3 }).decision, "WARN");
});

test("all supported fields and operators evaluate deterministically", () => {
  const rules = [
    { id: "risk-lte", predicate: { field: "risk_pct", op: "lte", value: 2 }, enforcement: "block" },
    { id: "loss-gte", predicate: { field: "minutes_since_last_loss", op: "gte", value: 20 }, enforcement: "block" },
    { id: "trades-lt", predicate: { field: "trades_today", op: "lt", value: 3 }, enforcement: "warn" },
    { id: "risk-gt", predicate: { field: "risk_pct", op: "gt", value: 0 }, enforcement: "warn" },
    { id: "has-stop", predicate: { field: "has_stop_loss", op: "eq", value: true }, enforcement: "block" },
    { id: "no-escalation", predicate: { field: "size_increase_after_loss", op: "eq", value: false }, enforcement: "warn" },
  ] as Rule[];

  const result = evaluateRules(rules, {
    risk_pct: 2,
    minutes_since_last_loss: 20,
    trades_today: 2,
    has_stop_loss: true,
    size_increase_after_loss: false,
  });

  assert.equal(result.decision, "PASS");
  assert.equal(result.evidence.length, rules.length);
  assert.ok(result.evidence.every((item) => item.passed));
});

test("rule compilation rejects an unknown field", () => {
  assert.throws(
    () =>
      compileRule({
        id: "invented-field",
        predicate: { field: "account_balance", op: "lte", value: 100 },
        enforcement: "block",
      }),
    (error) =>
      error instanceof RuleCompilationError &&
      error.message === 'Unsupported rule field: "account_balance"',
  );
});

test("rule compilation rejects an unknown operator", () => {
  assert.throws(
    () =>
      compileRule({
        id: "invented-operator",
        predicate: { field: "risk_pct", op: "approximately", value: 2 },
        enforcement: "block",
      }),
    (error) =>
      error instanceof RuleCompilationError &&
      error.message === 'Unsupported rule operator: "approximately"',
  );
});

test("rule compilation rejects malformed IDs, enforcement, and predicate values", () => {
  const invalidRules = [
    { id: "", predicate: { field: "risk_pct", op: "lte", value: 2 }, enforcement: "block" },
    { id: "bad-enforcement", predicate: { field: "risk_pct", op: "lte", value: 2 }, enforcement: "allow" },
    { id: "bad-number", predicate: { field: "risk_pct", op: "lte", value: "2" }, enforcement: "block" },
    { id: "bad-boolean", predicate: { field: "has_stop_loss", op: "eq", value: 1 }, enforcement: "block" },
    { id: "bad-comparison", predicate: { field: "has_stop_loss", op: "gte", value: true }, enforcement: "block" },
  ];

  for (const input of invalidRules) {
    assert.throws(() => compileRule(input), RuleCompilationError);
  }
});

test("rule compilation returns a detached validated rule", () => {
  const input = {
    id: "loss-cooldown",
    predicate: { field: "minutes_since_last_loss", op: "gte", value: 20 },
    enforcement: "warn",
  };

  const compiled = compileRule(input);
  assert.deepEqual(compiled, input);
  assert.notEqual(compiled, input);
  assert.notEqual(compiled.predicate, input.predicate);
});

test("BLOCK takes precedence over WARN and every rule returns evidence", () => {
  const rules: Rule[] = [
    {
      id: "warning",
      predicate: { field: "trades_today", op: "lt", value: 3 },
      enforcement: "warn",
    },
    {
      id: "blocker",
      predicate: { field: "risk_pct", op: "lte", value: 2 },
      enforcement: "block",
    },
    {
      id: "passing",
      predicate: { field: "has_stop_loss", op: "eq", value: true },
      enforcement: "block",
    },
  ];

  const result = evaluateRules(rules, {
    trades_today: 3,
    risk_pct: 3,
    has_stop_loss: true,
  });

  assert.equal(result.decision, "BLOCK");
  assert.deepEqual(
    result.evidence.map(({ ruleId, passed }) => ({ ruleId, passed })),
    [
      { ruleId: "warning", passed: false },
      { ruleId: "blocker", passed: false },
      { ruleId: "passing", passed: true },
    ],
  );
});

test("a missing state value fails closed", () => {
  const rules: Rule[] = [
    {
      id: "missing-risk",
      predicate: { field: "risk_pct", op: "lte", value: 2 },
      enforcement: "block",
    },
  ];

  const result = evaluateRules(rules, {});
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.evidence[0].actual, undefined);
  assert.equal(result.evidence[0].passed, false);
});

test("evaluation fails closed if an uncompiled rule bypasses the type boundary", () => {
  const uncompiled = {
    id: "unsafe",
    predicate: { field: "account_balance", op: "eq", value: 100 },
    enforcement: "block",
  } as unknown as Rule;
  const unsafeState = { account_balance: 100 } as unknown as Partial<RuleState>;

  const result = evaluateRules([uncompiled], unsafeState);
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.evidence[0].passed, false);
});

test("an unsupported warn predicate fails closed to BLOCK", () => {
  const uncompiled = {
    id: "unsafe-warn",
    predicate: { field: "risk_pct", op: "approximately", value: 2 },
    enforcement: "warn",
  } as unknown as Rule;

  const result = evaluateRules([uncompiled], { risk_pct: 2 });
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.evidence[0].passed, false);
});

test("non-finite runtime state fails closed", () => {
  const rule: Rule = {
    id: "finite-risk",
    predicate: { field: "risk_pct", op: "gte", value: 2 },
    enforcement: "block",
  };

  const result = evaluateRules([rule], { risk_pct: Number.POSITIVE_INFINITY });
  assert.equal(result.decision, "BLOCK");
  assert.equal(result.evidence[0].passed, false);
});

test("a malformed runtime rule returns BLOCK evidence instead of throwing", () => {
  const malformed = {
    id: "malformed",
    predicate: null,
    enforcement: "warn",
  } as unknown as Rule;

  const result = evaluateRules([malformed], {});
  assert.equal(result.decision, "BLOCK");
  assert.deepEqual(result.evidence, [
    {
      ruleId: "malformed",
      field: undefined,
      expected: undefined,
      actual: undefined,
      operator: undefined,
      enforcement: "warn",
      passed: false,
    },
  ]);
});

test("compiled rules and predicates are immutable", () => {
  const compiled = compileRule({
    id: "immutable",
    predicate: { field: "risk_pct", op: "lte", value: 2 },
    enforcement: "block",
  });

  assert.equal(Object.isFrozen(compiled), true);
  assert.equal(Object.isFrozen(compiled.predicate), true);
  assert.throws(() => {
    (compiled as unknown as { enforcement: string }).enforcement = "warn";
  }, TypeError);
  assert.equal(compiled.enforcement, "block");
});
