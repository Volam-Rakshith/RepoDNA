import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("the static app shell and primary analysis script exist", () => {
  const html = read("index.html");
  const js = read("app.js");
  assert.match(html, /id="scan-form"/);
  assert.match(html, /id="dna-chart"/);
  assert.match(js, /function parseRepoInput/);
  assert.match(js, /function buildDimensions/);
  assert.match(js, /stats\/code_frequency/);
});

test("the project documents its privacy and evidence boundaries", () => {
  const readme = read("README.md");
  const architecture = read("docs/ARCHITECTURE.md");
  assert.match(readme, /does not upload repository contents/i);
  assert.match(readme, /not quality scores/i);
  assert.match(architecture, /Promise\.allSettled/);
  assert.match(architecture, /HTTP 202/);
});

test("repository input examples are constrained to owner and repository", () => {
  const js = read("app.js");
  assert.match(js, /parts\.length !== 2/);
  assert.match(js, /github\.com/);
  assert.match(js, /replace\(\/\\.git\$\/i, ""\)/);
});
