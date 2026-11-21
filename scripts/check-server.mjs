// Starts server.js on a free port with a throwaway DATA_DIR and checks the state and input-handling guarantees
// over HTTP. No AI keys are set, so nothing here spends money or calls an AI provider.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, run } from "./lib/tiny-test.mjs";

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function startServer(dataDir) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" };
  const child = spawn(process.execPath, ["server.js"], { cwd: new URL("..", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/settings`); return { base, child, output: () => output, stop: () => child.kill() }; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error(`server didn't start:\n${output}`);
}

const json = (base, path, method = "GET", body) =>
  fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

const deckState = () => ({
  savedCards: [{ id: "a", name: "Sol Ring" }],
  folders: [{ id: "d1", name: "Deck", commanderId: null }],
  membership: { a: ["d1"] },
});

test("a settings save and a deck change at the same moment both survive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spellbook-server-"));
  const srv = await startServer(dir);
  try {
    const writes = [];
    for (let i = 0; i < 10; i++) {
      writes.push(json(srv.base, "/api/settings", "PUT", { playmatUrl: `https://p${i}.example` }));
      writes.push(json(srv.base, "/api/app-state/ops", "POST", { ops: [{ type: "setFolders", folders: [{ id: `f${i}`, name: `Deck ${i}` }] }] }));
    }
    await Promise.all(writes);
    const state = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    assert.ok(state.folders.length >= 1, "the deck change was lost");
    assert.match(state.playmatUrl, /^https:\/\/p\d\.example$/);
  } finally { srv.stop(); }
});

test("an unreadable state.json falls back to the newest backup instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spellbook-server-"));
  await mkdir(join(dir, "backups"));
  await writeFile(join(dir, "backups", "state-2026-01-01.json"), JSON.stringify({ ...deckState(), folders: [{ id: "old", name: "Older" }] }));
  await writeFile(join(dir, "backups", "state-2026-01-02.json"), JSON.stringify(deckState()));
  await writeFile(join(dir, "state.json"), "{ half-written");
  const srv = await startServer(dir);
  try {
    const res = await json(srv.base, "/api/app-state");
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.deepEqual(state.folders.map((f) => f.id), ["d1"]);
    // the broken file is kept for inspection
    assert.equal(await readFile(join(dir, `state.corrupt-${new Date().toISOString().slice(0, 10)}.json`), "utf8"), "{ half-written");
  } finally { srv.stop(); }
});

test("search and deck review survive an unreadable state.json with no backup (no crash)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spellbook-server-"));
  await writeFile(join(dir, "state.json"), "{ broken");
  const srv = await startServer(dir);
  try {
    assert.equal((await json(srv.base, "/api/translate", "POST", { query: "goblins" })).status, 500);
    assert.equal((await json(srv.base, "/api/deck-review", "POST", { cards: [{ name: "Sol Ring" }] })).status, 500);
    assert.equal((await json(srv.base, "/api/settings")).status, 500); // still answering
    assert.equal(srv.child.exitCode, null, `server exited:\n${srv.output()}`);
  } finally { srv.stop(); }
});

test("searches over 1,000 characters are refused before any AI call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spellbook-server-"));
  const srv = await startServer(dir);
  try {
    const res = await json(srv.base, "/api/translate", "POST", { query: "x".repeat(1001) });
    assert.equal(res.status, 413);
    assert.equal((await json(srv.base, "/api/translate", "POST", { query: 42 })).status, 400);
  } finally { srv.stop(); }
});

test("cached searches and history are capped on the server", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spellbook-server-"));
  const srv = await startServer(dir);
  try {
    const translateCache = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`q${i}`, { ts: i, data: {} }]));
    const searchHistory = Array.from({ length: 30 }, (_, i) => ({ q: `q${i}`, ts: 100 - i }));
    await json(srv.base, "/api/app-state/ops", "POST", { ops: [{ type: "setCaches", translateCache, searchHistory }] });
    const state = await (await json(srv.base, "/api/app-state")).json();
    assert.equal(Object.keys(state.translateCache).length, 60);
    assert.ok(state.translateCache.q99 && !state.translateCache.q0, "kept the oldest instead of the newest");
    assert.equal(state.searchHistory.length, 10);
  } finally { srv.stop(); }
});

test("an invalid Playmat address is refused and nothing is saved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spellbook-server-"));
  const srv = await startServer(dir);
  try {
    assert.equal((await json(srv.base, "/api/settings", "PUT", { playmatUrl: "javascript:alert(1)" })).status, 400);
    assert.equal((await (await json(srv.base, "/api/settings")).json()).playmatUrl, "");
    const ok = await (await json(srv.base, "/api/settings", "PUT", { playmatUrl: "10.0.0.240:8443" })).json();
    assert.equal(ok.playmatUrl, "https://10.0.0.240:8443");
  } finally { srv.stop(); }
});

test("the web client script is served joined as /app.js", async () => {
  const dir = await mkdtemp(join(tmpdir(), "spellbook-server-"));
  const srv = await startServer(dir);
  try {
    const res = await fetch(`${srv.base}/app.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /javascript/);
    const body = await res.text();
    assert.match(body, /public\/js\/01-core\.js/);
    assert.match(body, /async function doSearch\(/);
  } finally { srv.stop(); }
});

await run("Server");
