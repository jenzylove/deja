import assert from "node:assert/strict";
import test from "node:test";

import {
  ImportedTradeError,
  isValidImportedTrade,
  sandboxDemoHistory,
  toHistoryOutcome,
} from "../src/lib/imported-trade";

test("sandbox demo history is valid and reproduces the demo pattern (6 BTC longs, 4 losses)", () => {
  const h = sandboxDemoHistory();
  assert.equal(h.length, 6);
  assert.ok(h.every(isValidImportedTrade));
  const losses = h.filter((t) => (t.pnl ?? 0) < 0).length;
  assert.equal(losses, 4);
  assert.ok(h.every((t) => t.asset === "BTC" && t.direction === "long"));
});

test("toHistoryOutcome projects an imported trade into the check shape with R multiple", () => {
  const loss = toHistoryOutcome(sandboxDemoHistory()[0]);
  assert.equal(loss.direction, "long");
  assert.ok(loss.rMultiple < 0, "losing long has negative R");
  const win = toHistoryOutcome(sandboxDemoHistory()[5]);
  assert.ok(win.rMultiple > 0, "winning long has positive R");
});

test("isValidImportedTrade fails closed on malformed rows", () => {
  assert.equal(isValidImportedTrade(null), false);
  assert.equal(isValidImportedTrade({ asset: "BTC" }), false);
  assert.equal(isValidImportedTrade({
    exchange: "x", exchangeOrderId: "1", asset: "BTC", direction: "long",
    entryPrice: -1, exitPrice: null, size: 0, entryAt: "nope",
  }), false);
});

test("ImportedTradeError is a distinct error type", () => {
  assert.ok(new ImportedTradeError("bad") instanceof Error);
});