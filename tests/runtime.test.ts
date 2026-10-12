import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type TestContext, test } from "node:test";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import { loadSettings } from "../src/settings.ts";
import { compose } from "../src/runtime.ts";
import server from "../src/server.ts";

async function fixture(t: TestContext, settings: unknown) {
  const root = await mkdtemp(join(tmpdir(), "prompt-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode/prompts"), { recursive: true });
  await writeFile(
    join(root, ".opencode/prompt-composer.jsonc"),
    JSON.stringify(settings),
  );
  return { root, context: { root } };
}

test("native bodies compose defaults and agent fragments without modifying native metadata", async (t) => {
  const { context } = await fixture(t, {
    defaults: { prepend: ["Default before"], append: ["Default after"] },
    agents: {
      review: { prepend: ["Agent before"], append: ["Agent after"] },
      lead: { inheritDefaults: false, append: ["Lead after"] },
    },
  });
  const native: Config = {
    agent: {
      review: { prompt: "Review", temperature: 0.2 },
      lead: { prompt: "Lead" },
      build: {},
    },
  };
  const before = structuredClone(native);
  const result = await compose(native, await loadSettings(context));
  assert.equal(
    result.config.agent?.review?.prompt,
    "Default before\n\nAgent before\n\nReview\n\nDefault after\n\nAgent after",
  );
  assert.equal(result.config.agent.lead?.prompt, "Lead\n\nLead after");
  assert.equal(result.config.agent.build?.prompt, undefined);
  assert.equal(result.config.agent.review.temperature, 0.2);
  assert.deepEqual(native, before);
  assert.deepEqual(result.diagnostics, []);
});

test("missing agents are diagnostic while unsafe inactive fragments remain fatal (#78)", async (t) => {
  const { context } = await fixture(t, {
    agents: { absent: { append: ["Advice"] } },
  });
  const settings = await loadSettings(context);
  const result = await compose({ agent: {} }, settings);
  assert.equal(result.diagnostics[0].kind, "agent");
  settings.effective.agents!.absent.append = ["{{include:../secret.md}}"];
  await assert.rejects(compose({ agent: {} }, settings), /safe relative/);
});

test("named rules report skipped meaningful additions while preserving native fallback", async (t) => {
  for (const prompt of [undefined, "", " \n\t"]) {
    const { context } = await fixture(t, {
      defaults: { prepend: ["Default guidance"] },
      agents: {
        build: { append: ["Build guidance"] },
        plan: {},
        review: { inheritDefaults: false, prepend: ["Review guidance"] },
      },
    });
    const native: Config = {
      agent: {
        build: {
          ...(prompt === undefined ? {} : { prompt }),
          temperature: 0.2,
        },
        plan: { prompt },
        review: { prompt, description: "Reviewer" },
        unnamed: { prompt },
      },
      command: { check: { template: "Check", agent: "build" } },
    };
    const before = structuredClone(native);
    const result = await compose(native, await loadSettings(context));
    assert.deepEqual(result.config, before);
    assert.deepEqual(native, before);
    assert.deepEqual(
      result.diagnostics.map((item) => item.name),
      ["build", "plan", "review"],
    );
    for (const notice of result.diagnostics) {
      assert.equal(notice.kind, "agent");
      assert.match(notice.message, /skipped.*native fallback/i);
    }
  }
});

