import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("host support admits every 1.19 patch and excludes adjacent minors", () => {
  // Canonical npm x-range: includes 1.19.0 and 1.19.3, excludes 1.18.34,
  // 1.20.0 and prereleases. Keep the lower patch floor at zero.
  assert.equal(manifest.engines.opencode, "1.19.x");
});

test("release retains independently pinned SDK and plugin build dependencies", () => {
  assert.equal(manifest.devDependencies["@opencode-ai/plugin"], "1.18.34");
  assert.equal(manifest.devDependencies["@opencode-ai/sdk"], "1.18.34");
});
