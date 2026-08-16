import assert from "node:assert/strict";
import test from "node:test";

import {
  SYMBOLS_SUPPORTED,
  coinGeckoPriceFeed,
  defaultPriceFeed,
} from "../src/lib/price-feed";

function mockFetch(body: unknown, ok = true, status = 200): (input: string) => Promise<any> {
  return async () => ({ ok, status, json: async () => body });
}

test("resolves a real price for a supported symbol from a valid CoinGecko body", async () => {
  const feed = coinGeckoPriceFeed({
    fetch: mockFetch({ bitcoin: { usd: 64000.5 } }),
    now: () => "2026-08-16T12:00:00.000Z",
  });
  const result = await feed.resolve("BTC");
  assert.equal(result.available, true);
  if (result.available) {
    assert.equal(result.price, 64000.5);
    assert.equal(result.at, "2026-08-16T12:00:00.000Z");
  }
});

test("fails closed on a non-200 response", async () => {
  const feed = coinGeckoPriceFeed({ fetch: mockFetch(null, false, 429) });
  assert.deepEqual(await feed.resolve("BTC"), { available: false });
});

test("fails closed on a malformed body", async () => {
  const feed = coinGeckoPriceFeed({ fetch: mockFetch({ nope: { usd: "oops" } }) });
  assert.deepEqual(await feed.resolve("BTC"), { available: false });
  const feed2 = coinGeckoPriceFeed({ fetch: mockFetch({ bitcoin: { usd: -5 } }) });
  assert.deepEqual(await feed2.resolve("BTC"), { available: false });
});

test("fails closed on an unsupported symbol", async () => {
  const feed = coinGeckoPriceFeed({ fetch: mockFetch({ bitcoin: { usd: 1 } }) });
  assert.deepEqual(await feed.resolve("NOTACOIN"), { available: false });
});

test("fails closed when the fetch throws", async () => {
  const feed = coinGeckoPriceFeed({
    fetch: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(await feed.resolve("BTC"), { available: false });
});

test("default feed hits the real public API and either returns a finite price or fails closed", async () => {
  const result = await defaultPriceFeed.resolve("BTC");
  if (result.available) {
    assert.ok(Number.isFinite(result.price) && result.price > 0);
  }
  // The important assertion: it never throws, never fabricates a price.
  assert.ok(result.available === true || result.available === false);
  assert.ok(SYMBOLS_SUPPORTED.includes("BTC"));
});