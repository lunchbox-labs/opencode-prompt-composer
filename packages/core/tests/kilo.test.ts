import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type TestContext, test } from "node:test";
import type { Config } from "@opencode-ai/plugin";
import { discoverPrompts, discoveryDirectories } from "../src/discovery.ts";
import { kilo, opencode } from "../src/host.ts";
import { createServer } from "../src/server.ts";
import { expandSkillBody } from "../src/skill-body.ts";
import { recordingToasts } from "./toasts.ts";

// The OpenCode host's behaviour is covered by the other test files; these
// cover what the Kilo host profile changes.
const server = createServer(kilo);

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-kilo-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const global = join(root, "config/kilo");
  const project = join(root, "project");
  const nested = join(project, "child");
  const custom = join(root, "custom");
  const roots = [
    global,
    join(nested, ".kilocode"),
    join(nested, ".kilo"),
    join(project, ".kilocode"),
    join(project, ".kilo"),
    join(home, ".kilocode"),
    join(home, ".kilo"),
    custom,
  ];
  for (const dir of roots) {
    await mkdir(join(dir, "prompts/review"), { recursive: true });
    await writeFile(join(dir, "prompts/review/evidence.md"), dir);
  }
  const env = {
    XDG_CONFIG_HOME: join(root, "config"),
    KILO_TEST_HOME: home,
    KILO_CONFIG_DIR: custom,
  };
  const context = { directory: nested, worktree: project, host: kilo };
  return { root, home, global, project, nested, custom, roots, env, context };
}

test("Kilo discovery mirrors the host's root order and later relative-path overrides", async (t) => {
  const f = await fixture(t);
  for (const directory of f.roots.toReversed()) {
    const result = await discoverPrompts(f.context, f.env);
    assert.deepEqual(result.directories, f.roots);
    assert.deepEqual(result.files.get("review/evidence.md"), {
      path: join(directory, "prompts/review/evidence.md"),
      root: join(directory, "prompts"),
      relativePath: "review/evidence.md",
    });
    await rm(join(directory, "prompts/review/evidence.md"));
  }
  const empty = await discoverPrompts(f.context, f.env);
  assert.equal(empty.files.size, 0);
});

test("Kilo's project disable flag keeps global, home and custom discovery", async (t) => {
  const f = await fixture(t);
  // Kilo 7.8.27's Flag.truthy accepts case-insensitive "true" and "1".
  for (const value of ["1", "true", "TRUE", "True"]) {
    const result = await discoverPrompts(f.context, {
      ...f.env,
      KILO_DISABLE_PROJECT_CONFIG: value,
    });
    assert.deepEqual(
      result.directories,
      [f.global, join(f.home, ".kilocode"), join(f.home, ".kilo"), f.custom],
      `project discovery disabled by ${value}`,
    );
    assert.equal(
      result.files.get("review/evidence.md")?.path,
      join(f.custom, "prompts/review/evidence.md"),
    );
  }
});

test("Kilo discovery deduplicates repeated roots and respects the worktree boundary", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, ".kilo/prompts"), { recursive: true });
  await writeFile(join(f.root, ".kilo/prompts/outside.md"), "outside");
  const result = await discoverPrompts(f.context, {
    ...f.env,
    KILO_CONFIG_DIR: f.global,
  });
  assert.deepEqual(result.directories, f.roots.slice(0, -1));
  assert.equal(result.files.has("outside.md"), false);
  assert.equal(
    result.files.get("review/evidence.md")?.path,
    join(f.home, ".kilo/prompts/review/evidence.md"),
  );
});

test("Kilo discovery ignores OpenCode roots and environment overrides", async (t) => {
  const f = await fixture(t);
  const legacy = join(f.root, "legacy");
  for (const directory of [
    join(f.root, "config/opencode"),
    join(f.project, ".opencode"),
    join(f.home, ".opencode"),
    legacy,
  ]) {
    await mkdir(join(directory, "prompts"), { recursive: true });
    await writeFile(join(directory, "prompts/legacy.md"), "Do not load");
  }
  const result = await discoverPrompts(f.context, {
    ...f.env,
    OPENCODE_CONFIG_DIR: legacy,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_TEST_HOME: legacy,
  });
  assert.deepEqual(result.directories, f.roots);
  assert.equal(result.files.has("legacy.md"), false);
});

test("OpenCode discovery ignores Kilo roots and environment overrides", async (t) => {
  const f = await fixture(t);
  const result = await discoverPrompts(
    { ...f.context, host: opencode },
    {
      ...f.env,
      KILO_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_TEST_HOME: f.home,
    },
  );
  assert.deepEqual(result.directories, [join(f.root, "config/opencode")]);
  assert.equal(result.files.size, 0);
});

test("both hosts ignore line breaks in XDG_CONFIG_HOME", async (t) => {
  const f = await fixture(t);
  for (const host of [kilo, opencode]) {
    const [global] = await discoveryDirectories(
      { ...f.context, host },
      { ...f.env, XDG_CONFIG_HOME: `${join(f.root, "config")}\r\n` },
    );
    assert.equal(global, join(f.root, "config", host.globalDirectory));
  }
});

