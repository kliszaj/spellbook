import { readdir, readFile } from "node:fs/promises";

const fixturePath = new URL("../fixtures/deck-analysis-calibration.json", import.meta.url);
const snapshotDirectory = new URL("../fixtures/moxfield-snapshots/", import.meta.url);
const corpus = JSON.parse(await readFile(fixturePath, "utf8"));
const requiredCoverage = ["Spellslinger", "Landfall", "Control", "Artifacts", "Enchantments", "Lifegain", "Typal: Zombie", "High-power", "Blink", "Voltron"];
const errors = [];

if (!Array.isArray(corpus.fixtures) || corpus.fixtures.length < 10) errors.push("Expected at least ten calibration fixtures.");

const ids = new Set();
const coverage = new Set();
for (const fixture of corpus.fixtures || []) {
  if (!fixture.id || ids.has(fixture.id)) errors.push(`Fixture id must be unique: ${fixture.id || "(missing)"}.`);
  ids.add(fixture.id);
  if (!fixture.source) errors.push(`${fixture.id}: missing source.`);
  if (!Array.isArray(fixture.intendedTags) || !fixture.intendedTags.length) errors.push(`${fixture.id}: missing intendedTags.`);
  if (!Array.isArray(fixture.analysisLenses) || !fixture.analysisLenses.length) errors.push(`${fixture.id}: missing analysisLenses.`);
  if (!Array.isArray(fixture.expectations) || !fixture.expectations.length) errors.push(`${fixture.id}: missing expectations.`);
  for (const tag of fixture.intendedTags || []) coverage.add(tag);
}

for (const tag of requiredCoverage) {
  if (!coverage.has(tag)) errors.push(`Missing required coverage for ${tag}.`);
}

const fixturesById = new Map((corpus.fixtures || []).map((fixture) => [fixture.id, fixture]));
let snapshotCount = 0;
try {
  const filenames = await readdir(snapshotDirectory);
  for (const filename of filenames.filter((name) => name.endsWith(".json"))) {
    const snapshotPath = new URL(filename, snapshotDirectory);
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    const fixture = fixturesById.get(snapshot.fixtureId);
    snapshotCount += 1;
    if (!fixture) errors.push(`${filename}: fixtureId does not exist in the corpus.`);
    if (fixture && snapshot.source !== fixture.source) errors.push(`${filename}: source does not match its fixture.`);
    if (!Array.isArray(snapshot.cards) || snapshot.cards.length < 50) errors.push(`${filename}: expected at least 50 unique cards.`);
    if (!Number.isInteger(snapshot.totalCards) || snapshot.totalCards < 99) errors.push(`${filename}: expected a Commander-sized card total.`);
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Deck-analysis calibration corpus is valid: ${corpus.fixtures.length} fixtures, ${coverage.size} intended tags, ${snapshotCount} snapshots.`);
