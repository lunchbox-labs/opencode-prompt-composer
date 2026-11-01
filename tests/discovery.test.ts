import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
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

/** Records the realpath and stat calls discovery makes for each entry it looks up. */
function traceLookups(t: TestContext) {
  const trace = { paths: [] as string[], active: 0, peak: 0 };
  for (const name of ["realpath", "stat"] as const) {
    const original = fs[name] as (...args: unknown[]) => Promise<unknown>;
    t.mock.method(fs, name, async (...args: unknown[]) => {
      trace.paths.push(String(args[0]));
      trace.peak = Math.max(trace.peak, ++trace.active);
      try {
        return await original(...args);
      } finally {
        trace.active--;
      }
    });
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return trace;
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
  // The limit falls inside a lookup batch; its later entries are never resolved.
  const past = Array.from({ length: 4 }, (_, offset) => name(4095 + offset));
  for (const file of past) {
    await writeFile(join(many, file), "Snippet");
  }
  const trace = traceLookups(t);
  await assert.rejects(discover(), /exceeds 4096 entries/);
  assert.deepEqual(
    trace.paths.filter((path) => past.includes(basename(path))),
    [],
  );
  for (const file of past) {
    await rm(join(many, file));
  }
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

test("discovery overlaps a bounded number of path lookups", async (t) => {
  const f = await fixture(t);
  const prompts = join(f.global, "prompts");
  for (let index = 0; index < 100; index++) {
    await mkdir(join(prompts, `area-${index % 4}`), { recursive: true });
    await writeFile(join(prompts, `area-${index % 4}`, `${index}.md`), "Text");
  }
  const trace = traceLookups(t);
  const result = await discoverPrompts(
    { directory: f.nested, worktree: f.project },
    f.env,
  );
  assert.equal(result.files.has("area-3/99.md"), true);
  assert.ok(trace.peak > 1, "path lookups ran one at a time");
  assert.ok(trace.peak <= 16, `${trace.peak} path lookups were in flight`);
});

test(
  "rejects a directory symlink loop",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const review = join(f.global, "prompts/review");
    await symlink(review, join(review, "loop"));
    await assert.rejects(
      discoverPrompts({ directory: f.nested, worktree: f.project }, f.env),
      /cycle or depth limit/,
    );
  },
);

test("discovery resolves a bounded number of entries at a time and stops at the entry limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const prompts = join(project, ".opencode/prompts");
  // Each enclosing directory lists its subdirectory first, ahead of many
  // files, and the innermost directory alone exceeds the entry limit.
  const middle = join(prompts, "0");
  const inner = join(middle, "0");
  await mkdir(inner, { recursive: true });
  const files = [
    ...[prompts, middle].flatMap((directory) =>
      Array.from({ length: 100 }, (_, index) =>
        join(directory, `${index + 1}.md`),
      ),
    ),
    ...Array.from({ length: 4100 }, (_, index) => join(inner, `${index}.md`)),
  ];
  for (let index = 0; index < files.length; index += 256) {
    await Promise.all(
      files.slice(index, index + 256).map((file) => writeFile(file, "prompt")),
    );
  }
  const trace = traceLookups(t);
  await assert.rejects(
    discoverPrompts(
      { directory: project, worktree: project },
      {
        XDG_CONFIG_HOME: join(root, "config"),
        OPENCODE_TEST_HOME: join(root, "home"),
      },
    ),
    /exceeds 4096 entries/,
  );
  assert.ok(trace.peak <= 16, `peak ${trace.peak}`);
  const looked = new Set(
    trace.paths.filter((path) => path.startsWith(prompts + sep)),
  );
  // Past the limit, each enclosing directory has looked up only the rest of
  // the batch that held its subdirectory.
  assert.ok(
    looked.size <= 4096 + 2 * (16 - 1),
    `looked up ${looked.size} entries`,
  );
});
