import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  closePaperTrade,
  PaperTradeError,
  executePaperTrade,
  type CloseTradeInput,
  type OpenTradeRecord,
  type PaperExecutionStore,
  type TrustedExecutionAuthorization,
  recomputeCohortEvidence,
  createPatternCandidate,
  recomputeWarningAudit,
  refreshPaperMemory,
  type PaperMemoryStore,
  type PatternCandidate,
  validatePatternCandidate,
  captureDescriptorSafeSqlResult,
} from "../src/lib/paper-trade";
import { CockroachPaperStore, type SqlClient } from "../src/lib/paper-store";

const USER = "11111111-1111-4111-8111-111111111111";
const INTENT = "22222222-2222-4222-8222-222222222222";

test("SQL capture accepts the installed node-postgres Result shape without trusting metadata", () => {
  class Result {
    command = "SELECT";
    rowCount = 1;
    oid = null;
    rows = [{ id: INTENT }];
    fields: unknown[] = [];
    _parsers = undefined;
    _types = {};
    RowCtor = null;
    rowAsArray = false;
    _prebuiltEmptyResultObject = null;
  }
  const captured = captureDescriptorSafeSqlResult(new Result(), ["id"], [1]);
  assert.equal(captured.rowCount, 1);
  assert.deepEqual(captured.rows, [{ id: INTENT }]);
});

test("SQL capture rejects a Proxy prototype without invoking its traps or accepting forged rows", () => {
  let trapCalls = 0;
  const prototype = new Proxy({}, {
    getOwnPropertyDescriptor() {
      trapCalls++;
      throw new Error("prototype trap must not execute");
    },
  });
  const result = Object.create(prototype) as { rows: unknown[]; rowCount: number };
  result.rows = [];
  result.rowCount = 0;
  assert.throws(
    () => captureDescriptorSafeSqlResult(result, ["id"], [0]),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
  );
  assert.equal(trapCalls, 0);
  assert.deepEqual(result.rows, []);
  assert.equal(result.rowCount, 0);
});

test("SQL capture rejects a Proxy constructor without reading its name trap", () => {
  let trapCalls = 0;
  const constructor = new Proxy(function Result() {}, {
    get() {
      trapCalls++;
      throw new Error("constructor name trap must not execute");
    },
  });
  const prototype = {};
  Object.defineProperty(prototype, "constructor", { value: constructor, enumerable: false });
  const result = Object.create(prototype) as { rows: unknown[]; rowCount: number };
  result.rows = [];
  result.rowCount = 0;
  assert.throws(
    () => captureDescriptorSafeSqlResult(result, ["id"], [0]),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
  );
  assert.equal(trapCalls, 0);
});

function command(overrides: Record<string, unknown> = {}) {
  return { action: "executed", warningsDefied: [], ...overrides };
}

function authorization(overrides: Record<string, unknown> = {}) {
  return { intentId: INTENT, decision: "PASS", warningsShown: [], ...overrides } as TrustedExecutionAuthorization;
}

function recordingStore(): PaperExecutionStore & { calls: unknown[] } {
  return {
    calls: [],
    async openAtomic(input) {
      this.calls.push(input);
      return { decisionId: "33333333-3333-4333-8333-333333333333", tradeId: "44444444-4444-4444-8444-444444444444", replayed: false };
    },
  };
}

