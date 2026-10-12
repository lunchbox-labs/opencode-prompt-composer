import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { discoverPrompts } from "../src/discovery.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const global = join(root, "config/opencode");
  const project = join(root, "project");
  const nested = join(project, "child");
  const custom = join(root, "custom");
  const roots = [
    global,
    join(nested, ".opencode"),
    join(project, ".opencode"),
    join(home, ".opencode"),
    custom,
  ];
  for (const dir of roots) {
    await mkdir(join(dir, "prompts/review"), { recursive: true });
    await writeFile(join(dir, "prompts/review/evidence.md"), dir);
  }
  const env = {
    XDG_CONFIG_HOME: join(root, "config"),
    OPENCODE_TEST_HOME: home,
    OPENCODE_CONFIG_DIR: custom,
  };
  return { root, home, global, project, nested, custom, roots, env };
}

test("mirrors pinned host root order and later relative-path overrides", async (t) => {
  const f = await fixture(t);
  const result = await discoverPrompts(
    { directory: f.nested, worktree: f.project },
    f.env,
  );
  assert.deepEqual(result.directories, f.roots);
  assert.equal(
    result.files.get("review/evidence.md")?.path,
    join(f.custom, "prompts/review/evidence.md"),
  );
  await rm(join(f.custom, "prompts/review/evidence.md"));
  const fallback = await discoverPrompts(
    { directory: f.nested, worktree: f.project },
    f.env,
  );
  assert.equal(
    fallback.files.get("review/evidence.md")?.path,
    join(f.home, ".opencode/prompts/review/evidence.md"),
  );
});

test("project disable flag keeps global, home and custom discovery", async (t) => {
  const f = await fixture(t);
  const result = await discoverPrompts(
    { directory: f.nested, worktree: f.project },
    { ...f.env, OPENCODE_DISABLE_PROJECT_CONFIG: "1" },
  );
  assert.deepEqual(result.directories, [
    f.global,
    join(f.home, ".opencode"),
    f.custom,
  ]);
});

test("deduplicates repeated roots and respects worktree traversal boundary", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".opencode/prompts"), { recursive: true });
  await writeFile(join(f.root, ".opencode/prompts/outside.md"), "outside");
  const result = await discoverPrompts(
    { directory: f.nested, worktree: f.project },
    { ...f.env, OPENCODE_CONFIG_DIR: f.global },
  );
  assert.deepEqual(result.directories, f.roots.slice(0, -1));
  assert.equal(result.files.has("outside.md"), false);
});

test("preserves nested relative names, ignores unsupported/hidden files, rejects escaping symlinks", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.global, "prompts/review/evidence.txt"), "Text");
  await writeFile(join(f.global, "prompts/.hidden.md"), "Hidden");
  await writeFile(join(f.global, "prompts/data.json"), "{}");
  const result = await discoverPrompts(
    { directory: f.nested, worktree: f.project },
    f.env,
  );
  assert.equal(result.files.has("review/evidence.txt"), true);
  assert.equal(result.files.has(".hidden.md"), false);
  assert.equal(result.files.has("data.json"), false);
  await writeFile(join(f.root, "secret.md"), "secret");
  try {
    await symlink(join(f.root, "secret.md"), join(f.custom, "prompts/leak.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Symlink privilege unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(
    discoverPrompts({ directory: f.nested, worktree: f.project }, f.env),
    /escapes/,
  );
});
