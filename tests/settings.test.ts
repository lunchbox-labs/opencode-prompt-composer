import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { loadSettings, parseSettings } from "../src/settings.ts";

test("JSONC accepts only defaults and agent operations; rejects removed mappings and duplicate keys", () => {
  assert.deepEqual(
    parseSettings(
      '{ // comment\n "agents": {"review": {"append": ["Review"]}}, }',
    ).agents,
    { review: { append: ["Review"] } },
  );
  for (const value of [
    '{"defaults":{"append":"text"}}',
    '{"models":{}}',
    '{"agents":{},"agents":{}}',
    '{"groups":{}}',
    '{"prompts":{}}',
    '{"sourceDirectories":{}}',
    '{"imports":[]}',
    '{"agents":{"review":{"inheritDefaults":1}}}',
  ]) {
    assert.throws(() => parseSettings(value));
  }
});

test("settings follow discovery precedence, merge fields, and replace ordered arrays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = join(root, "config/opencode");
  const project = join(root, "project");
  await mkdir(shared, { recursive: true });
  await mkdir(join(project, ".opencode"), { recursive: true });
  await writeFile(
    join(shared, "prompt-composer.jsonc"),
    JSON.stringify({
      defaults: { prepend: ["Shared before"], append: ["Shared after"] },
      agents: { review: { append: ["Shared agent"], inheritDefaults: false } },
    }),
  );
  await writeFile(
    join(project, ".opencode/prompt-composer.jsonc"),
    JSON.stringify({
      defaults: { append: ["Project after"] },
      agents: { review: { append: ["Project agent"] } },
    }),
  );
  const settings = await loadSettings({ root: project }, new Map(), {
    XDG_CONFIG_HOME: join(root, "config"),
    OPENCODE_TEST_HOME: root,
  });
  assert.deepEqual(settings.effective, {
    defaults: { prepend: ["Shared before"], append: ["Project after"] },
    agents: { review: { append: ["Project agent"], inheritDefaults: false } },
  });
});

test("empty installation needs no settings file and invalid JSONC fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    XDG_CONFIG_HOME: join(root, "config"),
    OPENCODE_TEST_HOME: root,
  };
  assert.equal(
    (await loadSettings({ root }, new Map(), env)).documents.length,
    0,
  );
  await mkdir(join(root, ".opencode"));
  await writeFile(join(root, ".opencode/prompt-composer.jsonc"), "{ invalid");
  await assert.rejects(
    loadSettings({ root }, new Map(), env),
    /Invalid prompt settings/,
  );
});
