import assert from "node:assert/strict";
import { test, run } from "./lib/tiny-test.mjs";
import { postCardCollection, ScryfallError, SCRYFALL_COLLECTION_URL, MAX_RETRY_WAIT_MS } from "../lib/scryfall.js";

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
  const { fetchImpl, calls } = fakeFetch([rateLimited("2"), okRes({ data: [{ id: "a" }], not_found: [] })]);
  const { sleep, waits } = fakeSleep();
  const result = await postCardCollection([{ id: "a" }], { fetchImpl, sleep });
  assert.deepEqual(result, { data: [{ id: "a" }], not_found: [] });
  assert.deepEqual(waits, [2000]);
  assert.equal(calls.length, 2);
});

test("429 repeated beyond maxRetries throws ScryfallError", async () => {
  const { fetchImpl, calls } = fakeFetch([rateLimited("1"), rateLimited("1"), rateLimited("1")]);
  const { sleep } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep, maxRetries: 2 }), ScryfallError);
  assert.equal(calls.length, 3);
});

test("Retry-After is capped at MAX_RETRY_WAIT_MS; missing header defaults to 1s", async () => {
  const { fetchImpl: fetchImpl1 } = fakeFetch([rateLimited("60"), okRes({ data: [], not_found: [] })]);
  const { sleep: sleep1, waits: waits1 } = fakeSleep();
  await postCardCollection([{ id: "a" }], { fetchImpl: fetchImpl1, sleep: sleep1 });
  assert.deepEqual(waits1, [MAX_RETRY_WAIT_MS]);

  const { fetchImpl: fetchImpl2 } = fakeFetch([rateLimited(undefined), okRes({ data: [], not_found: [] })]);
  const { sleep: sleep2, waits: waits2 } = fakeSleep();
  await postCardCollection([{ id: "a" }], { fetchImpl: fetchImpl2, sleep: sleep2 });
  assert.deepEqual(waits2, [1000]);
});

test("a network error throws ScryfallError with no retry", async () => {
  const calls = [];
  const fetchImpl = async () => { calls.push(1); throw new Error("network down"); };
  const { sleep, waits } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep }), ScryfallError);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("a non-OK, non-429 status throws ScryfallError with no retry", async () => {
  const { fetchImpl, calls } = fakeFetch([{ ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) }]);
  const { sleep } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep }), ScryfallError);
  assert.equal(calls.length, 1);
});

test("a 200 response whose body can't be parsed throws ScryfallError", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error("bad json"); } },
  ]);
  const { sleep } = fakeSleep();
  await assert.rejects(postCardCollection([{ id: "a" }], { fetchImpl, sleep }), ScryfallError);
  assert.equal(calls.length, 1);
});

test("request shape: POST, headers, and identifiers body", async () => {
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
