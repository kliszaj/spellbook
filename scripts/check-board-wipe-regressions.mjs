import { readFile } from "node:fs/promises";

const pagePath = new URL("../public/index.html", import.meta.url);
const html = await readFile(pagePath, "utf8");
const errors = [];

function expressionFor(constant) {
  const match = html.match(new RegExp(`const ${constant} = (\\/.*?\\/)\\.test\\(ot\\);`));
  if (!match) throw new Error(`Could not locate ${constant} in public/index.html.`);
  return Function(`return (${match[1]});`)();
}

const massRemoval = expressionFor("massRemoval");
const friendlyMassEffect = expressionFor("friendlyMassEffect");
const cases = [
  ["Saproling Symbiosis", "Create a 1/1 green Saproling creature token for each creature you control.", false],
  ["Ghostway", "Exile each creature you control. Return those cards to the battlefield under their owner's control at the beginning of the next end step.", false],
  ["Comet Storm", "Comet Storm deals X damage to each of up to X targets.", false],
  ["Torment of Hailfire", "Each opponent loses 3 life unless that player sacrifices a nonland permanent or discards a card.", false],
  ["Toxic Deluge", "All creatures get -X/-X until end of turn.", true],
  ["Wrath of God", "Destroy all creatures. They can't be regenerated.", true],
  ["Farewell", "Exile all artifacts, all creatures, all enchantments, all graveyards, and all planeswalkers.", true],
  ["Cyclonic Rift", "Return all nonland permanents you don't control to their owners' hands.", true],
  ["Chandra's Ignition", "Target creature you control deals damage equal to its power to each other creature and each opponent.", true],
];

for (const [name, oracleText, expected] of cases) {
  const actual = massRemoval.test(oracleText.toLowerCase()) && !friendlyMassEffect.test(oracleText.toLowerCase());
  if (actual !== expected) errors.push(`${name}: expected board wipe ${expected}, received ${actual}.`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Board-wipe regressions are valid: ${cases.length} cases.`);
