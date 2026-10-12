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
