import assert from "node:assert/strict";
import test from "node:test";

import {
  BROKER_STUB,
  PAPER_EXECUTION,
  resolveExecutionProvider,
} from "../src/lib/broker";

test("default execution provider is paper and can execute", () => {
  const p = resolveExecutionProvider({});
  assert.equal(p.mode, "paper");
  assert.equal(p.canExecute(), true);
  assert.equal(p.label(), "paper simulator");
});

test("BROKER_ENABLED=true returns broker mode but fails closed (no adapter)", () => {
  const p = resolveExecutionProvider({ BROKER_ENABLED: "true" });
  assert.equal(p.mode, "broker");
  assert.equal(p.canExecute(), false); // real routing must never silently succeed
});

test("a broker flag alone never fabricates a fill", () => {
  assert.equal(BROKER_STUB.canExecute(), false);
  assert.equal(PAPER_EXECUTION.mode, "paper");
});