test("exact object boundaries reject symbol keys and custom prototypes before side effects", async () => {
  const extra = Symbol("extra");
  const symbolCommand = command();
  Object.defineProperty(symbolCommand, extra, { value: true, enumerable: true });
  const protoCommand = Object.assign(Object.create({ inherited: true }), command());
  for (const raw of [symbolCommand, protoCommand]) {
    const store = recordingStore();
    await assert.rejects(
      executePaperTrade(raw, { userId: USER }, authorization(), store),
      (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
    );
    assert.equal(store.calls.length, 0);
  }

  for (const rawOutcome of [outcome(1, 1), Object.assign(Object.create({ inherited: true }), outcome(2, 1))]) {
    if (rawOutcome.tradeId === outcome(1, 1).tradeId) Object.defineProperty(rawOutcome, extra, { value: true, enumerable: true });
    assert.throws(
      () => recomputeCohortEvidence({ outcomes: [rawOutcome] }),
      (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
    );
  }

  const validCandidate = createPatternCandidate({
    outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5,
    kind: "strategy", filter: {},
  });
  assert.ok(validCandidate);
  for (const rawCandidate of [
    Object.defineProperty({ ...validCandidate }, extra, { value: true, enumerable: true }),
    Object.assign(Object.create({ inherited: true }), validCandidate),
  ]) assert.throws(
    () => validatePatternCandidate(rawCandidate),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
  );

  for (const rawRequest of [
    Object.defineProperty({ kind: "strategy", filter: {}, baselineRate: 0.5 }, extra, { value: true, enumerable: true }),
    Object.assign(Object.create({ inherited: true }), { kind: "strategy", filter: {}, baselineRate: 0.5 }),
  ]) {
    const store = memoryStore([], []);
    await assert.rejects(
      refreshPaperMemory(rawRequest, { userId: USER }, store),
      (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
    );
    assert.deepEqual(store.users, []);
  }
});

test("trusted authorization rejects a stateful decision accessor without invoking it or reaching the store", async () => {
  let reads = 0;
  const trusted = { intentId: INTENT, warningsShown: [] } as Record<string, unknown>;
  Object.defineProperty(trusted, "decision", {
    enumerable: true,
    get() { reads++; return reads === 1 ? "BLOCK" : "PASS"; },
  });
  const store = recordingStore();
  await assert.rejects(
    executePaperTrade(command(), { userId: USER }, trusted as unknown as TrustedExecutionAuthorization, store),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
  );
  assert.equal(reads, 0);
  assert.equal(store.calls.length, 0);
});

test("non-enumerable properties are rejected at every Phase 6 record boundary before side effects", async () => {
  const hidden = <T extends object>(value: T): T => Object.defineProperty(value, "hidden", { value: true });
  for (const [raw, context, auth] of [
    [hidden(command()), { userId: USER }, authorization()],
    [command(), hidden({ userId: USER }), authorization()],
    [command(), { userId: USER }, hidden(authorization())],
  ] as const) {
    const store = recordingStore();
    await assert.rejects(executePaperTrade(raw, context, auth, store),
      (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
    assert.equal(store.calls.length, 0);
  }
  const closeStore = closureStore(closableTrade());
  await assert.rejects(closePaperTrade(hidden({
    tradeId: "44444444-4444-4444-8444-444444444444", exitFill: 110,
    exitReason: "manual", closedAt: "2026-08-15T11:00:00.000Z",
  }), { userId: USER }, closeStore), (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  assert.equal(closeStore.writes, 0);
  let closeCalls = 0;
  await assert.rejects(closePaperTrade({
    tradeId: "44444444-4444-4444-8444-444444444444", exitFill: 110,
    exitReason: "manual", closedAt: "2026-08-15T11:00:00.000Z",
  }, { userId: USER }, {
    async closeAtomic(input) {
      closeCalls++;
      return input.compute(hidden(closableTrade()));
    },
  }), (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  assert.equal(closeCalls, 1);
  assert.throws(() => recomputeCohortEvidence({ outcomes: [hidden(outcome(1, 1))] }),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  assert.throws(() => recomputeWarningAudit([hidden({
    tradeId: outcome(1, 1).tradeId, code: "EARLY_ENTRY", shown: true, defied: false, rMultiple: 1,
  })]), (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  assert.throws(() => createPatternCandidate({
    outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5,
    kind: "strategy", filter: hidden({}),
  }), (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  const candidate = createPatternCandidate({
    outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5,
    kind: "strategy", filter: {},
  });
  assert.ok(candidate);
  assert.throws(() => validatePatternCandidate(hidden({ ...candidate })),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  const memory = memoryStore([], []);
  await assert.rejects(refreshPaperMemory(hidden({ kind: "strategy", filter: {}, baselineRate: 0.5 }), { userId: USER }, memory),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  assert.deepEqual(memory.users, []);
});

test("recursive boundaries reject accessors without invoking them and reject exotic arrays", async () => {
  let reads = 0;
  const accessor = (value: object, key: string, result: unknown) => Object.defineProperty(value, key, {
    enumerable: true, configurable: true, get() { reads++; return result; },
  });
  const sparse = new Array(1);
  const extra = Object.assign([], { extra: true });
  const symbol = Object.defineProperty([], Symbol("extra"), { value: true, enumerable: true });
  const indexedAccessor: unknown[] = [];
  Object.defineProperty(indexedAccessor, "0", { enumerable: true, get() { reads++; return "EARLY_ENTRY"; } });
  indexedAccessor.length = 1;
  for (const warningsShown of [sparse, extra, symbol, indexedAccessor]) {
    const store = recordingStore();
    await assert.rejects(executePaperTrade(command(), { userId: USER }, authorization({ decision: "WARN", warningsShown }), store),
      (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
    assert.equal(store.calls.length, 0);
  }
  const raw = command();
  accessor(raw, "action", "executed");
  const executionStore = recordingStore();
  await assert.rejects(executePaperTrade(raw, { userId: USER }, authorization(), executionStore),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  assert.equal(executionStore.calls.length, 0);
  const observation = { tradeId: outcome(1, 1).tradeId, code: "EARLY_ENTRY", shown: true, defied: false };
  accessor(observation, "rMultiple", 1);
  assert.throws(() => recomputeWarningAudit([observation]),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  const valid = createPatternCandidate({ outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5, kind: "strategy", filter: {} });
  assert.ok(valid);
  const badSourceIds = [...valid.sourceTradeIds];
  Object.defineProperty(badSourceIds, "extra", { value: true, enumerable: true });
  assert.throws(() => validatePatternCandidate({ ...valid, sourceTradeIds: badSourceIds }),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  const cyclic: { outcomes?: unknown } = {};
  cyclic.outcomes = cyclic;
  assert.throws(() => recomputeCohortEvidence(cyclic),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  assert.equal(reads, 0);
});

test("Proxy get traps cannot change values after one-time boundary capture", async () => {
  let gets = 0;
  const authorizationProxy = new Proxy(authorization(), {
    get(target, key, receiver) {
      gets++;
      if (key === "decision") return gets === 1 ? "BLOCK" : "PASS";
      return Reflect.get(target, key, receiver);
    },
  });
  const store = recordingStore();
  await assert.rejects(executePaperTrade(command(), { userId: USER }, authorizationProxy, store),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  assert.equal(gets, 0);
  assert.equal(store.calls.length, 0);
});

test("trusted BLOCK cannot be overridden by a raw PASS and performs zero store calls", async () => {
  const store = recordingStore();
  await assert.rejects(
    executePaperTrade(command({ decision: "PASS" }), { userId: USER }, authorization({ decision: "BLOCK" }), store),
    (error) => error instanceof PaperTradeError && error.code === "EXECUTION_BLOCKED",
  );
  assert.equal(store.calls.length, 0);
});

test("execution rejects authorization-field and tenant injection before store access", async () => {
  for (const injected of [
    { decision: "PASS" }, { size: 200 }, { intentId: INTENT },
    { warningsShown: [] }, { userId: USER }, { entryFill: 100 },
  ]) {
    const store = recordingStore();
    await assert.rejects(
      executePaperTrade(command(injected), { userId: USER }, authorization(), store),
      (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
    );
    assert.equal(store.calls.length, 0);
  }
});

test("trusted authorization is strict and decision-consistent", async () => {
  for (const trusted of [
    authorization({ decision: "PASS", warningsShown: ["NO_STOP_LOSS"] }),
    authorization({ decision: "WARN", warningsShown: [] }),
    authorization({ extra: true }),
  ]) {
    const store = recordingStore();
    await assert.rejects(
      executePaperTrade(command(), { userId: USER }, trusted, store),
      (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
    );
    assert.equal(store.calls.length, 0);
  }
});

test("execution rejects payload tenant injection and unknown fields before store access", async () => {
  const store = recordingStore();
  await assert.rejects(
    executePaperTrade(command({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }), { userId: USER }, authorization(), store),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST" && error.message === "Paper trade request is invalid.",
  );
  assert.equal(store.calls.length, 0);
});

test("BLOCK performs zero store operations", async () => {
  const store = recordingStore();
  await assert.rejects(
    executePaperTrade(command(), { userId: USER }, authorization({ decision: "BLOCK" }), store),
    (error) => error instanceof PaperTradeError && error.code === "EXECUTION_BLOCKED",
  );
  assert.equal(store.calls.length, 0);
});

test("WARN requires explicit defiance to be a closed-code subset of warnings shown", async () => {
  const store = recordingStore();
  for (const [warningsDefied, code] of [
    [["NO_STOP_LOSS", "EARLY_ENTRY"], "INVALID_WARNING_DEFIANCE"],
    [["NOT_A_WARNING"], "INVALID_REQUEST"],
  ] as const) {
    await assert.rejects(
      executePaperTrade(command({ warningsDefied }), { userId: USER }, authorization({ decision: "WARN", warningsShown: ["NO_STOP_LOSS"] }), store),
      (error) => error instanceof PaperTradeError && error.code === code,
    );
  }
  assert.equal(store.calls.length, 0);
});

test("PASS executes atomically with trusted tenant and no caller-controlled fill", async () => {
  const store = recordingStore();
  const result = await executePaperTrade(command(), { userId: USER }, authorization(), store);
  assert.equal(result.tradeId, "44444444-4444-4444-8444-444444444444");
  assert.deepEqual(store.calls[0], {
    userId: USER,
    intentId: INTENT,
    action: "executed",
    warningsShown: [],
    warningsDefied: [],
  });
});

test("unchanged WARN execution requires the complete shown warning set to be explicitly defied", async () => {
  const store = recordingStore();
  const trusted = authorization({ decision: "WARN", warningsShown: ["NO_STOP_LOSS", "EARLY_ENTRY"] });
  await assert.rejects(
    executePaperTrade(command({ warningsDefied: ["NO_STOP_LOSS"] }), { userId: USER }, trusted, store),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_WARNING_DEFIANCE",
  );
  await executePaperTrade(command({ warningsDefied: ["EARLY_ENTRY", "NO_STOP_LOSS"] }), { userId: USER }, trusted, store);
  assert.equal(store.calls.length, 1);
});

test("modified WARN execution records an explicit mixed defied and heeded disposition", async () => {
  const store = recordingStore();
  await executePaperTrade(
    command({ action: "modified_then_executed", warningsDefied: ["EARLY_ENTRY"] }),
    { userId: USER },
    authorization({ decision: "WARN", warningsShown: ["NO_STOP_LOSS", "EARLY_ENTRY"] }),
    store,
  );
  assert.deepEqual(store.calls[0], {
    userId: USER, intentId: INTENT, action: "modified_then_executed",
    warningsShown: ["NO_STOP_LOSS", "EARLY_ENTRY"], warningsDefied: ["EARLY_ENTRY"],
  });
});

test("malformed execution adapter output is sanitized", async () => {
  let reads = 0;
  const accessorOutput = {
    decisionId: "33333333-3333-4333-8333-333333333333",
    tradeId: "44444444-4444-4444-8444-444444444444",
  } as Record<string, unknown>;
  Object.defineProperty(accessorOutput, "replayed", { enumerable: true, get() { reads++; return false; } });
  const hiddenOutput = Object.defineProperty({
    decisionId: "33333333-3333-4333-8333-333333333333",
    tradeId: "44444444-4444-4444-8444-444444444444", replayed: false,
  }, "hidden", { value: true });
  for (const output of [
    { decisionId: "not-a-uuid", tradeId: "44444444-4444-4444-8444-444444444444", replayed: false },
    { decisionId: "33333333-3333-4333-8333-333333333333", tradeId: "junk", replayed: false },
    { decisionId: "33333333-3333-4333-8333-333333333333", tradeId: "44444444-4444-4444-8444-444444444444", replayed: "false" },
    accessorOutput,
    hiddenOutput,
  ]) {
    const store = { async openAtomic() { return output as never; } };
    await assert.rejects(
      executePaperTrade(command(), { userId: USER }, authorization(), store),
      (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE" && error.message === "Paper trade persistence is unavailable.",
    );
  }
  assert.equal(reads, 0);
});

test("store failures are sanitized", async () => {
  const store: PaperExecutionStore = { async openAtomic() { throw new Error("password=secret db.internal"); } };
  await assert.rejects(
    executePaperTrade(command(), { userId: USER }, authorization(), store),
    (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE" && error.message === "Paper trade persistence is unavailable.",
  );
});

function closableTrade(overrides: Partial<OpenTradeRecord> = {}): OpenTradeRecord {
  return {
    tradeId: "44444444-4444-4444-8444-444444444444", intentId: INTENT, userId: USER,
    direction: "long", entryFill: 100, size: 2, initialStop: 95,
    openedAt: "2026-08-15T10:00:00.000Z", closedAt: null, ...overrides,
  };
}

function closureStore(row: OpenTradeRecord | null) {
  let writes = 0;
  return {
    get writes() { return writes; },
    async closeAtomic(input: CloseTradeInput) {
      if (!row || row.userId !== input.userId) throw new PaperTradeError("TRADE_NOT_FOUND");
      if (row.closedAt !== null) throw new PaperTradeError("TRADE_ALREADY_CLOSED");
      const outcome = input.compute(row);
      writes++;
      return outcome;
    },
  };
}

test("closure computes deterministic long PnL and R and keeps original intent linkage", async () => {
  const store = closureStore(closableTrade());
  const result = await closePaperTrade({ tradeId: "44444444-4444-4444-8444-444444444444", exitFill: 110, exitReason: "target", closedAt: "2026-08-15T11:00:00.000Z" }, { userId: USER }, store);
  assert.deepEqual(result, { tradeId: "44444444-4444-4444-8444-444444444444", intentId: INTENT, pnl: 20, rMultiple: 2, durationS: 3600, exitFill: 110, exitReason: "target" });
  assert.equal(store.writes, 1);
});

test("closure computes deterministic short PnL and R", async () => {
  const store = closureStore(closableTrade({ direction: "short", initialStop: 105 }));
  const result = await closePaperTrade({ tradeId: "44444444-4444-4444-8444-444444444444", exitFill: 90, exitReason: "manual", closedAt: "2026-08-15T10:30:00.000Z" }, { userId: USER }, store);
  assert.equal(result.pnl, 20); assert.equal(result.rMultiple, 2); assert.equal(result.durationS, 1800);
});

test("closure rejects invalid fill and payload tenant injection before store access", async () => {
  const store = closureStore(closableTrade());
  const payloads = [
    { tradeId: "44444444-4444-4444-8444-444444444444", exitFill: Number.NaN, exitReason: "manual", closedAt: "2026-08-15T11:00:00.000Z" },
    { tradeId: "44444444-4444-4444-8444-444444444444", exitFill: 110, exitReason: "manual", closedAt: "2026-08-15T11:00:00.000Z", userId: USER },
  ];
  for (const payload of payloads) await assert.rejects(closePaperTrade(payload, { userId: USER }, store), (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
  assert.equal(store.writes, 0);
});

test("closure fails without partial writes for cross-tenant or missing trades", async () => {
  for (const row of [null, closableTrade({ userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })]) {
    const store = closureStore(row);
    await assert.rejects(closePaperTrade({ tradeId: "44444444-4444-4444-8444-444444444444", exitFill: 110, exitReason: "manual", closedAt: "2026-08-15T11:00:00.000Z" }, { userId: USER }, store), (error) => error instanceof PaperTradeError && error.code === "TRADE_NOT_FOUND");
    assert.equal(store.writes, 0);
  }
});

test("closure rejects missing or zero initial risk without a partial write", async () => {
  for (const initialStop of [null, 100]) {
    const store = closureStore(closableTrade({ initialStop }));
    await assert.rejects(closePaperTrade({ tradeId: "44444444-4444-4444-8444-444444444444", exitFill: 110, exitReason: "manual", closedAt: "2026-08-15T11:00:00.000Z" }, { userId: USER }, store), (error) => error instanceof PaperTradeError && error.code === "INVALID_INITIAL_RISK");
    assert.equal(store.writes, 0);
  }
});

test("close replay is rejected and cannot overwrite the first outcome", async () => {
  const store = closureStore(closableTrade({ closedAt: "2026-08-15T10:30:00.000Z" }));
  await assert.rejects(closePaperTrade({ tradeId: "44444444-4444-4444-8444-444444444444", exitFill: 110, exitReason: "manual", closedAt: "2026-08-15T11:00:00.000Z" }, { userId: USER }, store), (error) => error instanceof PaperTradeError && error.code === "TRADE_ALREADY_CLOSED");
  assert.equal(store.writes, 0);
});

function outcome(index: number, rMultiple: number) {
  const suffix = index.toString(16).padStart(12, "0");
  return {
    tradeId: `50000000-0000-4000-8000-${suffix}`,
    intentId: `60000000-0000-4000-8000-${suffix}`,
    thesisRaw: `Original thesis ${index}`,
    rMultiple,
    asset: "BTC",
    assetClass: "crypto",
    direction: "long" as const,
    strategy: "breakout_retest" as const,
    regime: "trending" as const,
  };
}

test("anecdote evidence suppresses rate and interval and exposes at most three raw episodes", () => {
  const evidence = recomputeCohortEvidence({ outcomes: [outcome(1, 1), outcome(2, -1), outcome(3, 0.5), outcome(4, -0.5)], claimed: { tier: "established", rate: 1 } });
  assert.deepEqual(Object.keys(evidence).sort(), ["episodes", "n", "tier"]);
  assert.equal(evidence.tier, "anecdote");
  assert.equal(evidence.n, 4);
  assert.equal(evidence.episodes.length, 3);
  assert.equal(evidence.episodes[0].thesisRaw, "Original thesis 1");
});

test("signal and established boundaries are recomputed from validated outcomes", () => {
  const signal = recomputeCohortEvidence({ outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, i < 5 ? 1 : -1)), claimed: { tier: "anecdote", rate: 0 } });
  assert.equal(signal.tier, "signal"); assert.equal(signal.n, 8);
  assert.equal("rate" in signal && signal.rate, 5 / 8); assert.equal("interval" in signal, true);
  const established = recomputeCohortEvidence({ outcomes: Array.from({ length: 30 }, (_, i) => outcome(i + 1, i < 18 ? 1 : -1)) });
  assert.equal(established.tier, "established"); assert.equal(established.n, 30);
});

test("malformed closed outcomes are rejected instead of trusting adapter statistics", () => {
  for (const bad of [
    { outcomes: [{ ...outcome(1, 1), rMultiple: Number.NaN }] },
    { outcomes: [{ ...outcome(1, 1), tradeId: "not-uuid" }] },
    { outcomes: [{ tradeId: outcome(1, 1).tradeId, intentId: outcome(1, 1).intentId, thesisRaw: "x" }] },
    { outcomes: [outcome(1, 1), outcome(1, -1)] },
    { outcomes: [outcome(1, 1), { ...outcome(2, -1), intentId: outcome(1, 1).intentId }] },
  ]) assert.throws(() => recomputeCohortEvidence(bad), (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
});

test("pattern candidate requires n eight and Wilson significance against validated baseline", () => {
  const significant = createPatternCandidate({
    outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5,
    kind: "strategy", filter: { strategy: "breakout_retest" },
  });
  assert.equal(significant?.n, 8); assert.equal(significant?.wins, 8); assert.equal(significant?.losses, 0);
  assert.equal(significant?.rate, 1); assert.equal(significant?.effectSize, 0.5); assert.equal(significant?.tier, "signal");
  assert.equal(significant?.sourceTradeIds.length, 8); assert.match(significant?.statement ?? "", /associated/i);
  assert.equal(createPatternCandidate({ outcomes: Array.from({ length: 7 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5, kind: "strategy", filter: {} }), null);
  assert.equal(createPatternCandidate({ outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, i < 4 ? 1 : -1)), baselineRate: 0.5, kind: "strategy", filter: {} }), null);
});

test("pattern candidate applies its validated closed filter before deriving evidence", () => {
  const outcomes = [
    ...Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)),
    ...Array.from({ length: 8 }, (_, i) => ({ ...outcome(i + 9, -1), asset: "ETH", direction: "short" as const })),
  ];
  const candidate = createPatternCandidate({
    outcomes, baselineRate: 0.5, kind: "asset", filter: { asset: "BTC", direction: "long" },
  });
  assert.equal(candidate?.n, 8);
  assert.equal(candidate?.wins, 8);
  assert.deepEqual(candidate?.sourceTradeIds, outcomes.slice(0, 8).map((row) => row.tradeId));
});

test("closed filter rejects lossy, non-finite, undefined, and unknown values without mutating input", () => {
  for (const filter of [
    { riskBand: "high" },
    { asset: undefined },
    { asset: Number.POSITIVE_INFINITY },
    { strategy: { value: "breakout_retest" } },
    { regime: ["trending"] },
    { direction: "LONG" },
    { asset: " btc " },
  ]) {
    const before = Reflect.ownKeys(filter);
    assert.throws(
      () => createPatternCandidate({ outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5, kind: "strategy", filter }),
      (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
    );
    assert.deepEqual(Reflect.ownKeys(filter), before);
  }
  const filter = { strategy: "breakout_retest" };
  const candidate = createPatternCandidate({ outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5, kind: "strategy", filter });
  filter.strategy = "reversal";
  assert.deepEqual(candidate?.filter, { strategy: "breakout_retest" });
});

test("derived averages reject finite inputs whose sums overflow", () => {
  const overflowing = Array.from({ length: 8 }, (_, i) => outcome(i + 1, Number.MAX_VALUE));
  assert.throws(
    () => recomputeCohortEvidence({ outcomes: overflowing }),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
  );
  assert.throws(
    () => recomputeWarningAudit([
      { tradeId: outcome(1, 1).tradeId, code: "EARLY_ENTRY", shown: true, defied: false, rMultiple: Number.MAX_VALUE },
      { tradeId: outcome(2, 1).tradeId, code: "EARLY_ENTRY", shown: true, defied: false, rMultiple: Number.MAX_VALUE },
    ]),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
  );
});

test("warning self-audit recomputes shown, heeded, defied, and branch average R", () => {
  const rows = [
    { tradeId: outcome(1, 1).tradeId, code: "EARLY_ENTRY", shown: true, defied: true, rMultiple: -1 },
    { tradeId: outcome(2, 1).tradeId, code: "EARLY_ENTRY", shown: true, defied: true, rMultiple: -0.5 },
    { tradeId: outcome(3, 1).tradeId, code: "EARLY_ENTRY", shown: true, defied: false, rMultiple: 1.5 },
    { tradeId: outcome(4, 1).tradeId, code: "NO_STOP_LOSS", shown: true, defied: false, rMultiple: -1 },
  ];
  assert.deepEqual(recomputeWarningAudit(rows), [
    { code: "EARLY_ENTRY", timesShown: 3, timesHeeded: 1, timesDefied: 2, rWhenHeeded: 1.5, rWhenDefied: -0.75 },
    { code: "NO_STOP_LOSS", timesShown: 1, timesHeeded: 1, timesDefied: 0, rWhenHeeded: -1, rWhenDefied: null },
  ]);
});

test("warning self-audit rejects malformed observations", () => {
  for (const rows of [
    [{ tradeId: outcome(1, 1).tradeId, code: "UNKNOWN", shown: true, defied: false, rMultiple: 1 }],
    [{ tradeId: outcome(1, 1).tradeId, code: "EARLY_ENTRY", shown: false, defied: true, rMultiple: 1 }],
    [{ tradeId: outcome(1, 1).tradeId, code: "EARLY_ENTRY", shown: true, defied: false, rMultiple: Infinity }],
  ]) assert.throws(() => recomputeWarningAudit(rows), (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST");
});

function memoryStore(outcomes: unknown, observations: unknown): PaperMemoryStore & { persisted: unknown[]; users: string[] } {
  return {
    persisted: [], users: [],
    async loadClosedOutcomes(userId) { this.users.push(userId); return outcomes; },
    async loadWarningObservations(userId) { this.users.push(userId); return observations; },
    async persistMemoryAtomic(userId, candidate, audit) { this.persisted.push({ userId, candidate, audit }); },
  };
}

test("refresh orchestration recomputes from stored tenant outcomes and persists no claimed statistics", async () => {
  const stored = Array.from({ length: 10 }, (_, i) => ({ ...outcome(i + 1, i < 8 ? 1 : -1), asset: i < 8 ? "BTC" : "ETH" }));
  const observations = [{ tradeId: stored[0].tradeId, code: "EARLY_ENTRY", shown: true, defied: true, rMultiple: 1 }];
  const store = memoryStore(stored, observations);
  const result = await refreshPaperMemory(
    { kind: "asset", filter: { asset: "BTC" }, baselineRate: 0.5 },
    { userId: USER },
    store,
  );
  assert.equal(result.candidate?.n, 8);
  assert.equal(result.candidate?.wins, 8);
  assert.equal(result.evidence.n, 8);
  assert.deepEqual(result.candidate?.sourceTradeIds, stored.slice(0, 8).map((row) => row.tradeId));
  assert.deepEqual(result.warningAudit, [{ code: "EARLY_ENTRY", timesShown: 1, timesHeeded: 0, timesDefied: 1, rWhenHeeded: null, rWhenDefied: 1 }]);
  assert.deepEqual(store.users, [USER, USER]);
  assert.equal(store.persisted.length, 1);
});

test("refresh suppresses a candidate below n eight but atomically persists recomputed audit", async () => {
  const store = memoryStore(Array.from({ length: 7 }, (_, i) => outcome(i + 1, 1)), []);
  const result = await refreshPaperMemory({ kind: "strategy", filter: {}, baselineRate: 0.5 }, { userId: USER }, store);
  assert.equal(result.candidate, null);
  assert.deepEqual(store.persisted, [{ userId: USER, candidate: null, audit: [] }]);
});

test("refresh accepts tenant identity only from strict trusted context", async () => {
  for (const request of [
    { kind: "strategy", filter: {}, baselineRate: 0.5, userId: USER },
    { kind: "strategy", filter: {}, baselineRate: 0.5, n: 99 },
    { kind: "strategy", filter: {}, baselineRate: 0.5, sourceTradeIds: [] },
  ]) {
    const store = memoryStore([], []);
    await assert.rejects(
      refreshPaperMemory(request, { userId: USER }, store),
      (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
    );
    assert.deepEqual(store.users, []);
    assert.deepEqual(store.persisted, []);
  }
});

test("refresh blocks malformed stored outcomes and warning rows with sanitized persistence errors", async () => {
  for (const [outcomes, observations] of [
    [[{ ...outcome(1, 1), rMultiple: Infinity }], []],
    [[outcome(1, 1)], [{ tradeId: outcome(1, 1).tradeId, code: "UNKNOWN", shown: true, defied: false, rMultiple: 1 }]],
    [[outcome(1, 1), { ...outcome(2, 1), intentId: outcome(1, 1).intentId }], []],
  ]) {
    const store = memoryStore(outcomes, observations);
    await assert.rejects(
      refreshPaperMemory({ kind: "strategy", filter: {}, baselineRate: 0.5 }, { userId: USER }, store),
      (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE" && error.message === "Paper trade persistence is unavailable.",
    );
    assert.deepEqual(store.persisted, []);
  }
});

test("refresh persistence receives deep-frozen snapshots and cannot corrupt returned memory", async () => {
  const stored = Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1));
  const observations = [
    { tradeId: stored[0].tradeId, code: "EARLY_ENTRY", shown: true, defied: false, rMultiple: 1 },
  ];
  let persistedCandidate: PatternCandidate | null = null;
  let persistedAudit: readonly { timesShown: number }[] = [];
  const store: PaperMemoryStore = {
    async loadClosedOutcomes() { return stored; },
    async loadWarningObservations() { return observations; },
    async persistMemoryAtomic(_userId, candidate, audit) {
      persistedCandidate = candidate;
      persistedAudit = audit;
      try { if (candidate) candidate.rate = Number.POSITIVE_INFINITY; } catch {}
      try { if (candidate) candidate.sourceTradeIds.splice(0); } catch {}
      try { (audit[0] as { timesShown: number }).timesShown = 999; } catch {}
    },
  };
  const result = await refreshPaperMemory(
    { kind: "strategy", filter: {}, baselineRate: 0.5 }, { userId: USER }, store,
  );
  assert.ok(result.candidate);
  assert.equal(result.candidate.rate, 1);
  assert.equal(result.candidate.sourceTradeIds.length, 8);
  assert.equal(result.warningAudit[0].timesShown, 1);
  assert.equal(Number.isFinite(result.candidate.rate), true);
  assert.notEqual(result.candidate, persistedCandidate);
  assert.notEqual(result.warningAudit, persistedAudit);
  const capturedPersistedCandidate = persistedCandidate as unknown as PatternCandidate;
  assert.equal(Object.isFrozen(capturedPersistedCandidate), true);
  assert.equal(Object.isFrozen(capturedPersistedCandidate.sourceTradeIds), true);
  assert.equal(Object.isFrozen(persistedAudit), true);
  assert.equal(Object.isFrozen(persistedAudit[0]), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(Object.isFrozen(result.candidate), true);
  assert.equal(Object.isFrozen(result.warningAudit), true);
});

test("Cockroach open rejects accessor-backed canonical rows without getter reads or derived writes", async () => {
  let reads = 0;
  const statements: string[] = [];
  const canonical = {
    asset: "BTC", direction: "long", size: "2.5", entry: "101.5",
    initial_stop: "95", initial_target: "110", account_id: null,
  };
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(canonical)) {
    Object.defineProperty(row, key, { enumerable: true, get() { reads++; return value; } });
  }
  const client: SqlClient = {
    async query<T>(sql: string) {
      statements.push(sql);
      const rows = sql.includes("UPDATE trade_intents") ? [row] : [];
      return { rows: rows as T[], rowCount: rows.length };
    }, release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await assert.rejects(
    store.openAtomic({ userId: USER, intentId: INTENT, action: "executed", warningsShown: [], warningsDefied: [] }),
    (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE" && error.message === "Paper trade persistence is unavailable.",
  );
  assert.equal(reads, 0);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO decisions")), false);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO trades")), false);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.includes("COMMIT"), false);
});

test("Cockroach open fails closed on Proxy, hidden, symbol, custom-prototype, sparse, and extra SQL row containers", async () => {
  const canonical = [{
    asset: "BTC", direction: "long", size: "2.5", entry: "101.5",
    initial_stop: "95", initial_target: "110", account_id: null,
  }];
  const variants: unknown[] = [
    new Proxy(canonical, {}),
    Object.defineProperty([...canonical], "hidden", { value: true }),
    Object.defineProperty([...canonical], Symbol("extra"), { value: true }),
    Object.setPrototypeOf([...canonical], Object.create(Array.prototype)),
    new Array(1),
    Object.assign([...canonical], { extra: true }),
  ];
  for (const rows of variants) {
    const statements: string[] = [];
    const client: SqlClient = {
      async query<T>(sql: string) {
        statements.push(sql);
        const resultRows = sql.includes("UPDATE trade_intents") ? rows : [];
        return { rows: resultRows as T[], rowCount: 1 };
      }, release() {},
    };
    const store = new CockroachPaperStore({ async connect() { return client; } });
    await assert.rejects(
      store.openAtomic({ userId: USER, intentId: INTENT, action: "executed", warningsShown: [], warningsDefied: [] }),
      (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE",
    );
    assert.equal(statements.some((sql) => sql.includes("INSERT INTO decisions")), false);
    assert.equal(statements.includes("ROLLBACK"), true);
    assert.equal(statements.includes("COMMIT"), false);
  }
});

test("Cockroach close rejects an accessor-backed lock row without getter reads or update", async () => {
  let reads = 0;
  const statements: string[] = [];
  const values = {
    trade_id: "44444444-4444-4444-8444-444444444444", intent_id: INTENT, user_id: USER,
    direction: "long", entry_fill: "100", size: "2", initial_stop: "95",
    opened_at: "2026-08-15T10:00:00.000Z", closed_at: null,
  };
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(row, key, { enumerable: true, get() { reads++; return value; } });
  }
  const client: SqlClient = {
    async query<T>(sql: string) {
      statements.push(sql);
      const rows = sql.includes("FOR UPDATE") ? [row] : [];
      return { rows: rows as T[], rowCount: rows.length };
    }, release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await assert.rejects(store.closeAtomic({
    userId: USER, tradeId: values.trade_id, exitFill: 110, exitReason: "manual",
    closedAt: "2026-08-15T11:00:00.000Z", compute: () => { throw new Error("must not compute"); },
  }), (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE");
  assert.equal(reads, 0);
  assert.equal(statements.some((sql) => sql.includes("UPDATE trades")), false);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.includes("COMMIT"), false);
});

test("pattern lineage rejects accessor-backed SQL fields before inserting a pattern", async () => {
  const candidate = createPatternCandidate({
    outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5,
    kind: "strategy", filter: { strategy: "breakout_retest" },
  });
  assert.ok(candidate);
  let reads = 0;
  const statements: string[] = [];
  const rows = candidate.sourceTradeIds.map((id, index) => {
    const values = {
      id, intent_id: outcome(index + 1, 1).intentId, thesis_raw: outcome(index + 1, 1).thesisRaw,
      r_multiple: "1", asset: "BTC", asset_class: "crypto", direction: "long",
      strategy: "breakout_retest", regime: "trending",
    };
    const row: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(row, key, { enumerable: true, get() { reads++; return value; } });
    }
    return row;
  });
  const client: SqlClient = {
    async query<T>(sql: string) {
      statements.push(sql);
      const resultRows = sql.includes("SELECT t.id") && sql.includes("t.r_multiple") ? rows : [];
      return { rows: resultRows as T[], rowCount: resultRows.length };
    }, release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await assert.rejects(store.appendPattern(USER, candidate),
    (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE");
  assert.equal(reads, 0);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO patterns")), false);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.includes("COMMIT"), false);
});

test("SQL result rows and rowCount accessors are rejected without invocation", async () => {
  for (const accessorKey of ["rows", "rowCount"] as const) {
    let reads = 0;
    const statements: string[] = [];
    const result: Record<string, unknown> = accessorKey === "rows" ? { rowCount: 1 } : { rows: [] };
    Object.defineProperty(result, accessorKey, {
      enumerable: true,
      get() { reads++; return accessorKey === "rows" ? [] : 0; },
    });
    const client: SqlClient = {
      async query<T>(sql: string) {
        statements.push(sql);
        if (sql.includes("UPDATE trade_intents")) return result as unknown as { rows: T[]; rowCount: number };
        return { rows: [] as T[], rowCount: 0 };
      }, release() {},
    };
    const store = new CockroachPaperStore({ async connect() { return client; } });
    await assert.rejects(
      store.openAtomic({ userId: USER, intentId: INTENT, action: "executed", warningsShown: [], warningsDefied: [] }),
      (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE",
    );
    assert.equal(reads, 0);
    assert.equal(statements.some((sql) => sql.includes("INSERT INTO decisions")), false);
    assert.equal(statements.includes("COMMIT"), false);
  }
});

test("pattern lineage rejects exotic SQL row containers before inserting a pattern", async () => {
  const candidate = createPatternCandidate({
    outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5,
    kind: "strategy", filter: { strategy: "breakout_retest" },
  });
  assert.ok(candidate);
  const canonical = candidate.sourceTradeIds.map((id, index) => ({
    id, intent_id: outcome(index + 1, 1).intentId, thesis_raw: outcome(index + 1, 1).thesisRaw,
    r_multiple: "1", asset: "BTC", asset_class: "crypto", direction: "long",
    strategy: "breakout_retest", regime: "trending",
  }));
  const variants: unknown[] = [
    new Proxy(canonical, {}),
    Object.defineProperty([...canonical], "hidden", { value: true }),
    Object.defineProperty([...canonical], Symbol("extra"), { value: true }),
    Object.setPrototypeOf([...canonical], Object.create(Array.prototype)),
    new Array(1),
    Object.assign([...canonical], { extra: true }),
  ];
  for (const rows of variants) {
    const statements: string[] = [];
    const client: SqlClient = {
      async query<T>(sql: string) {
        statements.push(sql);
        const resultRows = sql.includes("SELECT t.id") && sql.includes("t.r_multiple") ? rows : [];
        return { rows: resultRows as T[], rowCount: 0 };
      }, release() {},
    };
    const store = new CockroachPaperStore({ async connect() { return client; } });
    await assert.rejects(store.appendPattern(USER, candidate),
      (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE");
    assert.equal(statements.some((sql) => sql.includes("INSERT INTO patterns")), false);
    assert.equal(statements.includes("ROLLBACK"), true);
    assert.equal(statements.includes("COMMIT"), false);
  }
});

test("Cockroach open is tenant-scoped, transactional, and idempotent for duplicate execution", async () => {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  let pending = true; let decisionInserts = 0; let tradeInserts = 0;
  const client: SqlClient = {
    async query<T>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      let rows: unknown[] = [];
      if (sql.includes("UPDATE trade_intents")) {
        if (pending) {
          pending = false;
          rows = [{ asset: "BTC", direction: "long", size: "2.5", entry: "101.5", initial_stop: "95", initial_target: "110", account_id: null }];
        }
      } else if (sql.includes("INSERT INTO decisions")) {
        decisionInserts++; rows = [{ id: "33333333-3333-4333-8333-333333333333" }];
      } else if (sql.includes("INSERT INTO trades")) {
        tradeInserts++; rows = [{ id: "44444444-4444-4444-8444-444444444444" }];
      } else if (sql.includes("SELECT d.id AS decision_id")) {
        rows = [{ decision_id: "33333333-3333-4333-8333-333333333333", trade_id: "44444444-4444-4444-8444-444444444444" }];
      }
      return { rows: rows as T[], rowCount: rows.length };
    },
    release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  const input = { userId: USER, intentId: INTENT, action: "executed" as const, warningsShown: [], warningsDefied: [] };
  assert.equal((await store.openAtomic(input)).replayed, false);
  assert.equal((await store.openAtomic(input)).replayed, true);
  assert.equal(decisionInserts, 1); assert.equal(tradeInserts, 1);
  const claim = queries.find((query) => query.sql.includes("UPDATE trade_intents"));
  assert.match(claim?.sql ?? "", /RETURNING[\s\S]*size/);
  const tradeInsert = queries.find((query) => query.sql.includes("INSERT INTO trades"));
  assert.equal(tradeInsert?.values[5], "2.5");
  assert.equal(tradeInsert?.values[6], "101.5");
  assert.equal(queries.filter((q) => q.sql === "BEGIN").length, 2);
  assert.equal(queries.filter((q) => q.sql === "COMMIT").length, 2);
  for (const query of queries.filter((q) => /trade_intents|decisions|trades/.test(q.sql))) {
    assert.match(query.sql, /user_id/); assert.equal(query.values[0], USER);
  }
});

test("production cohort and warning joins scope every participating table by user_id", async () => {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const client: SqlClient = { async query(sql, values = []) { queries.push({ sql, values }); return { rows: [], rowCount: 0 }; }, release() {} };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await store.loadClosedOutcomes(USER);
  await store.loadWarningObservations(USER);
  const cohortSql = queries[0].sql;
  assert.match(cohortSql, /t\.user_id = \$1/); assert.match(cohortSql, /i\.user_id = \$1/);
  for (const field of ["i.asset", "i.asset_class", "i.direction", "i.strategy", "i.regime"]) {
    assert.match(cohortSql, new RegExp(field.replace(".", "\\.")));
  }
  const auditSql = queries[1].sql;
  assert.match(auditSql, /SELECT\s+DISTINCT/i);
  assert.match(auditSql, /unnest\(d\.warnings_shown\)/i);
  assert.doesNotMatch(auditSql, /FROM\s+warnings\b/i);
  assert.match(auditSql, /d\.user_id = \$1/); assert.match(auditSql, /t\.user_id = \$1/); assert.match(auditSql, /i\.user_id = \$1/);
  assert.equal(queries.every((query) => query.values[0] === USER), true);
});

test("production closure locks and scopes both trade and intent before any update", async () => {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const client: SqlClient = { async query(sql, values = []) { queries.push({ sql, values }); return { rows: [], rowCount: 0 }; }, release() {} };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await assert.rejects(store.closeAtomic({ userId: USER, tradeId: "44444444-4444-4444-8444-444444444444", exitFill: 110, exitReason: "manual", closedAt: "2026-08-15T11:00:00.000Z", compute: () => { throw new Error("must not compute"); } }), (error) => error instanceof PaperTradeError && error.code === "TRADE_NOT_FOUND");
  const select = queries.find((query) => query.sql.includes("FOR UPDATE"));
  assert.match(select?.sql ?? "", /t\.user_id = \$1/); assert.match(select?.sql ?? "", /i\.user_id = \$1/);
  assert.equal(select?.values[0], USER);
  assert.equal(queries.some((query) => query.sql.includes("UPDATE trades")), false);
});

test("schema enforces one decision and paper trade per tenant intent and tenant-scoped pattern evidence", () => {
  const schema = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");
  assert.match(schema, /UNIQUE \(user_id, intent_id\)/);
  assert.match(schema, /pattern_evidence[\s\S]*user_id\s+UUID NOT NULL/);
  assert.match(schema, /PRIMARY KEY \(user_id, pattern_id, trade_id\)/);
  assert.match(schema, /refresh_key\s+STRING NOT NULL/);
  assert.match(schema, /UNIQUE \(user_id, refresh_key\)/);
});

test("direct pattern append rejects forged empty lineage before SQL connection", async () => {
  let connections = 0;
  const store = new CockroachPaperStore({
    async connect() { connections++; throw new Error("must not connect"); },
  });
  const forged = {
    kind: "strategy", statement: "forged", n: 8, wins: 8, losses: 0, rate: 1,
    interval: { low: 0.6, high: 1 }, effectSize: 0.5, tier: "signal", filter: {}, sourceTradeIds: [],
  } as unknown as PatternCandidate;
  await assert.rejects(
    store.appendPattern(USER, forged),
    (error) => error instanceof PaperTradeError && error.code === "INVALID_REQUEST",
  );
  assert.equal(connections, 0);
});

test("pattern append rolls back when any tenant-scoped lineage row is absent", async () => {
  const statements: string[] = [];
  const client: SqlClient = {
    async query<T>(sql: string) {
      statements.push(sql);
      const rows = sql.includes("INSERT INTO patterns") ? [{ id: "77777777-7777-4777-8777-777777777777" }] : [];
      return { rows: rows as T[], rowCount: rows.length };
    }, release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  const candidate = createPatternCandidate({ outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5, kind: "strategy", filter: {} });
  assert.ok(candidate);
  await assert.rejects(
    store.appendPattern(USER, candidate),
    (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE" && error.message === "Paper trade persistence is unavailable.",
  );
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.includes("COMMIT"), false);
});

test("pattern append rejects source rows that do not reproduce the claimed statistics and filter", async () => {
  const candidate = createPatternCandidate({
    outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5,
    kind: "strategy", filter: { strategy: "breakout_retest" },
  });
  assert.ok(candidate);
  const statements: string[] = [];
  const client: SqlClient = {
    async query<T>(sql: string) {
      statements.push(sql);
      if (sql.includes("SELECT t.id") && sql.includes("t.r_multiple")) {
        return {
          rows: Array.from({ length: 8 }, (_, i) => ({
            id: outcome(i + 1, -1).tradeId,
            intent_id: outcome(i + 1, -1).intentId,
            thesis_raw: outcome(i + 1, -1).thesisRaw,
            r_multiple: "-1", asset: "BTC", asset_class: "crypto", direction: "long",
            strategy: "reversal", regime: "trending",
          })) as T[], rowCount: 8,
        };
      }
      if (sql.includes("INSERT INTO patterns")) {
        return { rows: [{ id: "77777777-7777-4777-8777-777777777777" }] as T[], rowCount: 1 };
      }
      return { rows: [] as T[], rowCount: 0 };
    }, release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await assert.rejects(
    store.appendPattern(USER, candidate),
    (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE",
  );
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO patterns")), false);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.includes("COMMIT"), false);
});

test("pattern append rejects a cherry-picked winning subset of the authoritative matching cohort", async () => {
  const wins = Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1));
  const losses = Array.from({ length: 8 }, (_, i) => outcome(i + 9, -1));
  const candidate = createPatternCandidate({
    outcomes: wins, baselineRate: 0.5, kind: "strategy", filter: { strategy: "breakout_retest" },
  });
  assert.ok(candidate);
  const statements: string[] = [];
  const client: SqlClient = {
    async query<T>(sql: string) {
      statements.push(sql);
      if (sql.includes("SELECT t.id") && sql.includes("t.r_multiple")) {
        const authoritative = sql.includes("ANY($2::UUID[])") ? wins : [...wins, ...losses];
        return {
          rows: authoritative.map((row) => ({
            id: row.tradeId, intent_id: row.intentId, thesis_raw: row.thesisRaw,
            r_multiple: String(row.rMultiple), asset: row.asset, asset_class: row.assetClass,
            direction: row.direction, strategy: row.strategy, regime: row.regime,
          })) as T[], rowCount: 16,
        };
      }
      return { rows: [] as T[], rowCount: 0 };
    }, release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await assert.rejects(
    store.appendPattern(USER, candidate),
    (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE",
  );
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO patterns")), false);
  assert.equal(statements.includes("ROLLBACK"), true);
});

test("pattern append and warning audit upserts carry tenant scope on every write", async () => {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const candidate = createPatternCandidate({ outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5, kind: "strategy", filter: { strategy: "breakout_retest" } });
  if (candidate === null) throw new Error("expected fixture candidate");
  const client: SqlClient = {
    async query<T>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      let rows: unknown[] = [];
      if (sql.includes("SELECT t.id") && sql.includes("t.r_multiple")) {
        rows = candidate.sourceTradeIds.map((id, index) => ({
          id, intent_id: outcome(index + 1, 1).intentId, thesis_raw: outcome(index + 1, 1).thesisRaw,
          r_multiple: "1", asset: "BTC", asset_class: "crypto", direction: "long",
          strategy: "breakout_retest", regime: "trending",
        }));
      } else if (sql.includes("INSERT INTO patterns")) {
        rows = [{ id: "77777777-7777-4777-8777-777777777777" }];
      } else if (sql.includes("SELECT pe.trade_id")) {
        rows = candidate.sourceTradeIds.map((trade_id) => ({ trade_id }));
      }
      const rowCount = sql.includes("INSERT INTO pattern_evidence") ? candidate.n : rows.length;
      return { rows: rows as T[], rowCount };
    }, release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await store.appendPattern(USER, candidate);
  await store.upsertWarningAudit(USER, [{ code: "EARLY_ENTRY", timesShown: 1, timesHeeded: 0, timesDefied: 1, rWhenHeeded: null, rWhenDefied: -1 }]);
  for (const query of queries.filter((q) => /INSERT INTO (patterns|pattern_evidence|warning_outcomes)/.test(q.sql))) {
    assert.match(query.sql, /user_id/); assert.equal(query.values[0], USER);
  }
  assert.doesNotMatch(queries.find((q) => q.sql.includes("INSERT INTO patterns"))?.sql ?? "", /UPDATE patterns/);
});

test("atomic memory refresh removes stale warning aggregates absent from the full recomputation", async () => {
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const client: SqlClient = {
    async query<T>(sql: string, values: readonly unknown[] = []) {
      queries.push({ sql, values });
      return { rows: [] as T[], rowCount: 0 };
    }, release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await store.persistMemoryAtomic(USER, null, [
    { code: "EARLY_ENTRY", timesShown: 1, timesHeeded: 1, timesDefied: 0, rWhenHeeded: 1, rWhenDefied: null },
  ]);
  const cleanupIndex = queries.findIndex((query) => /DELETE FROM warning_outcomes/i.test(query.sql));
  const upsertIndex = queries.findIndex((query) => /INSERT INTO warning_outcomes/i.test(query.sql));
  assert.notEqual(cleanupIndex, -1);
  assert.ok(cleanupIndex < upsertIndex);
  assert.match(queries[cleanupIndex].sql, /user_id = \$1/);
  assert.deepEqual(queries[cleanupIndex].values, [USER, ["EARLY_ENTRY"]]);
  assert.equal(queries.some((query) => query.sql === "COMMIT"), true);
});

test("atomic memory persistence rolls back pattern and lineage when warning audit write fails", async () => {
  const statements: string[] = [];
  const candidate = createPatternCandidate({
    outcomes: Array.from({ length: 8 }, (_, i) => outcome(i + 1, 1)), baselineRate: 0.5,
    kind: "strategy", filter: { strategy: "breakout_retest" },
  });
  assert.ok(candidate);
  const client: SqlClient = {
    async query<T>(sql: string) {
      statements.push(sql);
      if (sql.includes("SELECT t.id") && sql.includes("t.r_multiple")) {
        return { rows: candidate.sourceTradeIds.map((id, index) => ({
          id, intent_id: outcome(index + 1, 1).intentId, thesis_raw: outcome(index + 1, 1).thesisRaw,
          r_multiple: "1", asset: "BTC", asset_class: "crypto", direction: "long",
          strategy: "breakout_retest", regime: "trending",
        })) as T[], rowCount: candidate.n };
      }
      if (sql.includes("INSERT INTO patterns")) {
        return { rows: [{ id: "77777777-7777-4777-8777-777777777777" }] as T[], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO pattern_evidence")) return { rows: [] as T[], rowCount: candidate.n };
      if (sql.includes("SELECT pe.trade_id")) {
        return { rows: candidate.sourceTradeIds.map((trade_id) => ({ trade_id })) as T[], rowCount: candidate.n };
      }
      if (sql.includes("INSERT INTO warning_outcomes")) throw new Error("password=secret db.internal");
      return { rows: [] as T[], rowCount: 0 };
    },
    release() {},
  };
  const store = new CockroachPaperStore({ async connect() { return client; } });
  await assert.rejects(
    store.persistMemoryAtomic(USER, candidate, [{ code: "EARLY_ENTRY", timesShown: 1, timesHeeded: 0, timesDefied: 1, rWhenHeeded: null, rWhenDefied: 1 }]),
    (error) => error instanceof PaperTradeError && error.code === "PERSISTENCE_UNAVAILABLE",
  );
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO patterns")), true);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO pattern_evidence")), true);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO warning_outcomes")), true);
  assert.equal(statements.includes("ROLLBACK"), true);
  assert.equal(statements.includes("COMMIT"), false);
});
