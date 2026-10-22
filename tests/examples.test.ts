import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { discoverPrompts } from "../src/discovery.ts";
import { compose } from "../src/runtime.ts";

test("review example authors its complete guidance in the original order", async () => {
  const root = resolve("docs/examples/review");
  const source = await readFile(
    resolve(root, ".opencode/agents/review.md"),
    "utf8",
  );
  const body = source.slice(source.indexOf("\n---\n") + 5).trim();
  const inventory = await discoverPrompts(
    { directory: root, worktree: root },
    {
      XDG_CONFIG_HOME: resolve("docs/examples/empty-config"),
      OPENCODE_TEST_HOME: resolve("docs/examples/empty-home"),
    },
  );
  const result = await compose(
    { agent: { review: { prompt: body } } },
    inventory,
  );
  assert.equal(
    result.config.agent!.review!.prompt,
    [
      "Prioritize correctness, compatibility and maintainability. Read the relevant implementation before drawing conclusions.",
      "Review the supplied diff and relevant surrounding code.\nFor each finding, identify the affected file, explain the observable failure and propose a focused correction. Include evidence and a reproduction when practical. If no actionable findings remain, say so.",
      "Distinguish observed behavior from assumptions.",
      "Prefer a short list of actionable findings.",
    ].join("\n\n"),
  );
});
