export const RULE_FIELDS = [
  "risk_pct",
  "minutes_since_last_loss",
  "trades_today",
  "has_stop_loss",
  "size_increase_after_loss",
] as const;

export const RULE_OPERATORS = ["eq", "lt", "lte", "gt", "gte"] as const;
export const ENFORCEMENTS = ["warn", "block"] as const;

export type RuleField = (typeof RULE_FIELDS)[number];
export type RuleOperator = (typeof RULE_OPERATORS)[number];
export type RuleValue = number | boolean;
export type Enforcement = (typeof ENFORCEMENTS)[number];

export interface Predicate {
  readonly field: RuleField;
  readonly op: RuleOperator;
  readonly value: RuleValue;
}

export interface Rule {
  readonly id: string;
  readonly predicate: Predicate;
  readonly enforcement: Enforcement;
}

export interface RuleState {
  risk_pct: number;
  minutes_since_last_loss: number;
  trades_today: number;
  has_stop_loss: boolean;
  size_increase_after_loss: boolean;
}

export type EvaluationDecision = "BLOCK" | "WARN" | "PASS";

export interface RuleEvidence {
  ruleId: string;
  field: RuleField | undefined;
  expected: RuleValue | undefined;
  actual: RuleValue | undefined;
  operator: RuleOperator | undefined;
  enforcement: Enforcement | undefined;
  passed: boolean;
}

export interface EvaluationResult {
  decision: EvaluationDecision;
  evidence: RuleEvidence[];
}

export class RuleCompilationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleCompilationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compileRule(input: unknown): Rule {
  if (!isRecord(input) || !isRecord(input.predicate)) {
    throw new RuleCompilationError("Rule must be an object with a predicate");
  }
  if (typeof input.id !== "string" || input.id.trim().length === 0) {
    throw new RuleCompilationError("Rule ID must be a non-empty string");
  }
  if (!RULE_FIELDS.includes(input.predicate.field as RuleField)) {
    throw new RuleCompilationError(
      `Unsupported rule field: ${JSON.stringify(input.predicate.field)}`,
    );
  }
  if (!RULE_OPERATORS.includes(input.predicate.op as RuleOperator)) {
    throw new RuleCompilationError(
      `Unsupported rule operator: ${JSON.stringify(input.predicate.op)}`,
    );
  }
  if (!ENFORCEMENTS.includes(input.enforcement as Enforcement)) {
    throw new RuleCompilationError(
      `Unsupported rule enforcement: ${JSON.stringify(input.enforcement)}`,
    );
  }

  const field = input.predicate.field as RuleField;
  const operator = input.predicate.op as RuleOperator;
  const value = input.predicate.value;
  const booleanField =
    field === "has_stop_loss" || field === "size_increase_after_loss";

  if (booleanField) {
    if (typeof value !== "boolean" || operator !== "eq") {
      throw new RuleCompilationError(
        `Field ${field} requires a boolean value and the eq operator`,
      );
    }
  } else if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RuleCompilationError(`Field ${field} requires a finite number`);
  }

  const predicate = Object.freeze({
    field,
    op: operator,
    value: value as RuleValue,
  });
  return Object.freeze({
    id: input.id,
    predicate,
    enforcement: input.enforcement as Enforcement,
  });
}

function compare(actual: RuleValue | undefined, operator: RuleOperator, expected: RuleValue): boolean {
  if (operator === "eq") {
    return actual === expected;
  }
  if (typeof actual !== "number" || typeof expected !== "number") {
    return false;
  }

  switch (operator) {
    case "lt":
      return actual < expected;
    case "lte":
      return actual <= expected;
    case "gt":
      return actual > expected;
    case "gte":
      return actual >= expected;
    default:
      return false;
  }
}

interface InspectedRule {
  evidence: RuleEvidence;
  structurallyValid: boolean;
}

function inspectRule(rule: unknown, state: Readonly<Partial<RuleState>>): InspectedRule {
  const raw = isRecord(rule) ? rule : {};
  const predicate = isRecord(raw.predicate) ? raw.predicate : {};
  const ruleId =
    typeof raw.id === "string" && raw.id.trim().length > 0
      ? raw.id
      : "[invalid-rule]";
  const field = RULE_FIELDS.includes(predicate.field as RuleField)
    ? (predicate.field as RuleField)
    : undefined;
  const operator = RULE_OPERATORS.includes(predicate.op as RuleOperator)
    ? (predicate.op as RuleOperator)
    : undefined;
  const enforcement = ENFORCEMENTS.includes(raw.enforcement as Enforcement)
    ? (raw.enforcement as Enforcement)
    : undefined;
  const booleanField =
    field === "has_stop_loss" || field === "size_increase_after_loss";
  const expected =
    (booleanField && typeof predicate.value === "boolean") ||
    (!booleanField &&
      field !== undefined &&
      typeof predicate.value === "number" &&
      Number.isFinite(predicate.value))
      ? (predicate.value as RuleValue)
      : undefined;
  const rawActual = field === undefined ? undefined : state[field];
  const actual =
    (booleanField && typeof rawActual === "boolean") ||
    (!booleanField &&
      field !== undefined &&
      typeof rawActual === "number" &&
      Number.isFinite(rawActual))
      ? rawActual
      : undefined;
  const structurallyValid =
    raw.id === ruleId &&
    field !== undefined &&
    operator !== undefined &&
    enforcement !== undefined &&
    expected !== undefined &&
    actual !== undefined &&
    (!booleanField || operator === "eq");

  return {
    structurallyValid,
    evidence: {
      ruleId,
      field,
      expected,
      actual,
      operator,
      enforcement,
      passed:
        structurallyValid &&
        compare(actual, operator as RuleOperator, expected as RuleValue),
    },
  };
}

export function evaluateRules(
  rules: readonly Rule[],
  state: Readonly<Partial<RuleState>>,
): EvaluationResult {
  const inspected = rules.map((rule) => inspectRule(rule, state));
  const evidence = inspected.map((item) => item.evidence);

  // Invalid rules or state are enforcement-boundary failures. They BLOCK even
  // if untrusted input claims warn enforcement, because WARN permits execution.
  const unsafe = inspected.some((item) => !item.structurallyValid);
  const blockFailed = inspected.some(
    (item) =>
      item.structurallyValid &&
      !item.evidence.passed &&
      item.evidence.enforcement === "block",
  );
  const warnFailed = inspected.some(
    (item) =>
      item.structurallyValid &&
      !item.evidence.passed &&
      item.evidence.enforcement === "warn",
  );

  return {
    decision: unsafe || blockFailed ? "BLOCK" : warnFailed ? "WARN" : "PASS",
    evidence,
  };
}
