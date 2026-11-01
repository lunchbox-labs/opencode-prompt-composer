import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import server from "../src/server.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-startup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, ".opencode/prompts");
  await mkdir(directory, { recursive: true });
  return {
    root,
    directory,
    context: { directory: root, worktree: root } as PluginInput,
  };
}

const config = (): Config => ({
  agent: {
    review: { prompt: "Review {{include:body.md}}", model: "fixture/model" },
  },
  command: {
    check: {
      template: "Check {{include:body.md}} \\{{include:literal.md}}",
      subtask: true,
    },
  },
});

function skill(body: string) {
  return {
    title: "Current skill title",
    metadata: { name: "evidence", dir: "/current/skill" },
    output: `<skill_content name="evidence">\n# Skill: evidence\n\n${body}\n\nBase directory for this skill: /current/skill\nRelative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.\nNote: file list is sampled.\n\n<skill_files>\n<file>/current/skill/current.txt</file>\n</skill_files>\n</skill_content>`,
  };
}

const skillInput = { tool: "skill", sessionID: "s", callID: "c", args: {} };

test("startup snippets survive edits and subsequent plugin factories without freezing native bodies", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "body.md"), "First {{include:nested.txt}}");
  await writeFile(join(f.directory, "nested.txt"), "  evidence  ");
  const hooks = await server.server(f.context);
  const first = config();
  await hooks.config!(first);
  await writeFile(join(f.directory, "body.md"), "Second");
  await rm(join(f.directory, "nested.txt"));
  await writeFile(join(f.directory, "new.md"), "New");
  await hooks.config!(first);
  assert.equal(first.agent!.review!.prompt, "Review First evidence");
  assert.equal(
    first.command!.check.template,
    "Check First evidence {{include:literal.md}}",
  );
  const next = await server.server(f.context);
  const supplied = config();
  supplied.agent!.review!.prompt = "Profile {{include:body.md}}";
  supplied.agent!.review!.model = "fixture/next-model";
  await next.config!(supplied);
  assert.equal(supplied.agent!.review!.prompt, "Profile First evidence");
  assert.equal(supplied.agent!.review!.model, "fixture/next-model");
  const newReference: Config = {
    command: { new: { template: "{{include:new.md}}" } },
  };
  await assert.rejects(next.config!(newReference), /does not exist/);
  assert.equal(newReference.command!.new.template, "{{include:new.md}}");
});

test("unused startup snippets are captured before first skill use and preserve current native framing", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, "unused.md"),
    "  Startup {{include:nested.txt}}  ",
  );
  await writeFile(join(f.directory, "nested.txt"), "evidence");
  const hooks = await server.server(f.context);
  await hooks.config!({});
  await writeFile(join(f.directory, "unused.md"), "Edited");
  await rm(join(f.directory, "nested.txt"));
  const output = skill(
    "Native body before\n{{include:unused.md}}\n\\{{include:literal.md}}\nNative body after",
  );
  const expected = structuredClone(output);
  await hooks["tool.execute.after"]!(skillInput, output);
  assert.deepEqual(output, {
    ...expected,
    output: expected.output
      .replace("{{include:unused.md}}", "Startup evidence")
      .replace("\\{{include:literal.md}}", "{{include:literal.md}}"),
  });
  const next = await server.server(f.context);
  const changedBody = skill("New native body {{include:unused.md}}");
  await next["tool.execute.after"]!(skillInput, changedBody);
  assert.ok(changedBody.output.includes("New native body Startup evidence"));
});

test("invalid unused snippets retain their capture errors after disk repair", async (t) => {
  const f = await fixture(t);
  for (const [name, text] of [
    ["large.md", "x".repeat(65537)],
    ["nul.md", "bad\0text"],
    ["utf8.md", Buffer.from([0xff])],
  ] as const) {
    await writeFile(join(f.directory, name), text);
  }
  const hooks = await server.server(f.context);
  await hooks.config!({ agent: { ordinary: { prompt: "No includes" } } });
  for (const name of ["large.md", "nul.md", "utf8.md"]) {
    await writeFile(join(f.directory, name), "Repaired");
    const output = skill(`{{include:${name}}}`);
    const before = structuredClone(output);
    await assert.rejects(hooks["tool.execute.after"]!(skillInput, output));
    assert.deepEqual(output, before);
  }
  const next = await server.server(f.context);
  await assert.rejects(
    next.config!({ command: { check: { template: "{{include:large.md}}" } } }),
    /64 KiB/,
  );
});

