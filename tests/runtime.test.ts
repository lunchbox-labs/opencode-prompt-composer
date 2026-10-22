import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type TestContext, test } from "node:test";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import { discoverPrompts } from "../src/discovery.ts";
import { compose } from "../src/runtime.ts";
import server from "../src/server.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode/prompts"), { recursive: true });
  return { root, context: { directory: root, worktree: root } };
}

test("native bodies expand explicit includes without settings or metadata changes", async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(join(root, ".opencode/prompts/body.md"), "  Evidence\n");
  const native: Config = {
    agent: {
      review: {
        prompt: "Before\n\n{{include:body.md}}\n\nAfter",
        temperature: 0.2,
        description: "Reviewer",
      },
    },
    command: {
      check: {
        template: "{{include:body.md}} $ARGUMENTS $1 @file !`pwd`",
        agent: "review",
        subtask: true,
      },
    },
  };
  const before = structuredClone(native);
  const hooks = await server.server(context as PluginInput);
  await hooks.config!(native);
  assert.deepEqual(native, {
    agent: {
      review: {
        ...before.agent!.review,
        prompt: "Before\n\nEvidence\n\nAfter",
      },
    },
    command: {
      check: {
        ...before.command!.check,
        template: "Evidence $ARGUMENTS $1 @file !`pwd`",
      },
    },
  });
});

test("obsolete policy files are ignored even when malformed, unsafe or non-files", async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(join(root, ".opencode/prompts/body.md"), "Evidence");
  const path = join(root, ".opencode/prompt-composer.jsonc");
  const hooks = await server.server(context as PluginInput);
  for (const text of [
    "{ invalid",
    JSON.stringify({
      defaults: { prepend: ["Obsolete"] },
      agents: { missing: { append: ["{{include:../secret.md}}"] } },
    }),
    "\0".repeat(1024 * 1024 + 1),
  ]) {
    await writeFile(path, text);
    const config: Config = {
      agent: { review: { prompt: "{{include:body.md}}" } },
    };
    await hooks.config!(config);
    assert.equal(config.agent!.review!.prompt, "Evidence");
  }
  await rm(path);
  await mkdir(path);
  const config: Config = {
    agent: { review: { prompt: "{{include:body.md}}" } },
  };
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "Evidence");
});

test("disabled, absent and blank native prompts retain host fallback", async (t) => {
  const { context } = await fixture(t);
  const hooks = await server.server(context as PluginInput);
  const config: Config = {
    agent: {
      disabled: { disable: true, prompt: "{{include:missing.md}}" },
      absent: {},
      empty: { prompt: "" },
      blank: { prompt: " \n\t" },
    },
  };
  const before = structuredClone(config);
  await hooks.config!(config);
  assert.deepEqual(config, before);
});

test("marker-free native bodies above the include budget are preserved", async (t) => {
  const { context } = await fixture(t);
  const hooks = await server.server(context as PluginInput);
  const body = "x".repeat(262145);
  const config: Config = {
    agent: { review: { prompt: body } },
    command: { check: { template: body } },
  };
  const before = structuredClone(config);
  await hooks.config!(config);
  assert.deepEqual(config, before);
});

test("failed config composition publishes no partial bodies and can retry from originals", async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(join(root, ".opencode/prompts/body.md"), "First");
  const hooks = await server.server(context as PluginInput);
  const config: Config = {
    agent: { review: { prompt: "{{include:body.md}}" } },
    command: { check: { template: "{{include:missing.md}}" } },
  };
  const before = structuredClone(config);
  await assert.rejects(hooks.config!(config), /does not exist/);
  assert.deepEqual(config, before);
  await writeFile(join(root, ".opencode/prompts/missing.md"), "Command");
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "First");
  assert.equal(config.command!.check.template, "Command");
  const applied = structuredClone(config);
  await writeFile(join(root, ".opencode/prompts/body.md"), "Second");
  await rm(join(root, ".opencode/prompts/missing.md"));
  await assert.rejects(hooks.config!(config), /does not exist/);
  assert.deepEqual(config, applied);
  await writeFile(join(root, ".opencode/prompts/missing.md"), "Restored");
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "Second");
  assert.equal(config.command!.check.template, "Restored");
});

