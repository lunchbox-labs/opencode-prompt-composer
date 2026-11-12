import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const lock = JSON.parse(
  await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
);
const manifest = JSON.parse(
  await readFile(
    new URL("../packages/kilo/package.json", import.meta.url),
    "utf8",
  ),
);
const entry = lock.packages["packages/kilo"];

test("published Kilo package has no Kilo engine gate and retains the Node requirement", () => {
  assert.equal(Object.hasOwn(manifest.engines, "kilo"), false);
  assert.equal(manifest.engines.node, ">=22.18.0");
  assert.equal(Object.hasOwn(entry.engines, "kilo"), false);
  assert.equal(entry.engines.node, manifest.engines.node);
});

test("release retains independently pinned Kilo SDK and plugin build dependencies", () => {
  assert.equal(manifest.devDependencies["@kilocode/plugin"], "7.8.27");
  assert.equal(manifest.devDependencies["@kilocode/sdk"], "7.8.27");
  for (const name of ["@kilocode/plugin", "@kilocode/sdk"]) {
    assert.equal(lock.packages[`node_modules/${name}`].version, "7.8.27", name);
  }
});

test("test-only Kilo host policy retains the range and floor independently of package engines", async () => {
  const support = JSON.parse(
    await readFile(new URL("./kilo.json", import.meta.url), "utf8"),
  );
  assert.equal(support.range, ">=7.8.27 <7.9.0");
  assert.equal(support.floor, "7.8.27");
});

test("TUI dev dependencies match the pinned Kilo baseline", () => {
  // Kilo 7.8.27 maps a plugin's @opentui/* and solid-js imports to its own
  // bundled copies (@opentui 0.5.11 and solid-js 1.9.12). Building against
  // newer releases would let code use APIs no supported host provides.
  // solid-js stays at 1.9.12, the exact peer of @opentui 0.5.11. The OpenCode
  // packages hoist @opentui 0.4.5, so npm keeps Kilo's copies in its package.
  for (const name of ["@opentui/core", "@opentui/keymap", "@opentui/solid"]) {
    assert.equal(manifest.devDependencies[name], "0.5.11", name);
    assert.equal(
      lock.packages[`packages/kilo/node_modules/${name}`].version,
      "0.5.11",
      name,
    );
  }
  assert.equal(manifest.devDependencies["solid-js"], "1.9.12");
  assert.equal(lock.packages["node_modules/solid-js"].version, "1.9.12");
  assert.equal(lock.packages["packages/kilo/node_modules/solid-js"], undefined);
});