test("startup sources retain per-consumer cycles, byte limits and original error positions", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "full.md"), "é".repeat(32768));
  await writeFile(join(f.directory, "empty.md"), "");
  await writeFile(join(f.directory, "cycle.md"), "{{include:cycle.md}}");
  await writeFile(
    join(f.directory, "broken.md"),
    "\r\n\r\n  PRIVATE\r\n  {{include:broken",
  );
  const hooks = await server.server(f.context);
  await hooks.config!({});
  await rm(f.directory, { recursive: true });
  const exact: Config = {
    command: { check: { template: "{{include:full.md}}".repeat(4) } },
  };
  await hooks.config!(exact);
  assert.equal(Buffer.byteLength(exact.command!.check.template), 256 * 1024);
  for (const [template, expected] of [
    ["{{include:cycle.md}}", /cycle/],
    ["{{include:full.md}}".repeat(4) + "x", /256 KiB/],
    ["{{include:empty.md}}".repeat(257), /count or nesting/],
  ] as const) {
    await assert.rejects(
      hooks.config!({ command: { check: { template } } }),
      expected,
    );
  }
  await assert.rejects(
    hooks.config!({ agent: { review: { prompt: "{{include:broken.md}}" } } }),
    (error: Error) => {
      assert.match(error.message, /Consumer: agent "review"/);
      assert.match(error.message, /"broken\.md":4:3/);
      assert.doesNotMatch(error.message, /PRIVATE/);
      return true;
    },
  );
});

test("different projects capture independently at their own first initialization", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t);
  await writeFile(join(first.directory, "body.md"), "Project one");
  await writeFile(join(second.directory, "body.md"), "Project two");
  const firstHooks = await server.server(first.context);
  await firstHooks.config!({});
  await writeFile(join(first.directory, "body.md"), "Changed one");
  await writeFile(
    join(second.directory, "body.md"),
    "Changed before first load",
  );
  const secondHooks = await server.server(second.context);
  const firstConfig = config();
  const secondConfig = config();
  await firstHooks.config!(firstConfig);
  await secondHooks.config!(secondConfig);
  assert.equal(firstConfig.agent!.review!.prompt, "Review Project one");
  assert.equal(
    secondConfig.agent!.review!.prompt,
    "Review Changed before first load",
  );
});

test("a fresh process sees edited, added and removed snippets", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "body.md"), "Startup");
  await writeFile(join(f.directory, "deleted.md"), "Deleted later");
  const hooks = await server.server(f.context);
  await hooks.config!({});
  await writeFile(join(f.directory, "body.md"), "Restarted");
  await writeFile(join(f.directory, "added.md"), "Added");
  await rm(join(f.directory, "deleted.md"));
  const script = `import assert from 'node:assert/strict';
import server from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
const hooks = await server.server({ directory: process.argv[1], worktree: process.argv[1] });
const config = { command: { check: { template: '{{include:body.md}} {{include:added.md}}' } } };
await hooks.config(config);
assert.equal(config.command.check.template, 'Restarted Added');
await assert.rejects(hooks.config({ command: { deleted: { template: '{{include:deleted.md}}' } } }), /does not exist/);`;
  await promisify(execFile)(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script, f.root],
    { timeout: 20_000 },
  );
});

test("normalized project contexts reuse startup discovery environment", async (t) => {
  const f = await fixture(t);
  const custom = join(f.root, "custom/prompts");
  await mkdir(custom, { recursive: true });
  await writeFile(join(custom, "body.md"), "Custom later");
  await writeFile(join(f.directory, "body.md"), "Startup project");
  const hooks = await server.server(f.context);
  await hooks.config!({});
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = join(f.root, "custom");
  try {
    const next = await server.server({
      ...f.context,
      directory: join(f.root, "child", ".."),
    });
    const current = config();
    await next.config!(current);
    assert.equal(current.agent!.review!.prompt, "Review Startup project");
  } finally {
    if (previous === undefined) {
      delete process.env.OPENCODE_CONFIG_DIR;
    } else {
      process.env.OPENCODE_CONFIG_DIR = previous;
    }
  }
});

test(
  "captured canonical sources survive permissions and symlink changes",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const original = join(f.directory, "body.md");
    await writeFile(original, "Startup");
    const hooks = await server.server(f.context);
    await hooks.config!({});
    const moved = join(f.directory, "moved.md");
    await rename(original, moved);
    await chmod(moved, 0o000);
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "Outside");
    await symlink(outside, original);
    const current = config();
    await hooks.config!(current);
    assert.equal(current.agent!.review!.prompt, "Review Startup");
  },
);