test("config hook reloads native commands and agents without duplicate expansion or metadata loss", async (t) => {
  const { root } = await fixture(t);
  const snippet = join(root, ".opencode/prompts/body.md");
  await writeFile(snippet, "First");
  const hooks = await server.server({
    directory: root,
    worktree: root,
  } as PluginInput);
  const config: Config = {
    agent: { review: { prompt: "Review {{include:body.md}}" } },
    command: {
      review: {
        template: "Command {{include:body.md}} \\{{include:literal.md}}",
        agent: "review",
        description: "Original",
        subtask: true,
      },
    },
  };
  await hooks.config!(config);
  assert.equal(
    config.command!.review.template,
    "Command First {{include:literal.md}}",
  );
  config.command!.review.description = "External edit";
  await writeFile(snippet, "Second");
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "Review Second");
  assert.equal(
    config.command!.review.template,
    "Command Second {{include:literal.md}}",
  );
  assert.equal(config.command!.review.description, "External edit");
  assert.equal(config.command!.review.subtask, true);
  config.agent!.review!.prompt = "External body";
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "External body");
});

test("skills expand on demand and reject truncated bodies without touching unrelated tools", async (t) => {
  const { root } = await fixture(t);
  await writeFile(join(root, ".opencode/prompts/body.md"), "Skill evidence");
  const hooks = await server.server({
    directory: root,
    worktree: root,
  } as PluginInput);
  const output = {
    title: "skill",
    output: "{{include:body.md}}",
    metadata: {},
  };
  await hooks["tool.execute.after"]!(
    { tool: "read", sessionID: "s", callID: "c", args: {} },
    output,
  );
  assert.equal(output.output, "{{include:body.md}}");
  await hooks["tool.execute.after"]!(
    { tool: "skill", sessionID: "s", callID: "c", args: {} },
    output,
  );
  assert.equal(output.output, "Skill evidence");
  await assert.rejects(
    hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: "s", callID: "c", args: {} },
      { ...output, metadata: { truncated: true } },
    ),
    /truncated/,
  );
});

test("include failures identify consumers and logical cycles without native paths or prompt bodies", async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(
    join(root, ".opencode/prompts/a.md"),
    "SECRET A {{include:b.md}}",
  );
  await writeFile(
    join(root, ".opencode/prompts/b.md"),
    "SECRET B {{include:a.md}}",
  );
  const inventory = await discoverPrompts(context);
  for (const [native, consumer] of [
    [
      { agent: { review: { prompt: "SECRET {{include:a.md}}" } } },
      'agent "review"',
    ],
    [
      { command: { check: { template: "SECRET {{include:a.md}}" } } },
      'command "check"',
    ],
  ] as const) {
    await assert.rejects(compose(native, inventory), (error: Error) => {
      assert.match(error.message, /cycle/);
      assert.ok(error.message.includes(consumer));
      assert.match(error.message, /a\.md.* -> .*b\.md.* -> .*a\.md/);
      assert.doesNotMatch(error.message, /SECRET|agents\/|commands\//);
      return true;
    });
  }
});

test("skill failures have honest consumer context", async (t) => {
  const { root } = await fixture(t);
  const hooks = await server.server({
    directory: root,
    worktree: root,
  } as PluginInput);
  await assert.rejects(
    hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: "s", callID: "c", args: { name: "review" } },
      {
        title: "skill",
        output: "PRIVATE {{include:missing.md}}",
        metadata: {},
      },
    ),
    (error: Error) => {
      assert.match(error.message, /skill output.*source file unavailable/);
      assert.doesNotMatch(error.message, /PRIVATE|SKILL\.md/);
      return true;
    },
  );
});

test("config composition preserves plugin registration without publishing editor state", async (t) => {
  const { root } = await fixture(t);
  const hooks = await server.server({
    directory: root,
    worktree: root,
  } as PluginInput);
  const config: Config = {
    plugin: ["@lunchbox-labs/opencode-prompt-composer"],
    agent: { review: { prompt: "Text" } },
  };
  const registration = structuredClone(config.plugin);
  await hooks.config!(config);
  assert.deepEqual(config.plugin, registration);
});

test("removed editor reload tokens are not accepted as plugin options", async (t) => {
  const { root } = await fixture(t);
  assert.throws(
    () =>
      server.server({ directory: root, worktree: root } as PluginInput, {
        reloadToken: "old-editor-token",
      }),
    /does not accept plugin options/,
  );
});
