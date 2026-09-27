import { join } from "path";
import { readJson, writeJsonAtomic } from "./json-file.js";

// Append-only record of every swaps-related AI call, so the UI can show spend.
export function createUsageLog({ dataDir, now = () => new Date() }) {
  const path = join(dataDir, "ai-usage.json");
  let chain = Promise.resolve();

  function record(entry) {
    const run = chain.then(async () => {
      const log = await readJson(path, { entries: [] });
      log.entries.push({ at: now().toISOString(), ...entry });
      await writeJsonAtomic(path, log);
    });
    chain = run.then(() => {}, () => {});
    return run;
  }

  async function monthUsd() {
    await chain;
    const log = await readJson(path, { entries: [] });
    const month = now().toISOString().slice(0, 7);
    return log.entries.filter((e) => String(e.at).startsWith(month)).reduce((n, e) => n + (e.usd || 0), 0);
  }

  return { record, monthUsd };
}
