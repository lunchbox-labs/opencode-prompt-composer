import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type TestContext, test } from "node:test";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import { discoverPrompts } from "../src/discovery.ts";
import { expandIncludes } from "../src/includes.ts";
import { compose } from "../src/runtime.ts";
import server from "../src/server.ts";
import { recordingToasts } from "./toasts.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode/prompts"), { recursive: true });
  return { root, context: { directory: root, worktree: root } };
}

function skillOutput(
  body: string,
  name = "evidence",
  dir = "/skills/evidence",
) {
  return {
    title: `Loaded skill: ${name}`,
    metadata: { name, dir },
    output: [
      `<skill_content name="${name}">`,
      `# Skill: ${name}`,
      "",
      body,
      "",
      `Base directory for this skill: ${dir}`,
      "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
      "Note: file list is sampled.",
      "",
      "<skill_files>",
      `<file>${dir}/{{include:file.md}}</file>`,
      "</skill_files>",
      "</skill_content>",
    ].join("\n"),
  };
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

test("a failing include is left out of its consumer while every other consumer composes", async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(join(root, ".opencode/prompts/body.md"), "First");
  await writeFile(join(root, ".opencode/prompts/command.md"), "Command");
  const hooks = await server.server(context as PluginInput);
  const config: Config = {
    agent: { review: { prompt: "{{include:body.md}}" } },
    command: { check: { template: "Check [{{include:missing.md}}]" } },
  };
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "First");
  assert.equal(config.command!.check.template, "Check []");
  await writeFile(
    join(root, ".opencode/prompts/missing.md"),
    "Added after startup",
  );
  await hooks.config!(config);
  assert.equal(
    config.command!.check.template,
    "Check []",
    "snippets added after startup stay absent until restart",
  );
  config.command!.check.template = "{{include:command.md}}";
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "First");
  assert.equal(config.command!.check.template, "Command");
  const applied = structuredClone(config);
  await writeFile(join(root, ".opencode/prompts/body.md"), "Second");
  await rm(join(root, ".opencode/prompts/command.md"));
  await hooks.config!(config);
  assert.deepEqual(config, applied);
});

test("config hook reuses startup snippets without duplicate expansion or metadata loss", async (t) => {
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
  assert.equal(config.agent!.review!.prompt, "Review First");
  assert.equal(
    config.command!.review.template,
    "Command First {{include:literal.md}}",
  );
  assert.equal(config.command!.review.description, "External edit");
  assert.equal(config.command!.review.subtask, true);
  config.agent!.review!.prompt = "External body";
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "External body");
});

test("skills expand on demand and keep truncated bodies without touching unrelated tools", async (t) => {
  const { root } = await fixture(t);
  await writeFile(
    join(root, ".opencode/prompts/body.md"),
    "Skill {{include:nested.txt}}",
  );
  await writeFile(join(root, ".opencode/prompts/nested.txt"), "evidence");
  const hooks = await server.server({
    directory: root,
    worktree: root,
  } as PluginInput);
  const body = "Before\n{{include:body.md}}\n\\{{include:literal.md}}\nAfter";
  const output = skillOutput(
    body,
    "{{include:name.md}}",
    "/skills/{{include:directory.md}}",
  );
  const before = structuredClone(output);
  await hooks["tool.execute.after"]!(
    { tool: "read", sessionID: "s", callID: "c", args: {} },
    output,
  );
  assert.deepEqual(output, before);
  await hooks["tool.execute.after"]!(
    { tool: "skill", sessionID: "s", callID: "c", args: {} },
    output,
  );
  assert.deepEqual(output, {
    ...before,
    output: before.output.replace(
      body,
      "Before\nSkill evidence\n{{include:literal.md}}\nAfter",
    ),
  });
  const truncated = { ...before, metadata: { truncated: true } };
  await hooks["tool.execute.after"]!(
    { tool: "skill", sessionID: "s", callID: "c", args: {} },
    truncated,
  );
  assert.equal(truncated.output, before.output);
});

