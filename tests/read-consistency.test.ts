import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { discoverPrompts } from "../src/discovery.ts";
import { compose } from "../src/runtime.ts";
import { verifyInventory, verifyReads } from "../src/read-consistency.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-consistency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode/prompts"), { recursive: true });
  const snippetPath = join(root, ".opencode/prompts/body.md");
  await writeFile(snippetPath, "Original");
  const context = { directory: root, worktree: root };
  const inventory = await discoverPrompts(context);
  const composition = await compose(
    { command: { check: { template: "{{include:body.md}}" } } },
    inventory,
  );
  return {
    root,
    snippetPath,
    inventory,
    context,
    reads: composition.reads,
  };
}

test("unchanged prompt reads pass final consistency verification", async (t) => {
  const f = await fixture(t);
  await verifyReads(f.reads);
  await verifyInventory(f.context, f.inventory);
});

for (const source of ["snippetPath"] as const) {
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

test("prompt inventory changes are rejected", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".opencode/prompts/new.md"), "New");
  await assert.rejects(
    verifyInventory(f.context, f.inventory),
    /discovery changed/,
  );
});

test("deleted prompt reads are rejected", async (t) => {
  const f = await fixture(t);
  await rm(f.snippetPath);
  await assert.rejects(verifyReads(f.reads));
});
