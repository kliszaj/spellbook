// Paid pilot (spec § Rollout). Without --yes it only prints the plan and estimate.
// Usage: node scripts/pilot-swaps.mjs --csv "C:\path\to\ManaBox_Collection.csv" [--yes]
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCollectionStore, SCRYFALL_BATCH_PAUSE_MS } from "../lib/collection-store.js";
import { postCardCollection } from "../lib/scryfall.js";
import { createProfileStore, oracleIdOf } from "../lib/profiles.js";
import { createEmbeddingStore, createLocalEmbedder } from "../lib/embeddings.js";
import { createRankingCache } from "../lib/swaps.js";
import { collectionOracleCards, createSwapsService } from "../lib/swaps-service.js";
import { createAiClient, priceUsd } from "../lib/ai-client.js";
import { createUsageLog } from "../lib/ai-usage.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const csvPath = args[args.indexOf("--csv") + 1];
const confirmed = args.includes("--yes");
if (!args.includes("--csv") || !csvPath) { console.error("Usage: node scripts/pilot-swaps.mjs --csv <ManaBox CSV> [--yes]"); process.exit(1); }

const pilotDir = join(root, "data", "pilot");
const workDir = join(pilotDir, "work");
await mkdir(workDir, { recursive: true });

// 1. Collection (Scryfall lookups are free).
const collectionStore = createCollectionStore({ dataDir: workDir });
const preview = await collectionStore.preview(await readFile(csvPath, "utf8"));
await collectionStore.apply(preview.previewId, "sync");
const byOid = collectionOracleCards(await collectionStore.loadCards());

// 2. ~60-card sample across archetypes (deterministic: sorted by name).
const text = (c) => `${c.type_line || ""}\n${c.oracle_text || (c.card_faces || []).map((f) => `${f.type_line}\n${f.oracle_text}`).join("\n")}`;
const buckets = [
  ["flicker", (c) => /exile [^.]*(you control|you own)[^.]*return/i.test(text(c))],
  ["exile removal", (c) => /exile target (creature|nonland permanent|permanent|artifact|enchantment)/i.test(text(c)) && !/return/i.test(text(c))],
  ["shrines & spirits", (c) => /\b(Shrine|Spirit)\b/.test(c.type_line || "")],
  ["landfall", (c) => /landfall|whenever a land (you control )?enters/i.test(text(c))],
  ["zombies & aristocrats", (c) => /\bZombie\b/.test(c.type_line || "") || /sacrifice (a|another) creature/i.test(text(c))],
  ["lifegain", (c) => /gains? (\d+|x) life|whenever you gain life/i.test(text(c))],
  ["goodstuff", () => true],
];
const all = [...byOid.values()].filter((e) => e.card.legalities?.commander === "legal" && !/Basic Land/.test(e.card.type_line || "")).sort((a, b) => a.card.name.localeCompare(b.card.name));
const chosen = new Map();
for (const [label, match] of buckets) {
  all.filter((e) => !chosen.has(e.oracleId) && match(e.card)).slice(0, label === "goodstuff" ? 60 - chosen.size : 9).forEach((e) => chosen.set(e.oracleId, { ...e, bucket: label }));
}
const sample = [...chosen.values()];

// 3. AI settings from the app's state (same key/model the app uses).
const appState = JSON.parse(await readFile(join(root, "data", "state.json"), "utf8").catch(() => "{}"));
const apiKey = process.env.ANTHROPIC_API_KEY || appState.apiKey;
const model = process.env.ANTHROPIC_MODEL || appState.anthropicModel || "claude-sonnet-5-5";
const ai = apiKey ? createAiClient({ provider: "anthropic", apiKey, model }) : null;

// 4. Decks: Hei Bai (with primer) + three fixture decks (without a game plan).
async function scryfallByName(names) {
  const out = [];
  for (let i = 0; i < names.length; i += 75) {
    const json = await postCardCollection(names.slice(i, i + 75).map((name) => ({ name })));
    out.push(...(json.data || []));
    await new Promise((r) => setTimeout(r, SCRYFALL_BATCH_PAUSE_MS));
  }
  return out;
}
const heiBai = JSON.parse(await readFile(join(pilotDir, "hei-bai-budget-deck.json"), "utf8"));
const primer = await readFile(join(pilotDir, "hei-bai-primer.md"), "utf8");
const deckSpecs = [{ name: heiBai.name, commander: heiBai.commanders[0], names: heiBai.cards.map((c) => c.name), gamePlan: primer, picks: 4 }];
for (const id of ["landfall", "zombies", "lifegain"]) {
  const f = JSON.parse(await readFile(join(root, "fixtures", "moxfield-snapshots", `${id}.json`), "utf8"));
  const commander = (f.pageTitle.match(/Commander \(([^)]+)\)/) || [])[1];
  deckSpecs.push({ name: f.pageTitle.split(" // ")[0], commander, names: f.cards.map((c) => c.name), gamePlan: "", picks: 2 });
}
const decks = [];
for (const spec of deckSpecs) {
  const cards = await scryfallByName([...new Set([spec.commander, ...spec.names])]);
  const commander = cards.find((c) => c.name === spec.commander || c.name.split(" // ")[0] === spec.commander);
  const eur = (c) => Number(c.prices?.eur || c.prices?.eur_foil || 0);
  const targets = cards.filter((c) => c !== commander && !/\bLand\b/.test(c.type_line || "")).sort((a, b) => eur(b) - eur(a)).slice(0, spec.picks);
  decks.push({
    targets,
    colorIdentity: commander?.color_identity || [],
    deck: {
      name: spec.name,
      commander: commander ? { name: commander.name, typeLine: commander.type_line, text: commander.oracle_text || (commander.card_faces || []).map((f) => f.oracle_text).join("\n") } : null,
      gamePlan: spec.gamePlan, identityTags: [], cardNames: spec.names, signature: `pilot-${spec.name}`,
    },
  });
}