test("wrapper-only markers stay literal and unknown skill output passes through unchanged", async (t) => {
  const { context } = await fixture(t);
  const hooks = await server.server(context as PluginInput);
  const input = { tool: "skill", sessionID: "s", callID: "c", args: {} };
  const wrapperOnly = skillOutput("Ordinary body", "customize-opencode", ".");
  const before = structuredClone(wrapperOnly);
  await hooks["tool.execute.after"]!(input, wrapperOnly);
  assert.deepEqual(wrapperOnly, before);
  const unknown = {
    ...skillOutput("Unused"),
    output: "PRIVATE {{include:missing.md}}",
  };
  await hooks["tool.execute.after"]!(input, unknown);
  assert.equal(unknown.output, "PRIVATE {{include:missing.md}}");
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
    const { config, incomplete } = await compose(native, (text, consumer) =>
      expandIncludes(text, inventory.files, undefined, consumer),
    );
    assert.deepEqual(config, native, "a consumer that fails keeps its text");
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].consumer, consumer);
    const [problem] = incomplete[0].problems;
    assert.match(problem, /cycle/);
    assert.ok(problem.includes(consumer));
    assert.match(problem, /a\.md.* -> .*b\.md.* -> .*a\.md/);
    assert.doesNotMatch(problem, /SECRET|agents\/|commands\//);
  }
});

test("a failing nested include leaves out only itself and reports the include chain", async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(
    join(root, ".opencode/prompts/body.md"),
    "Start {{include:missing.md}} end",
  );
  const { input, toasts } = recordingToasts(context);
  const hooks = await server.server(input);
  const config: Config = {
    agent: { review: { prompt: "[{{include:body.md}}]" } },
  };
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "[Start  end]");
  assert.equal(toasts.length, 1);
  assert.match(
    toasts[0].body.message,
    /"missing\.md" does not exist.*Consumer: agent "review"\. at "body\.md":1:7 Include chain: "body\.md" -> "missing\.md"\.$/,
  );
});

test("skill include failures warn with honest consumer context", async (t) => {
  const { context } = await fixture(t);
  const { input, toasts } = recordingToasts(context);
  const hooks = await server.server(input);
  const output = skillOutput("PRIVATE {{include:missing.md}}");
  const before = structuredClone(output);
  await hooks["tool.execute.after"]!(
    { tool: "skill", sessionID: "s", callID: "c", args: { name: "review" } },
    output,
  );
  assert.equal(
    output.output,
    before.output.replace("PRIVATE {{include:missing.md}}", "PRIVATE "),
  );
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].body.variant, "warning");
  const { message } = toasts[0].body;
  assert.match(
    message,
    /^Skill "evidence" has includes that were not expanded/,
  );
  assert.match(message, /skill output.*source file unavailable/);
  assert.doesNotMatch(message, /PRIVATE|SKILL\.md/);
});

test("a failing skill include is left out while valid includes still expand", async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(join(root, ".opencode/prompts/body.md"), "Expanded first");
  const { input, toasts } = recordingToasts(context);
  const hooks = await server.server(input);
  const output = skillOutput("{{include:body.md}} then {{include:missing.md}}");
  const before = structuredClone(output);
  await hooks["tool.execute.after"]!(
    { tool: "skill", sessionID: "s", callID: "c", args: {} },
    output,
  );
  assert.deepEqual(output, {
    ...before,
    output: before.output.replace(
      "{{include:body.md}} then {{include:missing.md}}",
      "Expanded first then ",
    ),
  });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].body.message, /"missing\.md" does not exist/);
});

test("truncated skill results pass through unchanged and warn only when they contain includes", async (t) => {
  const { context } = await fixture(t);
  const { input, toasts } = recordingToasts(context);
  const hooks = await server.server(input);
  for (const text of ["PRIVATE {{include:missing.md}}", "ordinary output"]) {
    const output = {
      ...skillOutput("Unused"),
      metadata: { truncated: true },
      output: text,
    };
    const before = structuredClone(output);
    await hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: "s", callID: "c", args: {} },
      output,
    );
    assert.deepEqual(output, before);
  }
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].body.variant, "warning");
  assert.match(toasts[0].body.message, /truncated.*includes were not expanded/);
  assert.doesNotMatch(toasts[0].body.message, /PRIVATE|missing\.md/);
});

