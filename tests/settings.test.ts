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

test("settings failures identify their source, position and original reason without body text", () => {
  const path = "/settings/project.jsonc";
  for (const [text, reason, position] of [
    ['{\r\n  "defaults": @\r\n}', /InvalidSymbol/, /:2:15/],
    ['{\n  "agents": {},\n  "agents": {}\n}', /Duplicate JSON keys/, /:3:3/],
    [
      '{\n  "defaults": {"append": 42}\n}',
      /\/defaults\/append must be array/,
      /:2:26/,
    ],
  ] as const) {
    assert.throws(
      () => parseSettings(text, path),
      (error: Error) => {
        assert.ok(error.message.includes(path));
        assert.match(error.message, reason);
        assert.match(error.message, position);
        assert.ok(!error.message.includes(text));
        return true;
      },
    );
  }
  assert.throws(() => parseSettings('{"defaults":{"append":42}}'));
  assert.throws(
    () => parseSettings("{ @ }"),
    (error: Error) => {
      assert.match(error.message, /InvalidSymbol/);
      assert.doesNotMatch(error.message, /must be array/);
      return true;
    },
  );
});

test("loading two settings sources identifies the bad file, including candidate overlays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-error-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = join(root, "config/opencode");
  const project = join(root, ".opencode");
  await mkdir(shared, { recursive: true });
  await mkdir(project);
  const bad = join(shared, "prompt-composer.jsonc");
  await writeFile(bad, "{ @ }");
  await writeFile(join(project, "prompt-composer.jsonc"), "{}");
  const env = {
    XDG_CONFIG_HOME: join(root, "config"),
    OPENCODE_TEST_HOME: root,
  };
  await assert.rejects(
    loadSettings({ root }, new Map(), env),
    (error: Error) => {
      assert.ok(error.message.includes(JSON.stringify(bad)));
      return true;
    },
  );
  await writeFile(bad, "{}");
  await assert.rejects(
    loadSettings({ root }, new Map([[bad, "{ @ }"]]), env),
    (error: Error) => {
      assert.ok(error.message.includes(JSON.stringify(bad)));
      return true;
    },
  );
});

test("schema pointers preserve escaped and numeric keys and locate the failing array item", () => {
  assert.throws(
    () =>
      parseSettings(
        '{"agents":{"0/a~b":{"append":["private",42]}}}',
        "settings.jsonc",
      ),
    (error: Error) => {
      assert.match(
        error.message,
        /\/agents\/0~1a~0b\/append\/1 must be string/,
      );
      assert.match(error.message, /:1:41/);
      assert.doesNotMatch(error.message, /private/);
      return true;
    },
  );
});

test("on-disk source validation keeps the failing settings pathname", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-invalid-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode"));
  const path = join(root, ".opencode/prompt-composer.jsonc");
  const env = {
    OPENCODE_TEST_HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
  };
  for (const [text, reason] of [
    ["PRIVATE\0BODY", /NUL bytes/],
    ["x".repeat(1024 * 1024 + 1), /size limit/],
  ] as const) {
    await writeFile(path, text);
    await assert.rejects(
      loadSettings({ root }, new Map(), env),
      (error: Error) => {
        assert.match(error.message, reason);
        assert.ok(error.message.includes(JSON.stringify(path)));
        assert.doesNotMatch(error.message, /PRIVATE|BODY/);
        return true;
      },
    );
  }
});
