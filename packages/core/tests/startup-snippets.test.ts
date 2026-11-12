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
import { basename, dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import { opencode } from "../src/host.ts";
import { createServer } from "../src/server.ts";
import { recordingToasts } from "./toasts.ts";

const server = createServer(opencode);

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
    command: { new: { template: "New: {{include:new.md}}" } },
  };
  await next.config!(newReference);
  assert.equal(newReference.command!.new.template, "New: ");
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
  const { input, toasts } = recordingToasts(f.context);
  const hooks = await server.server(input);
  await hooks.config!({ agent: { ordinary: { prompt: "No includes" } } });
  assert.equal(toasts.length, 0, "unused invalid snippets do not warn");
  for (const name of ["large.md", "nul.md", "utf8.md"]) {
    await writeFile(join(f.directory, name), "Repaired");
    for (const marker of ["include", "include?"]) {
      const output = skill(`[{{${marker}:${name}}}]`);
      await hooks["tool.execute.after"]!(skillInput, output);
      assert.equal(output.output, skill("[]").output);
      assert.match(toasts.at(-1)!.body.message, /not expanded/);
    }
  }
  const next = await server.server(input);
  for (const template of ["{{include:large.md}}", "{{include?:large.md}}"]) {
    const current: Config = { command: { check: { template } } };
    await next.config!(current);
    // Nothing else is left, so the command keeps its native text.
    assert.equal(current.command!.check.template, template);
    assert.match(
      toasts.at(-1)!.body.message,
      /in command "check"\. Its native text was kept because nothing else was left\. .*64 KiB/,
    );
  }
});

test("optional includes compose agents, commands and skills with and without their snippets", async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, "personal.md"),
    " Personal {{include:nested.txt}} ",
  );
  await writeFile(join(f.directory, "nested.txt"), "evidence");
  await writeFile(join(f.directory, "requires.md"), "{{include:absent.md}}");
  const hooks = await server.server(f.context);
  const text =
    "Review. {{include?:personal.md}}{{include?:absent.md}} \\{{include?:literal.md}}";
  const expected = "Review. Personal evidence {{include?:literal.md}}";
  const current: Config = {
    agent: { review: { prompt: text } },
    command: { check: { template: text } },
  };
  await hooks.config!(current);
  assert.equal(current.agent!.review!.prompt, expected);
  assert.equal(current.command!.check.template, expected);
  const output = skill(text);
  await hooks["tool.execute.after"]!(skillInput, output);
  assert.equal(output.output, skill(expected).output);
  const recorded = recordingToasts(f.context);
  const warned = await server.server(recorded.input);
  for (const [body, problem] of [
    ["{{include?:../personal.md}}", /safe relative/],
    ["{{include?:requires.md}}", /"absent\.md" does not exist/],
  ] as const) {
    const text = `Review. ${body}`;
    const composed: Config = {
      agent: { review: { prompt: text } },
      command: { check: { template: text } },
    };
    await warned.config!(composed);
    assert.equal(composed.agent!.review!.prompt, "Review. ");
    assert.equal(composed.command!.check.template, "Review. ");
    assert.match(recorded.toasts.at(-1)!.body.message, problem);
    const output = skill(text);
    await warned["tool.execute.after"]!(skillInput, output);
    assert.equal(output.output, skill("Review. ").output);
    assert.match(recorded.toasts.at(-1)!.body.message, problem);
  }
});

test(
  "optional includes of present snippets that cannot be read are left out with a warning",
  {
    skip:
      process.platform === "win32" || process.getuid?.() === 0
        ? "File permissions cannot deny reads here"
        : false,
  },
  async (t) => {
    const f = await fixture(t);
    const path = join(f.directory, "personal.md");
    await writeFile(path, "Personal");
    await chmod(path, 0o000);
    const { input, toasts } = recordingToasts(f.context);
    const hooks = await server.server(input);
    const config: Config = {
      agent: { review: { prompt: "Review {{include?:personal.md}}" } },
    };
    await hooks.config!(config);
    assert.equal(config.agent!.review!.prompt, "Review ");
    assert.equal(toasts.length, 1);
    assert.match(
      toasts[0].body.message,
      /Could not read prompt include "personal\.md"/,
    );
  },
);

