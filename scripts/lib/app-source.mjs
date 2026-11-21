// The web client's source as one string: public/index.html, public/styles.css and the numbered scripts in
// public/js, in the order the server joins them into /app.js. Lets the checks find @testable blocks wherever a
// helper now lives.
import { readFileSync, readdirSync } from "node:fs";

const at = (path) => new URL(`../../public/${path}`, import.meta.url);

export function scriptFiles() {
  return readdirSync(at("js")).filter((f) => /^\d{2}-[\w-]+\.js$/.test(f)).sort().map((f) => `js/${f}`);
}

// What the browser runs: the scripts joined in order (as server.js serves /app.js).
export function readClientScript() {
  return scriptFiles().map((f) => readFileSync(at(f), "utf8")).join("\n");
}

export function readAppSource() {
  return [readFileSync(at("index.html"), "utf8"), readFileSync(at("styles.css"), "utf8"), readClientScript()].join("\n");
}