const rankCount = decks.reduce((n, d) => n + d.targets.length, 0);
console.log(`Sample: ${sample.length} cards (${buckets.map(([b]) => `${b}: ${sample.filter((s) => s.bucket === b).length}`).join(", ")})`);
console.log(`Rankings: ${rankCount} (${decks.map((d) => `${d.deck.name}: ${d.targets.map((t) => t.name).join(", ")}`).join(" | ")})`);
const roughUsd = priceUsd(model, { inputTokens: sample.length * 150 + rankCount * 6000, outputTokens: sample.length * 110 + rankCount * 1500 });
console.log(`Model: ${model} · rough pilot cost ≈ $${(roughUsd ?? 0).toFixed(2)}`);
if (!ai) { console.error("No Anthropic API key found (Settings or ANTHROPIC_API_KEY)."); process.exit(1); }
if (!confirmed) { console.log("Dry run. Re-run with --yes to spend."); process.exit(0); }

// 5. Run the real service over the sample only.
const usageLog = createUsageLog({ dataDir: workDir });
const sampleCards = Object.fromEntries(sample.map((s) => [s.card.id, s.card]));
let embedderPromise = null; // load the model once
const service = createSwapsService({
  collectionStore: { load: collectionStore.load, loadCards: async () => sampleCards },
  profileStore: createProfileStore({ dataDir: workDir }),
  embeddingStore: createEmbeddingStore({ dataDir: workDir }),
  rankingCache: createRankingCache({ dataDir: workDir }),
  usageLog,
  getAi: async () => ai,
  getEmbedder: () => (embedderPromise ||= createLocalEmbedder({ cacheDir: join(root, "data", "models") })),
});
await service.prepare();
await service.idle();
const st = await service.status();
if (st.phase !== "ready") { console.error("Prepare did not finish:", st); process.exit(1); }

const lines = [`# Swaps pilot — ${new Date().toISOString()}`, "", `Model: ${model}`, "", "## Profiles", ""];
const profiles = JSON.parse(await readFile(join(workDir, "card-profiles.json"), "utf8")).profiles;
for (const s of sample) {
  const p = profiles[s.oracleId];
  lines.push(`- **${s.card.name}** (${s.bucket}): ${p ? `${p.summary} [${p.mechanics.join(", ")}] — ${p.synergies.join("; ")}` : "_not profiled_"}`);
}
lines.push("", "## Rankings", "");
for (const d of decks) {
  lines.push(`### ${d.deck.name}${d.deck.gamePlan ? " (with Game plan)" : " (no Game plan)"}`, "");
  for (const target of d.targets) {
    const r = await service.swaps({ card: target, colorIdentity: d.colorIdentity, deck: d.deck });
    lines.push(`**${target.name}** (€${target.prices?.eur ?? "?"}) — mode: ${r.body.mode}${r.body.aiError ? `, AI error: ${r.body.aiError}` : ""}`);
    if (!r.body.results?.length) lines.push("- No match found in the sample.");
    for (const x of r.body.results || []) lines.push(`- ${x.match}% ${x.card.name}: ${x.reason}`);
    lines.push("");
  }
}

// 6. Measured cost.
const usage = JSON.parse(await readFile(join(workDir, "ai-usage.json"), "utf8")).entries;
const sum = (feature, key) => usage.filter((e) => e.feature === feature).reduce((n, e) => n + (e[key] || 0), 0);
const profiledCount = sample.filter((s) => profiles[s.oracleId]).length;
const profileRequests = usage.filter((e) => e.feature === "profile").length;
lines.push("## Measured usage", "",
  `- Profiling: ${profileRequests} requests, ${sum("profile", "inputTokens")} input / ${sum("profile", "outputTokens")} output tokens, $${sum("profile", "usd").toFixed(4)}`,
  `- Per profiled card: ${Math.round(sum("profile", "inputTokens") / profiledCount)} input / ${Math.round(sum("profile", "outputTokens") / profiledCount)} output tokens`,
  `- Rankings: ${usage.filter((e) => e.feature === "rank").length} requests, $${sum("rank", "usd").toFixed(4)} (cache reads ${sum("rank", "cacheReadTokens")} tokens)`,
  `- Total: $${usage.reduce((n, e) => n + (e.usd || 0), 0).toFixed(4)}`);
await writeFile(join(pilotDir, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.slice(-6).join("\n"));
console.log(`Report: ${join(pilotDir, "report.md")}`);
