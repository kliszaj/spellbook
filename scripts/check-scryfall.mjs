import assert from "node:assert/strict";
import { test, run } from "./lib/tiny-test.mjs";
import { postCardCollection, ScryfallError, SCRYFALL_COLLECTION_URL, MAX_RETRY_WAIT_MS, resetScryfallBlock } from "../lib/scryfall.js";

function fakeFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[calls.length - 1];
    if (typeof next === "function") return next();
    return next;
  };
  return { fetchImpl, calls };
}

function fakeSleep() {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  return { sleep, waits };
}

const okRes = (body) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body });
const rateLimited = (retryAfter) => ({
  ok: false,
  status: 429,
  headers: { get: (h) => (h === "Retry-After" ? retryAfter : null) },
  json: async () => ({}),
});

test("429 with Retry-After then 200 succeeds after one sleep", async () => {
  resetScryfallBlock();
  const { fetchImpl, calls } = fakeFetch([rateLimited("2"), okRes({ data: [{ id: "a" }], not_found: [] })]);
  const { sleep, waits } = fakeSleep();
  const result = await postCardCollection([{ id: "a" }], { fetchImpl, sleep });
  assert.deepEqual(result, { data: [{ id: "a" }], not_found: [] });
  assert.deepEqual(waits, [2000]);
  assert.equal(calls.length, 2);
});

test("429 twice with default maxRetries rejects with a rate-limiting ScryfallError", async () => {
  resetScryfallBlock();
  const { fetchImpl, calls } = fakeFetch([rateLimited("1"), rateLimited("1")]);
  const { sleep } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep }), (err) => {
    assert.ok(err instanceof ScryfallError);
    assert.match(err.message, /rate-limiting/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test("429 repeated beyond an explicit maxRetries throws ScryfallError", async () => {
  resetScryfallBlock();
  const { fetchImpl, calls } = fakeFetch([rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const { sleep } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep, maxRetries: 2 }), ScryfallError);
  assert.equal(calls.length, 3);
});

test("Retry-After beyond MAX_RETRY_WAIT_MS skips the in-request retry and throws immediately", async () => {
  resetScryfallBlock();
  assert.equal(MAX_RETRY_WAIT_MS, 120_000);
  const { fetchImpl, calls } = fakeFetch([rateLimited("600")]);
  const { sleep, waits } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep }), (err) => {
    assert.ok(err instanceof ScryfallError);
    assert.match(err.message, /rate-limiting/);
    return true;
  });
  assert.equal(calls.length, 1, "a wait beyond the cap must not retry in-request");
  assert.deepEqual(waits, []);
});

test("missing Retry-After header defaults to 60s and still retries in-request", async () => {
  resetScryfallBlock();
  const { fetchImpl, calls } = fakeFetch([rateLimited(undefined), okRes({ data: [], not_found: [] })]);
  const { sleep, waits } = fakeSleep();
  await postCardCollection([{ id: "a" }], { fetchImpl, sleep });
  assert.deepEqual(waits, [60_000]);
  assert.equal(calls.length, 2);
});

// ── blockedUntil cooldown (Minor 3) ─────────────────────────────────────
test("a 429 exhausting retries blocks an immediate next call without hitting fetch; the call goes through once the window passes", async () => {
  resetScryfallBlock();
  let t = 1_000_000;
  const now = () => t;
  const { fetchImpl, calls } = fakeFetch([rateLimited("1"), rateLimited("1")]);
  const { sleep } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep, now }), ScryfallError);
  assert.equal(calls.length, 2);

  // Same instant: the cooldown from that 429 (Retry-After 1s) is still active.
  const { fetchImpl: fetchImpl2, calls: calls2 } = fakeFetch([okRes({ data: [], not_found: [] })]);
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl: fetchImpl2, sleep, now }), (err) => {
    assert.ok(err instanceof ScryfallError);
    assert.match(err.message, /rate-limiting/);
    return true;
  });
  assert.equal(calls2.length, 0, "a blocked call must never reach fetch");

  // Advance past the 1s window: the next call is allowed through to fetch.
  t += 1000;
  const result = await postCardCollection([{ id: "a" }], { fetchImpl: fetchImpl2, sleep, now });
  assert.deepEqual(result, { data: [], not_found: [] });
  assert.equal(calls2.length, 1);
});

test("resetScryfallBlock clears an active cooldown", async () => {
  resetScryfallBlock();
  const t = 1_000_000;
  const now = () => t;
  const { fetchImpl } = fakeFetch([rateLimited("1"), rateLimited("1")]);
  const { sleep } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep, now }), ScryfallError);

  resetScryfallBlock();
  const { fetchImpl: fetchImpl2, calls: calls2 } = fakeFetch([okRes({ data: [], not_found: [] })]);
  const result = await postCardCollection([{ id: "a" }], { fetchImpl: fetchImpl2, sleep, now });
  assert.deepEqual(result, { data: [], not_found: [] });
  assert.equal(calls2.length, 1);
});

test("a network error throws ScryfallError with no retry", async () => {
  resetScryfallBlock();
  const calls = [];
  const fetchImpl = async () => { calls.push(1); throw new Error("network down"); };
  const { sleep, waits } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep }), ScryfallError);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("a non-OK, non-429 status throws ScryfallError with no retry", async () => {
  resetScryfallBlock();
  const { fetchImpl, calls } = fakeFetch([{ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }]);
  const { sleep } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep }), ScryfallError);
  assert.equal(calls.length, 1);
});

test("a 200 response whose body can't be parsed throws ScryfallError", async () => {
  resetScryfallBlock();
  const { fetchImpl, calls } = fakeFetch([
    { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("bad json"); } },
  ]);
  const { sleep } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep }), ScryfallError);
  assert.equal(calls.length, 1);
});

test("request shape: POST, headers, and identifiers body", async () => {
  resetScryfallBlock();
  const { fetchImpl, calls } = fakeFetch([okRes({ data: [], not_found: [] })]);
  await postCardCollection([{ id: "a" }, { name: "Card b" }], { fetchImpl, sleep: fakeSleep().sleep });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, SCRYFALL_COLLECTION_URL);
  assert.equal(init.method, "POST");
  assert.deepEqual(init.headers, {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "Spellbook/0.1",
  });
  assert.deepEqual(JSON.parse(init.body), { identifiers: [{ id: "a" }, { name: "Card b" }] });
});

await run("Scryfall helper");