test(
  "discovery failure stays failed after repair and keeps skill hooks registered",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "Outside");
    await symlink(outside, join(f.directory, "body.md"));
    const hooks = await server.server(f.context);
    await assert.rejects(hooks.config!({}), /escapes/);
    await rm(join(f.directory, "body.md"));
    await writeFile(join(f.directory, "body.md"), "Repaired");
    const next = await server.server(f.context);
    await assert.rejects(next.config!({}), /escapes/);
    await assert.rejects(
      next["tool.execute.after"]!(skillInput, skill("{{include:body.md}}")),
      /escapes/,
    );
  },
);

for (const mutation of ["edit", "add"] as const) {
  test(`startup rejects a snippet ${mutation} during capture before publishing config`, async (t) => {
    const f = await fixture(t);
    const body = join(f.directory, "body.md");
    await writeFile(body, "Startup");
    const canonicalBody = await fs.realpath(body);
    const open = fs.open;
    let changed = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      const file = await open(...args);
      if (args[0] === canonicalBody) {
        const close = file.close.bind(file);
        t.mock.method(file, "close", async () => {
          await close();
          if (!changed) {
            changed = true;
            await writeFile(
              mutation === "edit" ? body : join(f.directory, "new.md"),
              "Changed",
            );
          }
        });
      }
      return file;
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const hooks = await server.server(f.context);
    const current = config();
    const before = structuredClone(current);
    await assert.rejects(hooks.config!(current), /changed/i);
    assert.deepEqual(current, before);
  });
}

for (const [from, to] of [
  ["file", "directory"],
  ["directory", "file"],
] as const) {
  test(`startup never publishes a sibling ${from} replaced by a ${to} while discovery walks an earlier directory`, async (t) => {
    const f = await fixture(t);
    const earlier = join(f.directory, "a");
    const sibling = join(f.directory, "b.md");
    const place = async (kind: "file" | "directory", text: string) => {
      if (kind === "file") {
        await writeFile(sibling, text);
        return;
      }
      await mkdir(sibling);
      await writeFile(join(sibling, "c.md"), text);
    };
    await mkdir(earlier);
    await writeFile(join(earlier, "body.md"), "Startup");
    await place(from, "Sibling");
    const readdir = fs.readdir;
    let changed = false;
    t.mock.method(
      fs,
      "readdir",
      async (...args: Parameters<typeof readdir>) => {
        if (!changed && args[0] === earlier) {
          changed = true;
          await rm(sibling, { recursive: true });
          await place(to, "Changed");
        }
        return readdir(...args);
      },
    );
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const hooks = await server.server(f.context);
    const current: Config = {
      command: {
        check: {
          template: `{{include:${to === "file" ? "b.md" : "b.md/c.md"}}}`,
        },
      },
    };
    const before = structuredClone(current);
    // Discovery may look up b.md before walking a/; a stale result must not be published.
    try {
      await hooks.config!(current);
    } catch (error) {
      assert.match((error as Error).message, /changed/i);
      assert.deepEqual(current, before);
      return;
    }
    assert.equal(current.command!.check.template, "Changed");
  });
}

test(
  "startup captures every valid snippet under a bounded descriptor limit",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    for (let index = 0; index < 800; index++) {
      await writeFile(join(f.directory, `${index}.md`), `Snippet ${index}`);
    }
    const script = `import assert from 'node:assert/strict';
import server from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
const hooks = await server.server({ directory: process.argv[1], worktree: process.argv[1] });
await hooks.config({});
for (let index = 0; index < 800; index++) {
  const config = { command: { check: { template: '{{include:' + index + '.md}}' } } };
  await hooks.config(config);
  assert.equal(config.command.check.template, 'Snippet ' + index);
}`;
    await promisify(execFile)(
      "bash",
      [
        "-c",
        'set -e\nulimit -n 128\nexec "$@"',
        "startup-capture",
        process.execPath,
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        script,
        f.root,
      ],
      {
        timeout: 30_000,
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(f.root, "config"),
          OPENCODE_TEST_HOME: f.root,
          OPENCODE_CONFIG_DIR: "",
          OPENCODE_DISABLE_PROJECT_CONFIG: "false",
        },
      },
    );
  },
);