test("includes of present prompt names that are not regular files are left out with a warning", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.directory, "personal/review.md"), { recursive: true });
  const names = ["personal/review.md"];
  if (process.platform !== "win32") {
    await promisify(execFile)("mkfifo", [join(f.directory, "fifo.md")]);
    names.push("fifo.md");
  }
  const { input, toasts } = recordingToasts(f.context);
  const hooks = await server.server(input);
  for (const name of names) {
    for (const marker of ["include", "include?"]) {
      const current: Config = {
        agent: { review: { prompt: `[{{${marker}:${name}}}]` } },
      };
      const shown = toasts.length;
      await hooks.config!(current);
      assert.equal(current.agent!.review!.prompt, "[]");
      assert.equal(toasts.length, shown + 1);
      assert.match(
        toasts.at(-1)!.body.message,
        /must be regular UTF-8 files/,
        "a directory or FIFO at the referenced path is invalid, not absent",
      );
    }
  }
});

test("broken prompt symlinks warn only for includes that use them", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "body.md"), "Body");
  try {
    await symlink(join(f.root, "missing.md"), join(f.directory, "dangling.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Symlink privilege unavailable");
      return;
    }
    throw error;
  }
  // Self-referencing symlinks are POSIX-only fixtures; Windows may not report ELOOP.
  const broken =
    process.platform === "win32" ? ["dangling.md"] : ["dangling.md", "loop.md"];
  if (process.platform !== "win32") {
    await symlink(join(f.directory, "loop.md"), join(f.directory, "loop.md"));
  }
  await symlink(join(f.root, "missing"), join(f.directory, "notes"));
  const { input, toasts } = recordingToasts(f.context);
  const hooks = await server.server(input);
  const current = config();
  await hooks.config!(current);
  assert.equal(current.agent!.review!.prompt, "Review Body");
  const output = skill("{{include:body.md}}");
  await hooks["tool.execute.after"]!(skillInput, output);
  assert.equal(output.output, skill("Body").output);
  assert.equal(toasts.length, 0);
  for (const name of broken) {
    const unreadable = new RegExp(
      `Could not read prompt include "${name.replace(".", "\\.")}"\\. Check`,
    );
    for (const marker of ["include", "include?"]) {
      const warnsLikeOtherUnreadableNames = `${marker} warns for ${name}, like other present names that cannot be read`;
      const agent: Config = {
        agent: { review: { prompt: `[{{${marker}:${name}}}]` } },
      };
      await hooks.config!(agent);
      assert.equal(agent.agent!.review!.prompt, "[]");
      assert.match(
        toasts.at(-1)!.body.message,
        unreadable,
        warnsLikeOtherUnreadableNames,
      );
      const loaded = skill(`[{{${marker}:${name}}}]`);
      await hooks["tool.execute.after"]!(skillInput, loaded);
      assert.equal(loaded.output, skill("[]").output);
      assert.match(
        toasts.at(-1)!.body.message,
        unreadable,
        warnsLikeOtherUnreadableNames,
      );
    }
  }
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
  const { input, toasts } = recordingToasts(f.context);
  const hooks = await server.server(input);
  await hooks.config!({});
  await rm(f.directory, { recursive: true });
  const exact: Config = {
    command: { check: { template: "{{include:full.md}}".repeat(4) } },
  };
  await hooks.config!(exact);
  assert.equal(Buffer.byteLength(exact.command!.check.template), 256 * 1024);
  assert.equal(toasts.length, 0);
  const oversized = "{{include:full.md}}".repeat(4) + "x";
  for (const [template, composed, problem] of [
    ["[{{include:cycle.md}}]", "[]", /cycle/],
    [oversized, oversized, /256 KiB.*native text was kept/],
    [
      "{{include:empty.md}}".repeat(256) + "[{{include:empty.md}}]",
      "[]",
      /count or nesting/,
    ],
  ] as const) {
    const current: Config = { command: { check: { template } } };
    await hooks.config!(current);
    assert.equal(current.command!.check.template, composed);
    assert.match(toasts.at(-1)!.body.message, problem);
  }
  const broken: Config = {
    agent: { review: { prompt: "{{include:broken.md}}" } },
  };
  await hooks.config!(broken);
  assert.equal(
    broken.agent!.review!.prompt,
    "PRIVATE\r\n  {{include:broken",
    "a malformed marker stays literal",
  );
  const { message } = toasts.at(-1)!.body;
  assert.match(message, /in agent "review"/);
  assert.match(message, /In "broken\.md" at 4:3\./);
  assert.doesNotMatch(message, /PRIVATE/);
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
import { opencode } from ${JSON.stringify(new URL("../src/host.ts", import.meta.url).href)};
import { createServer } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
const server = createServer(opencode);
const hooks = await server.server({ directory: process.argv[1], worktree: process.argv[1] });
const config = { command: { check: { template: '{{include:body.md}} {{include:added.md}}' } } };
await hooks.config(config);
assert.equal(config.command.check.template, 'Restarted Added');
const deleted = { command: { deleted: { template: '[{{include:deleted.md}}]' } } };
await hooks.config(deleted);
assert.equal(deleted.command.deleted.template, '[]');`;
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
  "a prompt linking outside its prompts directory is ignored with a warning while other prompts compose",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "Outside");
    await symlink(outside, join(f.directory, "body.md"));
    await writeFile(join(f.directory, "other.md"), "Other");
    const { input, toasts } = recordingToasts(f.context);
    const hooks = await server.server(input);
    const current: Config = {
      agent: { review: { prompt: "{{include:other.md}} {{include:body.md}}" } },
    };
    await hooks.config!(current);
    assert.equal(current.agent!.review!.prompt, "Other ");
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].body.variant, "warning");
    assert.match(
      toasts[0].body.message,
      /^Some includes were not expanded in agent "review"\. .*"body\.md" does not exist.* Ignored .*body\.md: it links outside its prompts directory\.$/,
    );
    const output = skill("Use {{include:body.md}}");
    await hooks["tool.execute.after"]!(skillInput, output);
    assert.equal(output.output, skill("Use ").output);
    assert.doesNotMatch(toasts.at(-1)!.body.message, /Outside/);
  },
);

test("a capture that fails keeps native text and is retried by the next plugin instance", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "body.md"), "Body");
  const ancestor = join(f.root, ".opencode");
  const lstat = fs.lstat;
  let failing = true;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof lstat>) => {
    if (failing && args[0] === ancestor) {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return lstat(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { input, toasts } = recordingToasts(f.context);
  const hooks = await server.server(input);
  const current = config();
  const before = structuredClone(current);
  await hooks.config!(current);
  assert.deepEqual(current, before);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].body.variant, "error");
  assert.match(
    toasts[0].body.message,
    /^Prompt files could not be read, so no includes were expanded; agents, commands and skills keep their native text\./,
  );
  const output = skill("{{include:body.md}}");
  const unchanged = structuredClone(output);
  await hooks["tool.execute.after"]!(skillInput, output);
  assert.deepEqual(output, unchanged);
  assert.match(toasts.at(-1)!.body.message, /includes were not expanded/);
  failing = false;
  const next = await server.server(input);
  const repaired = config();
  await next.config!(repaired);
  assert.equal(repaired.agent!.review!.prompt, "Review Body");
});

for (const mutation of ["edit", "add"] as const) {
  test(`startup captures again after a snippet ${mutation} during capture`, async (t) => {
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
    const { input, toasts } = recordingToasts(f.context);
    const hooks = await server.server(input);
    const current = config();
    current.command!.added = { template: "{{include?:new.md}}" };
    await hooks.config!(current);
    assert.equal(
      current.agent!.review!.prompt,
      mutation === "edit" ? "Review Changed" : "Review Startup",
    );
    assert.equal(
      current.command!.added.template,
      mutation === "edit" ? "" : "Changed",
    );
    assert.equal(toasts.length, 0);
  });
}

const editorSaves = {
  "replaces the file": async (path: string, text: string) => {
    const temporary = join(dirname(path), `.${basename(path)}.tmp`);
    await writeFile(temporary, text);
    await rename(temporary, path);
  },
  "deletes and recreates the file": async (path: string) => {
    await rm(path);
  },
} as const;

for (const [style, save] of Object.entries(editorSaves)) {
  test(`startup reads a snippet again when an editor that ${style} saves it during capture`, async (t) => {
    const f = await fixture(t);
    const body = join(f.directory, "body.md");
    await writeFile(body, "Startup");
    const canonicalBody = await fs.realpath(body);
    const open = fs.open;
    let saved = false;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
      if (saved || args[0] !== canonicalBody) {
        return open(...args);
      }
      saved = true;
      // The save lands after the snippet was checked and before it is opened.
      await save(body, "Saved");
      try {
        return await open(...args);
      } finally {
        await writeFile(body, "Saved");
      }
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    const { input, toasts } = recordingToasts(f.context);
    const hooks = await server.server(input);
    const current = config();
    await hooks.config!(current);
    assert.ok(saved, "the save happened during capture");
    assert.equal(current.agent!.review!.prompt, "Review Saved");
    const output = skill("{{include:body.md}}");
    await hooks["tool.execute.after"]!(skillInput, output);
    assert.equal(output.output, skill("Saved").output);
    const reloaded = config();
    await (
      await server.server(input)
    ).config!(reloaded);
    assert.equal(reloaded.agent!.review!.prompt, "Review Saved");
    assert.equal(toasts.length, 0);
  });
}

test("a snippet replaced on every read is left out with restart advice", async (t) => {
  const f = await fixture(t);
  const body = join(f.directory, "body.md");
  await writeFile(body, "Startup");
  const canonicalBody = await fs.realpath(body);
  const open = fs.open;
  let saves = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    if (args[0] === canonicalBody) {
      await editorSaves["replaces the file"](body, `Saved ${++saves}`);
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { input, toasts } = recordingToasts(f.context);
  const hooks = await server.server(input);
  const current = config();
  await hooks.config!(current);
  assert.equal(current.agent!.review!.prompt, "Review ");
  assert.equal(toasts.length, 1);
  const { message } = toasts[0].body;
  assert.match(
    message,
    /A prompt snippet kept changing while loading\. Restart OpenCode once edits settle\./,
  );
  assert.match(
    message,
    /Prompt files could not be confirmed unchanged after 3 reads/,
  );
  assert.doesNotMatch(message, /Try again/);
});

test("a snippet replaced whenever its read is confirmed keeps the latest read with restart advice", async (t) => {
  const f = await fixture(t);
  const body = join(f.directory, "body.md");
  await writeFile(body, "Startup");
  const canonicalBody = await fs.realpath(body);
  const open = fs.open;
  let opens = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    // Each capture attempt opens the snippet once to read it and once to confirm it.
    if (args[0] === canonicalBody && ++opens % 2 === 0) {
      await editorSaves["replaces the file"](body, `Saved ${opens}`);
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { input, toasts } = recordingToasts(f.context);
  const hooks = await server.server(input);
  const current = config();
  await hooks.config!(current);
  assert.equal(current.agent!.review!.prompt, "Review Saved 4");
  assert.equal(toasts.length, 1);
  assert.match(
    toasts[0].body.message,
    /^Prompt files could not be confirmed unchanged after 3 reads, so the latest reads are used\. Restart OpenCode once edits settle\. A prompt source changed while loading\. Source: /,
  );
  assert.doesNotMatch(toasts[0].body.message, /Try again/);
});

test("startup publishes the latest reads with a warning when snippets keep changing during capture", async (t) => {
  const f = await fixture(t);
  const body = join(f.directory, "body.md");
  await writeFile(body, "Startup");
  const canonicalBody = await fs.realpath(body);
  const open = fs.open;
  let edits = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const file = await open(...args);
    if (args[0] === canonicalBody) {
      const close = file.close.bind(file);
      t.mock.method(file, "close", async () => {
        await close();
        await writeFile(body, `Changed ${++edits}`);
      });
    }
    return file;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { input, toasts } = recordingToasts(f.context);
  const hooks = await server.server(input);
  const current = config();
  await hooks.config!(current);
  assert.match(current.agent!.review!.prompt!, /^Review Changed \d+$/);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].body.variant, "warning");
  assert.match(
    toasts[0].body.message,
    /^Prompt files could not be confirmed unchanged after 3 reads, so the latest reads are used\. Restart OpenCode once edits settle\. Prompt input changed: .*[^.]\.$/,
  );
});

for (const [from, to] of [
  ["file", "directory"],
  ["directory", "file"],
] as const) {
  test(`startup publishes the current sibling when a ${from} is replaced by a ${to} while discovery walks an earlier directory`, async (t) => {
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
    // Discovery may look up b.md before walking a/; capture then sees the
    // change and captures again rather than publishing the stale result.
    await hooks.config!(current);
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
import { opencode } from ${JSON.stringify(new URL("../src/host.ts", import.meta.url).href)};
import { createServer } from ${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)};
const server = createServer(opencode);
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

test(
  "many ignored entries do not hide which prompt lost an include",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const outside = join(f.root, "outside.md");
    await writeFile(outside, "Outside");
    for (let index = 0; index < 10; index++) {
      await symlink(
        outside,
        join(f.directory, `a-long-link-name-to-fill-the-toast-${index}.md`),
      );
    }
    const { input, toasts } = recordingToasts(f.context);
    const hooks = await server.server(input);
    const current: Config = {
      agent: { review: { prompt: "Review {{include:missing.md}}" } },
    };
    await hooks.config!(current);
    assert.equal(current.agent!.review!.prompt, "Review ");
    assert.equal(toasts.length, 1);
    assert.match(
      toasts[0].body.message,
      /^Some includes were not expanded in agent "review"\. Prompt "missing\.md" does not exist/,
    );
    assert.match(toasts[0].body.message, /See the OpenCode log for 9 more\./);
  },
);
