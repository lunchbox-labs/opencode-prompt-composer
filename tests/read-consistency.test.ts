import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { type PromptInventory, discoverPrompts } from "../src/discovery.ts";
import { type PromptDependency, expandIncludes } from "../src/includes.ts";
import { verifyInventory, verifyReads } from "../src/read-consistency.ts";

async function readBody(
  inventory: PromptInventory,
): Promise<PromptDependency[]> {
  const reads: PromptDependency[] = [];
  await expandIncludes("{{include:body.md}}", inventory.files, (source) =>
    reads.push(source),
  );
  return reads;
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-consistency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode/prompts"), { recursive: true });
  const snippetPath = join(root, ".opencode/prompts/body.md");
  await writeFile(snippetPath, "Original");
  const context = { directory: root, worktree: root };
  const inventory = await discoverPrompts(context);
  const reads = await readBody(inventory);
  return {
    root,
    snippetPath,
    inventory,
    context,
    reads,
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

test(
  "retargeted sources with identical text and permissions are rejected",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const original = join(f.root, ".opencode/prompts/original.md");
    await rename(f.snippetPath, original);
    await symlink(original, f.snippetPath);
    const reads = await readBody(f.inventory);
    const replacement = join(f.root, ".opencode/prompts/replacement.md");
    await writeFile(replacement, f.reads[0].text);
    await chmod(replacement, f.reads[0].mode);
    await rm(f.snippetPath);
    await symlink(replacement, f.snippetPath);
    await assert.rejects(verifyReads(reads), /Prompt input changed:/);
  },
);

test("final reads accept the source byte limit and reject growth beyond it", async (t) => {
  const f = await fixture(t);
  await writeFile(f.snippetPath, "x".repeat(64 * 1024));
  const reads = await readBody(f.inventory);
  await verifyReads(reads);
  await writeFile(f.snippetPath, "x".repeat(64 * 1024 + 1));
  await assert.rejects(
    verifyReads(reads),
    /Prompt sources must be regular files within the size limit\./,
  );
});

test("final reads report the first changed source in input order", async (t) => {
  const f = await fixture(t);
  const names = Array.from({ length: 40 }, (_, index) => `${index}.md`);
  for (const name of names) {
    await writeFile(join(f.root, ".opencode/prompts", name), "Original");
  }
  const reads: PromptDependency[] = [];
  await expandIncludes(
    names.map((name) => `{{include:${name}}}`).join(" "),
    (await discoverPrompts(f.context)).files,
    (source) => reads.push(source),
  );
  // Later deletions fail faster than the earlier same-size edit is detected.
  await writeFile(join(f.root, ".opencode/prompts/3.md"), "Modified");
  for (const name of names.slice(4)) {
    await rm(join(f.root, ".opencode/prompts", name));
  }
  await assert.rejects(verifyReads(reads), (error: Error) => {
    assert.equal(
      error.message,
      `Prompt input changed: ${join(f.root, ".opencode/prompts/3.md")}. Retry composition.`,
    );
    return true;
  });
});