test("Kilo checks ancestor roots together, keeping root order and the first failure in path order", async (t) => {
  // Build the paths from the platform's filesystem root so they match what
  // discovery resolves on Windows as well as on POSIX.
  const root = resolve("/");
  const environment = {
    XDG_CONFIG_HOME: join(root, "config"),
    KILO_TEST_HOME: join(root, "home"),
  };
  const context = {
    directory: join(root, "work", "a", "b"),
    worktree: join(root, "work"),
    host: kilo,
  };
  const missing = join(root, "work", "a", ".kilo");
  const nearest = join(root, "work", "a", "b", ".kilo");
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sequential = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("root checks ran one at a time")),
      500,
    );
  });
  t.after(() => clearTimeout(timer));
  sequential.catch(() => undefined);
  // Every check starts before any completes; later roots answer first.
  const present = async (path: string): Promise<boolean> => {
    started.push(path);
    if (started.length === 8) {
      release();
    }
    await Promise.race([gate, sequential]);
    await new Promise((resolve) =>
      setTimeout(resolve, 10 - started.indexOf(path)),
    );
    return path !== missing;
  };
  assert.deepEqual(await discoveryDirectories(context, environment, present), [
    join(root, "config", "kilo"),
    join(root, "work", "a", "b", ".kilocode"),
    nearest,
    join(root, "work", "a", ".kilocode"),
    join(root, "work", ".kilocode"),
    join(root, "work", ".kilo"),
    join(root, "home", ".kilocode"),
    join(root, "home", ".kilo"),
  ]);

  const failing = async (path: string): Promise<boolean> => {
    // The later root fails first; the earlier root's failure is still reported.
    await new Promise((resolve) =>
      setTimeout(resolve, path === nearest ? 20 : 0),
    );
    if (path === nearest || path === join(root, "home", ".kilo")) {
      throw new Error(`denied ${path}`);
    }
    return true;
  };
  await assert.rejects(
    discoveryDirectories(context, environment, failing),
    (error) => error instanceof Error && error.message === `denied ${nearest}`,
  );
});

test("Kilo reports the ancestor limit only after every checked ancestor succeeds", async () => {
  const environment = {
    XDG_CONFIG_HOME: "/config",
    KILO_TEST_HOME: "/home",
  };
  const directory = `/${Array.from({ length: 300 }, (_, index) => `d${index}`).join("/")}`;
  const context = { directory, worktree: "/", host: kilo };
  const checked: string[] = [];
  const present = (path: string): Promise<boolean> => {
    checked.push(path);
    return Promise.resolve(true);
  };
  await assert.rejects(
    discoveryDirectories(context, environment, present),
    /ancestor-directory limit/,
  );
  // Two project directories in each of the 256 ancestors.
  assert.equal(checked.length, 512);
  assert.ok(!checked.includes(join("/home", ".kilo")));

  const last = checked[511];
  const failing = (path: string): Promise<boolean> =>
    path === last
      ? Promise.reject(new Error(`denied ${path}`))
      : Promise.resolve(true);
  await assert.rejects(
    discoveryDirectories(context, environment, failing),
    (error) => error instanceof Error && error.message === `denied ${last}`,
  );
});

test("Kilo startup matches the host's whitespace-trimmed home", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-kilo-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(join(home, ".kilo/prompts"), { recursive: true });
  await writeFile(join(home, ".kilo/prompts/body.md"), "Home body");
  const previous = process.env.KILO_TEST_HOME;
  process.env.KILO_TEST_HOME = `  ${home}\n`;
  try {
    const hooks = await server.server({
      directory: root,
      worktree: root,
    } as Parameters<typeof server.server>[0]);
    const current: Config = {
      agent: { review: { prompt: "Review {{include:body.md}}" } },
    };
    await hooks.config!(current);
    assert.equal(current.agent!.review!.prompt, "Review Home body");
  } finally {
    if (previous === undefined) {
      delete process.env.KILO_TEST_HOME;
    } else {
      process.env.KILO_TEST_HOME = previous;
    }
  }
});

test("Kilo notices name Kilo's log", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-kilo-notice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".kilo/prompts"), { recursive: true });
  const { input, toasts } = recordingToasts({
    directory: root,
    worktree: root,
  });
  const hooks = await server.server(input);
  const config: Config = {
    agent: { review: { prompt: "Review {{include:missing.md}}" } },
    command: { check: { template: "Check {{include:other.md}}" } },
  };
  await hooks.config!(config);
  assert.equal(toasts.length, 1);
  assert.match(
    toasts[0].body.message,
    /^Some includes were not expanded in 2 prompts\. .* See the Kilo log for 1 more\.$/,
  );
});

const mustNotNotify = (reason: string): void => {
  assert.fail(`Recognized framing must not report a notice: ${reason}`);
};

test("Kilo built-in skills compose without a filesystem footer", async () => {
  const info = { name: "kilo-config", dir: "builtin" };
  const body = "Intro\n{{include:body.md}}\nEnd";
  const output = `<skill_content name="${info.name}">\n# Skill: ${info.name}\n\n${body}\n</skill_content>`;
  assert.equal(
    await expandSkillBody(
      kilo,
      output,
      info,
      async (text) => {
        assert.equal(text, body);
        return "Expanded body";
      },
      mustNotNotify,
    ),
    output.replace(body, "Expanded body"),
  );
});

test("built-in framing is accepted only for Kilo's native builtin metadata", async () => {
  const output =
    '<skill_content name="evidence">\n# Skill: evidence\n\n{{include:body.md}}\n</skill_content>';
  const cases: [typeof kilo, string, string][] = [
    [kilo, "/skills/evidence", output],
    [kilo, "builtin", `${output}trailing`],
    [opencode, "builtin", output],
  ];
  for (const [host, dir, text] of cases) {
    const notices: string[] = [];
    assert.equal(
      await expandSkillBody(
        host,
        text,
        { name: "evidence", dir },
        () => assert.fail("The body expander must not run for this output."),
        (reason) => {
          notices.push(reason);
        },
      ),
      text,
    );
    assert.equal(notices.length, 1);
    assert.match(notices[0], /unknown or incomplete framing/);
  }
});
