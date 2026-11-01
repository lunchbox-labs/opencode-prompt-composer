import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { STARTUP_CONCURRENCY } from "../src/bounded-map.ts";
import { discoverPrompts } from "../src/discovery.ts";

function wrapRealpath(
  t: TestContext,
  wrap: (path: string, resolve: () => Promise<unknown>) => Promise<unknown>,
) {
  const realpath = fs.realpath;
  t.mock.method(fs, "realpath", (...args: Parameters<typeof realpath>) =>
    wrap(String(args[0]), () => realpath(...args)),
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

async function link(t: TestContext, target: string, path: string) {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Symlink privilege unavailable");
      return false;
    }
    throw error;
  }
}

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
  if (
    !(await link(
      t,
      join(f.root, "secret.md"),
      join(f.custom, "prompts/leak.md"),
    ))
  ) {
    return;
  }
  await assert.rejects(
    discoverPrompts({ directory: f.nested, worktree: f.project }, f.env),
    /escapes/,
  );
});

test("inventory order and the first reported error follow sorted traversal, not completion order", async (t) => {
  const f = await fixture(t);
  const prompts = join(f.global, "prompts");
  for (const name of ["a/one.md", "a/two.md", "b.md", "c/three.txt"]) {
    await mkdir(dirname(join(prompts, name)), { recursive: true });
    await writeFile(join(prompts, name), name);
  }
  // Paths starting with prompts/a sort first but resolve last.
  const late = join(prompts, "a");
  wrapRealpath(t, async (path, resolve) => {
    await setTimeout(path.startsWith(late) ? 30 : 0);
    return resolve();
  });
  const discover = () =>
    discoverPrompts({ directory: f.nested, worktree: f.project }, f.env);
  assert.deepEqual(
    [...(await discover()).files.keys()],
    ["a/one.md", "a/two.md", "b.md", "c/three.txt", "review/evidence.md"],
  );
  const escape = join(prompts, "a/escape.md");
  const hidden = join(prompts, "a-hidden.md");
  await writeFile(join(f.root, "secret.md"), "secret");
  await mkdir(join(prompts, ".private"));
  await writeFile(join(prompts, ".private/hidden.md"), "hidden");
  if (
    !(await link(t, join(f.root, "secret.md"), escape)) ||
    !(await link(t, join(prompts, ".private/hidden.md"), hidden)) ||
    !(await link(t, join(f.root, "missing.md"), join(prompts, "d.md")))
  ) {
    return;
  }
  // The dangling d.md fails first in time, but errors follow traversal order.
  await assert.rejects(discover(), (error: Error) => {
    assert.match(error.message, /escapes its prompts directory/);
    assert.ok(error.message.includes(escape), error.message);
    return true;
  });
  await rm(escape);
  await assert.rejects(discover(), /resolves to a hidden path/);
  await rm(hidden);
  await assert.rejects(discover(), { code: "ENOENT" });
});

test("discovery resolves a bounded number of entries at a time and stops at the entry limit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const prompts = join(project, ".opencode/prompts");
  await mkdir(prompts, { recursive: true });
  const names = Array.from({ length: 4100 }, (_, index) => `${index}.md`);
  for (let index = 0; index < names.length; index += 256) {
    await Promise.all(
      names
        .slice(index, index + 256)
        .map((name) => writeFile(join(prompts, name), name)),
    );
  }
  let active = 0;
  let peak = 0;
  let resolved = 0;
  wrapRealpath(t, async (path, resolve) => {
    if (dirname(path) === prompts) {
      resolved++;
    }
    peak = Math.max(peak, ++active);
    try {
      await setTimeout(0);
      return await resolve();
    } finally {
      active--;
    }
  });
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
  assert.ok(peak <= STARTUP_CONCURRENCY, `peak ${peak}`);
  assert.ok(resolved <= 4096, `resolved ${resolved}`);
});
