import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
  for (const directory of f.roots.toReversed()) {
    const result = await discoverPrompts(
      { directory: f.nested, worktree: f.project },
      f.env,
    );
    assert.deepEqual(result.directories, f.roots);
    assert.deepEqual(result.files.get("review/evidence.md"), {
      path: join(directory, "prompts/review/evidence.md"),
      root: join(directory, "prompts"),
      relativePath: "review/evidence.md",
    });
    await rm(join(directory, "prompts/review/evidence.md"));
  }
  const empty = await discoverPrompts(
    { directory: f.nested, worktree: f.project },
    f.env,
  );
  assert.equal(empty.files.size, 0);
});

test("project disable flag keeps global, home and custom discovery", async (t) => {
  const f = await fixture(t);
  // OpenCode 1.18.34's Flag.truthy accepts case-insensitive "true" and "1".
  for (const value of ["1", "true", "TRUE", "True"]) {
    const result = await discoverPrompts(
      { directory: f.nested, worktree: f.project },
      { ...f.env, OPENCODE_DISABLE_PROJECT_CONFIG: value },
    );
    assert.deepEqual(
      result.directories,
      [f.global, join(f.home, ".opencode"), f.custom],
      `project discovery disabled by ${value}`,
    );
    assert.equal(
      result.files.get("review/evidence.md")?.path,
      join(f.custom, "prompts/review/evidence.md"),
    );
  }
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
  assert.equal(
    result.files.get("review/evidence.md")?.path,
    join(f.home, ".opencode/prompts/review/evidence.md"),
  );
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

test("reports the first failing entry in sorted order", async (t) => {
  const f = await fixture(t);
  const prompts = join(f.global, "prompts");
  await writeFile(join(f.root, "secret.md"), "secret");
  try {
    await symlink(join(f.root, "secret.md"), join(prompts, "z.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Symlink privilege unavailable");
      return;
    }
    throw error;
  }
  const discover = () =>
    discoverPrompts({ directory: f.nested, worktree: f.project }, f.env);
  await mkdir(join(prompts, "a", ...Array<string>(32).fill("d")), {
    recursive: true,
  });
  await assert.rejects(discover(), /cycle or depth limit/);
  await rm(join(prompts, "a"), { recursive: true });
  await mkdir(join(prompts, "a"));
  await mkdir(join(prompts, ".private"));
  await writeFile(join(prompts, ".private/body.md"), "Private");
  await symlink(join(prompts, ".private/body.md"), join(prompts, "a/body.md"));
  await assert.rejects(discover(), /hidden path/);
  await rm(join(prompts, "a"), { recursive: true });
  await assert.rejects(discover(), /escapes/);
});

test("allows exactly 4096 entries and reports the limit before later failures", async (t) => {
  const f = await fixture(t);
  const empty = join(f.root, "empty");
  const prompts = join(f.root, "limit/prompts");
  const many = join(prompts, "many");
  await mkdir(many, { recursive: true });
  const env = {
    XDG_CONFIG_HOME: join(f.root, "unused"),
    OPENCODE_TEST_HOME: empty,
    OPENCODE_CONFIG_DIR: join(f.root, "limit"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  };
  const discover = () =>
    discoverPrompts({ directory: empty, worktree: empty }, env);
  const name = (index: number) => `${String(index).padStart(4, "0")}.md`;
  // The directory itself is the first entry.
  for (let start = 0; start < 4095; start += 512) {
    await Promise.all(
      Array.from({ length: Math.min(512, 4095 - start) }, (_, offset) =>
        writeFile(join(many, name(start + offset)), "Snippet"),
      ),
    );
  }
  const result = await discover();
  assert.equal(result.files.size, 4095);
  assert.equal(result.files.has("many/4094.md"), true);
  await writeFile(join(many, name(4095)), "Snippet");
  await assert.rejects(discover(), /exceeds 4096 entries/);
  await rm(join(many, name(4095)));
  await writeFile(join(f.root, "secret.md"), "secret");
  try {
    await symlink(join(f.root, "secret.md"), join(prompts, "z.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Symlink privilege unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(discover(), /exceeds 4096 entries/);
});

test("discovery keeps a bounded number of path lookups in flight", async (t) => {
  const f = await fixture(t);
  const prompts = join(f.global, "prompts");
  for (let index = 0; index < 100; index++) {
    await mkdir(join(prompts, `area-${index % 4}`), { recursive: true });
    await writeFile(join(prompts, `area-${index % 4}`, `${index}.md`), "Text");
  }
  let active = 0;
  let peak = 0;
  for (const name of ["realpath", "stat"] as const) {
    const original = fs[name] as (...args: unknown[]) => Promise<unknown>;
    t.mock.method(fs, name, async (...args: unknown[]) => {
      peak = Math.max(peak, ++active);
      try {
        return await original(...args);
      } finally {
        active--;
      }
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const result = await discoverPrompts(
    { directory: f.nested, worktree: f.project },
    f.env,
  );
  assert.equal(result.files.has("area-3/99.md"), true);
  assert.ok(peak <= 16, `${peak} path lookups were in flight`);
});
