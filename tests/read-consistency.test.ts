import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { loadSettings } from "../src/settings.ts";
import { compose } from "../src/runtime.ts";
import { verifyInventory, verifyReads } from "../src/read-consistency.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-consistency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode/prompts"), { recursive: true });
  const settingsPath = join(root, ".opencode/prompt-composer.jsonc");
  const snippetPath = join(root, ".opencode/prompts/body.md");
  await writeFile(settingsPath, "{}");
  await writeFile(snippetPath, "Original");
  const settings = await loadSettings({ root });
  const composition = await compose(
    { command: { check: { template: "{{include:body.md}}" } } },
    settings,
  );
  return {
    root,
    settingsPath,
    snippetPath,
    settings,
    reads: [...settings.documents, ...composition.reads],
  };
}

test("unchanged settings and prompt reads pass final consistency verification", async (t) => {
  const f = await fixture(t);
  await verifyReads(f.reads, f.settings.missing);
  await verifyInventory(f.settings);
});

for (const source of ["settingsPath", "snippetPath"] as const) {
  test(`changed ${source} is rejected before config publication`, async (t) => {
    const f = await fixture(t);
    await writeFile(f[source], "Changed");
    await assert.rejects(verifyReads(f.reads), /input changed/);
  });
}

test(
  "changed source permissions are rejected",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    await chmod(f.snippetPath, 0o400);
    await assert.rejects(verifyReads(f.reads), /input changed/);
  },
);

test("newly created settings and prompt inventory changes are rejected", async (t) => {
  const f = await fixture(t);
  const missing = join(f.root, ".opencode/prompt-composer.json");
  await verifyReads([], [missing]);
  await writeFile(missing, "{}");
  await assert.rejects(verifyReads([], [missing]), /source was created/);
  await writeFile(join(f.root, ".opencode/prompts/new.md"), "New");
  await assert.rejects(verifyInventory(f.settings), /discovery changed/);
});
