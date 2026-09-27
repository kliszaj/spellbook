// Slow check: downloads the real embedding model into data/models on first run.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, run } from "./lib/tiny-test.mjs";
import { cleanRulesText, createLocalEmbedder, dot, profileText } from "../lib/embeddings.js";

const cacheDir = join(fileURLToPath(new URL("..", import.meta.url)), "data", "models");
const embedder = await createLocalEmbedder({ cacheDir });
const sims = async (texts) => { const v = await embedder.embed(texts); return (i, j) => dot(v[i], v[j]); };

test("flicker profiles are closer to each other than to exile removal", async () => {
  const sim = await sims([
    profileText({ summary: "Temporarily exiles one of your creatures and returns it, re-triggering its enters-the-battlefield ability or dodging removal.", mechanics: ["flicker", "protection"], synergies: ["creatures with ETB abilities"] }),
    profileText({ summary: "Blinks your creatures at instant speed to reuse their enter effects and fizzle targeted removal.", mechanics: ["flicker", "etb-value"], synergies: ["ETB creatures"] }),
    profileText({ summary: "Permanently exiles an opponent's creature; efficient single-target removal.", mechanics: ["spot-removal"], synergies: [] }),
  ]);
  assert.ok(sim(0, 1) > sim(0, 2), `flicker~flicker ${sim(0, 1)} vs flicker~removal ${sim(0, 2)}`);
});

test("rules text: Cloudshift is closer to Conjurer's Closet than to Llanowar Elves", async () => {
  const sim = await sims([
    cleanRulesText({ name: "Cloudshift", oracle_text: "Exile target creature you control, then return that card to the battlefield under your control." }),
    cleanRulesText({ name: "Conjurer's Closet", oracle_text: "At the beginning of your end step, you may exile target creature you control, then return that card to the battlefield under your control." }),
    cleanRulesText({ name: "Llanowar Elves", oracle_text: "{T}: Add {G}." }),
  ]);
  assert.ok(sim(0, 1) > sim(0, 2));
});

await run("Embedding model");
