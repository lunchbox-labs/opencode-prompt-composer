import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { discoverPrompts } from "../src/discovery.ts";
import { expandIncludes } from "../src/includes.ts";
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
    (text, consumer) =>
      expandIncludes(text, inventory.files, undefined, consumer),
  );
  const [context, findings] = await Promise.all(
    ["context", "findings"].map((name) =>
      readFile(resolve(root, `.opencode/prompts/review/${name}.md`), "utf8"),
    ),
  );
  // Keep the authored prose live while independently specifying each insertion
  // site. Comparing the complete body protects ordering and surrounding text.
  // Without a personal snippet in any prompts directory, its hook adds nothing.
  assert.ok(body.includes("{{include:review/context.md}}"));
  assert.ok(body.includes("{{include:review/findings.md}}"));
  assert.ok(body.includes("{{include?:personal/review.md}}"));
  const expected = body
    .replace("{{include:review/context.md}}", () => context.trim())
    .replace("{{include:review/findings.md}}", () => findings.trim())
    .replace("{{include?:personal/review.md}}", "");
  assert.equal(result.agent!.review!.prompt, expected);
});