test("unknown skill framing warns without exposing the native output", async (t) => {
  const { context } = await fixture(t);
  const notices: {
    body: { title: string; message: string; variant: string };
  }[] = [];
  const hooks = await server.server({
    ...context,
    client: {
      tui: {
        showToast: async (notice: (typeof notices)[number]) => {
          notices.push(notice);
        },
      },
    },
  } as unknown as PluginInput);
  const output = {
    ...skillOutput("Unused"),
    output: "PRIVATE {{include:missing.md}}",
  };
  const before = structuredClone(output);
  await hooks["tool.execute.after"]!(
    { tool: "skill", sessionID: "s", callID: "c", args: {} },
    output,
  );
  assert.deepEqual(output, before);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].body.title, "Prompt Composer");
  assert.match(notices[0].body.message, /framing.*includes were not expanded/);
  assert.doesNotMatch(notices[0].body.message, /PRIVATE|missing\.md/);
});

test("toast failures cannot prevent unknown skill output from passing through", async (t) => {
  const { context } = await fixture(t);
  for (const showToast of [
    () => {
      throw new Error("Toast unavailable");
    },
    () => Promise.reject(new Error("Toast unavailable")),
  ]) {
    const hooks = await server.server({
      ...context,
      client: { tui: { showToast } },
    } as unknown as PluginInput);
    const output = {
      ...skillOutput("Unused"),
      output: "PRIVATE {{include:missing.md}}",
    };
    const before = structuredClone(output);
    await hooks["tool.execute.after"]!(
      { tool: "skill", sessionID: "s", callID: "c", args: {} },
      output,
    );
    assert.deepEqual(output, before);
  }
});

test("config include failures show one warning toast naming every incomplete consumer", async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(join(root, ".opencode/prompts/body.md"), "Body");
  const { input, toasts } = recordingToasts(context);
  const hooks = await server.server(input);
  const config: Config = {
    agent: {
      review: { prompt: "Review {{include:missing.md}}" },
      plan: { prompt: "Plan {{include:body.md}}" },
    },
    command: {
      check: {
        template: "Check {{include:../outside.md}} {{include:body.md}}",
      },
    },
  };
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "Review ");
  assert.equal(config.agent!.plan!.prompt, "Plan Body");
  assert.equal(config.command!.check.template, "Check  Body");
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].body.title, "Prompt Composer");
  assert.equal(toasts[0].body.variant, "warning");
  assert.match(
    toasts[0].body.message,
    /^Some includes were not expanded in agent "review", command "check"\. .*"missing\.md" does not exist.* 1 more problem not shown\.$/,
  );

  for (const showToast of [
    () => {
      throw new Error("Toast unavailable");
    },
    () => Promise.reject(new Error("Toast unavailable")),
  ]) {
    const quiet = await server.server({
      ...context,
      client: { tui: { showToast } },
    } as unknown as PluginInput);
    const current: Config = {
      agent: { review: { prompt: "Review {{include:missing.md}}" } },
    };
    await quiet.config!(current);
    assert.equal(current.agent!.review!.prompt, "Review ");
  }
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

test("plugin options are ignored with one warning on the first config hook", async (t) => {
  const { root, context } = await fixture(t);
  await writeFile(join(root, ".opencode/prompts/body.md"), "Body");
  const { input, toasts } = recordingToasts(context);
  const hooks = await server.server(input, {
    reloadToken: "old-editor-token",
    extra: true,
  });
  for (let load = 0; load < 2; load++) {
    const config: Config = {
      agent: { review: { prompt: "{{include:body.md}}" } },
    };
    await hooks.config!(config);
    assert.equal(config.agent!.review!.prompt, "Body");
  }
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].body.variant, "warning");
  assert.equal(
    toasts[0].body.message,
    'Plugin options are not supported and were ignored: "reloadToken", "extra".',
  );
  assert.doesNotMatch(toasts[0].body.message, /old-editor-token/);
});
