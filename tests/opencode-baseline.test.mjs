import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const lock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("published package has no OpenCode engine gate and retains the Node requirement", () => {
  assert.equal(Object.hasOwn(manifest.engines, "opencode"), false);
  assert.equal(manifest.engines.node, ">=22.18.0");
  assert.equal(Object.hasOwn(lock.packages[""].engines, "opencode"), false);
  assert.equal(lock.packages[""].engines.node, manifest.engines.node);
});

test("release retains independently pinned SDK and plugin build dependencies", () => {
  assert.equal(manifest.devDependencies["@opencode-ai/plugin"], "1.18.34");
  assert.equal(manifest.devDependencies["@opencode-ai/sdk"], "1.18.34");
});

test("test-only host policy retains the range and floor independently of package engines", async () => {
  const support = JSON.parse(
    await readFile(new URL("./opencode.json", import.meta.url), "utf8"),
  );
  assert.equal(support.range, "1.19.x");
  assert.equal(support.floor, "1.19.0");
});