test("empty effective additions and defaults opt-out do not produce fallback notices", async (t) => {
  const { root, context } = await fixture(t, {
    agents: {
      absent: {},
      empty: { prepend: [], append: ["", " \n\t"] },
      included: { append: ["{{include:empty.md}}"] },
      optedOut: { inheritDefaults: false },
    },
  });
  await writeFile(join(root, ".opencode/prompts/empty.md"), " \n");
  const settings = await loadSettings(context);
  const native: Config = {
    agent: { absent: {}, empty: {}, included: {}, optedOut: {} },
  };
  assert.deepEqual((await compose(native, settings)).diagnostics, []);
  settings.effective.defaults = { append: ["Default guidance"] };
  assert.deepEqual(
    (
      await compose(
        { agent: { optedOut: {}, unnamed: {} } },
        {
          ...settings,
          effective: {
            defaults: settings.effective.defaults,
            agents: {
              optedOut: {
                inheritDefaults: false,
                append: ["{{include:empty.md}}"],
              },
            },
          },
        },
      )
    ).diagnostics,
    [],
  );
  const result = await compose(
    native,
    await loadSettings(context),
    new Map([[join(root, ".opencode/prompts/empty.md"), "Preview guidance"]]),
  );
  assert.deepEqual(
    result.diagnostics.map((item) => item.name),
    ["included"],
  );
});

test("missing and disabled notices remain distinct and skipped unsafe fragments stay fatal", async (t) => {
  const { context } = await fixture(t, {
    agents: {
      missing: {},
      disabled: { append: ["Advice"] },
      build: { inheritDefaults: false },
    },
  });
  const native: Config = { agent: { disabled: { disable: true }, build: {} } };
  const settings = await loadSettings(context);
  const result = await compose(native, settings);
  assert.deepEqual(
    result.diagnostics,
    ["missing", "disabled"].map((name) => ({
      kind: "agent",
      name,
      message: `Agent ${name} is missing or disabled; its prompt operations were skipped.`,
    })),
  );
  for (const name of ["missing", "disabled", "build"]) {
    const unsafe = structuredClone(settings.effective);
    unsafe.agents![name].append = ["Advice", "{{include:../secret.md}}"];
    await assert.rejects(
      compose(native, { ...settings, effective: unsafe }),
      /safe relative/,
    );
  }
  settings.effective.defaults = { append: ["{{include:../secret.md}}"] };
  await assert.rejects(compose(native, settings), /safe relative/);
});

test("config hook reloads native commands and agents without duplicate expansion or metadata loss", async (t) => {
  const { root } = await fixture(t, {
    defaults: { append: ["After"] },
  });
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
  assert.equal(config.agent!.review!.prompt, "Review Second\n\nAfter");
  assert.equal(
    config.command!.review.template,
    "Command Second {{include:literal.md}}",
  );
  assert.equal(config.command!.review.description, "External edit");
  assert.equal(config.command!.review.subtask, true);
  config.agent!.review!.prompt = "External body";
  await hooks.config!(config);
  assert.equal(config.agent!.review!.prompt, "External body\n\nAfter");
});

test("skills expand on demand and reject truncated bodies without touching unrelated tools", async (t) => {
  const { root } = await fixture(t, {});
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
  const { root, context } = await fixture(t, {});
  await writeFile(
    join(root, ".opencode/prompts/a.md"),
    "SECRET A {{include:b.md}}",
  );
  await writeFile(
    join(root, ".opencode/prompts/b.md"),
    "SECRET B {{include:a.md}}",
  );
  const settings = await loadSettings(context);
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
    await assert.rejects(compose(native, settings), (error: Error) => {
      assert.match(error.message, /cycle/);
      assert.ok(error.message.includes(consumer));
      assert.match(error.message, /a\.md.* -> .*b\.md.* -> .*a\.md/);
      assert.doesNotMatch(error.message, /SECRET|agents\/|commands\//);
      return true;
    });
  }
});

test("inactive settings fragments and skill output have honest consumer context", async (t) => {
  const { root, context } = await fixture(t, {
    agents: { absent: { append: ["{{include:missing.md}}"] } },
  });
  await assert.rejects(
    compose({}, await loadSettings(context)),
    (error: Error) => {
      assert.ok(
        error.message.includes(
          JSON.stringify(join(root, ".opencode/prompt-composer.jsonc")),
        ),
      );
      assert.match(error.message, /\/agents\/absent\/append\/0/);
      assert.match(error.message, /does not exist/);
      return true;
    },
  );
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
