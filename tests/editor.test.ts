import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { loadSettings } from "../src/settings.ts";
import { editSetting, planEdits, savePlan } from "../src/editor.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-editor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode/prompts"), { recursive: true });
  const path = join(root, ".opencode/prompt-composer.jsonc");
  await writeFile(
    path,
    "// Keep this comment\n" +
      JSON.stringify(
        {
          agents: { review: { prepend: ["Findings"] } },
        },
        null,
        2,
      ),
  );
  return {
    path,
    root,
    settings: await loadSettings({ root }),
    native: { agent: { review: { prompt: "Review" } } },
  };
}

test("preview edits preserve JSONC and save only after explicit validation", async (t) => {
  const f = await fixture(t);
  const text = editSetting(
    f.settings.documents[0].text,
    ["agents", "review", "append"],
    ["After"],
  );
  const plan = await planEdits(f.settings, f.native, [{ path: f.path, text }]);
  assert.equal(
    plan.preview.config.agent?.review?.prompt,
    "Findings\n\nReview\n\nAfter",
  );
  assert.doesNotMatch(await readFile(f.path, "utf8"), /After/);
  await savePlan(plan);
  assert.match(await readFile(f.path, "utf8"), /^\/\/ Keep this comment/);
  assert.match(await readFile(f.path, "utf8"), /After/);
  await assert.rejects(savePlan(plan), /changed|stale/);
});

test("changed include dependencies invalidate saves and leave authored settings untouched", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, ".opencode/prompts/body.md"), "Before");
  f.settings = await loadSettings(f.settings.context);
  const original = await readFile(f.path, "utf8");
  const plan = await planEdits(f.settings, f.native, [
    {
      path: f.path,
      text: editSetting(
        original,
        ["agents", "review", "append"],
        ["{{include:body.md}}"],
      ),
    },
  ]);
  await writeFile(join(f.root, ".opencode/prompts/body.md"), "Concurrent edit");
  await assert.rejects(savePlan(plan), /changed|stale/);
  assert.equal(await readFile(f.path, "utf8"), original);
});

test("a newly discovered prompt invalidates an outstanding preview", async (t) => {
  const f = await fixture(t);
  const plan = await planEdits(f.settings, f.native, [
    {
      path: f.path,
      text: editSetting(f.settings.documents[0].text, ["defaults"], {
        append: ["After"],
      }),
    },
  ]);
  await writeFile(join(f.root, ".opencode/prompts/new.md"), "New");
  await assert.rejects(savePlan(plan), /discovery changed/);
});
