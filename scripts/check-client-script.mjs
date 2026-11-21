// The web client's numbered scripts (public/js) are joined into /app.js by the server. Checks that the join
// still parses as one script and that index.html loads /app.js (not the files one by one, which breaks
// hoisting: top-level code calls functions defined in later files).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test, run } from "./lib/tiny-test.mjs";
import { readClientScript, scriptFiles } from "./lib/app-source.mjs";

test("the joined client script parses", () => {
  assert.doesNotThrow(() => new vm.Script(readClientScript(), { filename: "app.js" }));
});

test("index.html loads /app.js and no single script file", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<script src="\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /<script src="\/js\//);
});

test("script files are numbered so their order is clear", () => {
  const files = scriptFiles();
  assert.ok(files.length >= 2, "expected several script files");
  files.forEach((f, i) => assert.ok(f.startsWith(`js/${String(i + 1).padStart(2, "0")}-`), `${f} is out of sequence`));
});

await run("Client script");
