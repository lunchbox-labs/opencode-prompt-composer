import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type TestContext, test } from "node:test";
import {
  type PromptDependency,
  expandIncludes as expand,
} from "../src/includes.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "prompt-composer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "prompts"));
  return { root, sources: join(root, "prompts") };
}

async function expandIncludes(
  text: string,
  root: string,
  onRead?: (read: PromptDependency) => void,
) {
  const names = await readdir(root, { recursive: true });
  return expand(
    text,
    new Map(
      names.map((name) => [
        name,
        { root, path: join(root, name), relativePath: name },
      ]),
    ),
    onRead,
  );
}

test("nested includes preserve escaped markers and report source dependencies", async (t) => {
  const { root, sources } = await fixture(t);
  await writeFile(join(root, "prompts/inner.txt"), "  evidence  ");
  await writeFile(
    join(root, "prompts/outer.md"),
    "Review {{include:inner.txt}}",
  );
  const reads: PromptDependency[] = [];
  assert.equal(
    await expandIncludes(
      "Start {{include:outer.md}} \\{{include:literal.md}}",
      sources,
      (read) => reads.push(read),
    ),
    "Start Review evidence {{include:literal.md}}",
  );
  assert.deepEqual(
    reads.map((read) => read.path),
    [join(root, "prompts/outer.md"), join(root, "prompts/inner.txt")],
  );
  assert.equal(reads[0].canonicalPath, join(root, "prompts/outer.md"));
  assert.equal(reads[0].text, "Review {{include:inner.txt}}");
});

test("rejects unsafe and malformed references without reading outside the alias", async (t) => {
  const { root, sources } = await fixture(t);
  await writeFile(join(root, "outside.md"), "secret");
  for (const reference of [
    "../outside.md",
    ".hidden.md",
    "a//b.md",
    "a/./b.md",
    "a\\b.md",
    "C:/a.md",
    "file.json",
    "/outside.md",
    "a\u0001.md",
  ]) {
    await assert.rejects(
      expandIncludes(`{{include:${reference}}}`, sources),
      /safe relative/,
    );
  }
  await assert.rejects(
    expandIncludes("{{include:@missing/a.md}}", sources),
    /does not exist/,
  );
  await assert.rejects(
    expandIncludes("{{include:a.md}}", sources),
    /does not exist/,
  );
  await assert.rejects(
    expandIncludes("{{include:a.md", sources),
    /invalid syntax/,
  );
  await assert.rejects(
    expandIncludes("{{include:missing.md}}", sources),
    /does not exist/,
  );
});

test("rejects escaped symlinks and recursive aliases", async (t) => {
  const { root, sources } = await fixture(t);
  await writeFile(join(root, "outside.md"), "outside");
  try {
    await symlink(join(root, "outside.md"), join(root, "prompts/link.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Symlink privilege unavailable");
      return;
    }
    throw error;
  }
  await assert.rejects(
    expandIncludes("{{include:link.md}}", sources),
    /escapes/,
  );
  await writeFile(join(root, "prompts/cycle.md"), "{{include:cycle.md}}");
  await assert.rejects(
    expandIncludes("{{include:cycle.md}}", sources),
    /cycle/,
  );
});

test("enforces text, snippet, composed-size, count and nesting budgets", async (t) => {
  const { root, sources } = await fixture(t);
  for (const content of [Buffer.from([0xff]), "bad\0text", "x".repeat(65537)]) {
    await writeFile(join(root, "prompts/bad.md"), content);
    await assert.rejects(expandIncludes("{{include:bad.md}}", sources));
  }
  await writeFile(join(root, "prompts/valid.md"), "x".repeat(65536));
  await assert.rejects(
    expandIncludes("{{include:valid.md}}".repeat(5), sources),
    /256 KiB/,
  );

  await writeFile(join(root, "prompts/empty.md"), "");
  await assert.rejects(
    expandIncludes("{{include:empty.md}}".repeat(257), sources),
    /count or nesting/,
  );
  for (let n = 0; n < 34; n++) {
    await writeFile(
      join(root, `prompts/${n}.md`),
      n === 33 ? "end" : `{{include:${n + 1}.md}}`,
    );
  }
  await assert.rejects(
    expandIncludes("{{include:0.md}}", sources),
    /count or nesting/,
  );
});

test("malformed nested markers report original snippet positions without body text", async (t) => {
  const { sources } = await fixture(t);
  await writeFile(
    join(sources, "a.md"),
    "\r\n\r\n  PRIVATE\r\n  {{include:broken",
  );
  await assert.rejects(
    expandIncludes("{{include:a.md}}", sources),
    (error: Error) => {
      assert.match(error.message, /invalid syntax/);
      assert.match(error.message, /a\.md.*:4:3/);
      assert.doesNotMatch(error.message, /PRIVATE|broken/);
      return true;
    },
  );
});

test("diagnostics bound long include chains and references", async (t) => {
  const { sources } = await fixture(t);
  for (let n = 0; n < 34; n++) {
    await writeFile(join(sources, `${n}.md`), `{{include:${n + 1}.md}}`);
  }
  await assert.rejects(
    expandIncludes("{{include:0.md}}", sources),
    (error: Error) => {
      assert.match(error.message, /nesting limit/);
      assert.match(error.message, /0\.md.* -> .*32\.md/);
      assert.ok(error.message.length < 2000);
      return true;
    },
  );
  await assert.rejects(
    expandIncludes(`{{include:${"a".repeat(20000)}.md}}`, sources),
    (error: Error) => {
      assert.match(error.message, /does not exist/);
      assert.ok(error.message.length < 2000);
      return true;
    },
  );
});

test("unsafe marker payloads cannot dump body text into diagnostics", async (t) => {
  const { sources } = await fixture(t);
  await assert.rejects(
    expandIncludes("{{include:../unsafe\nPRIVATE BODY}}", sources),
    (error: Error) => {
      assert.match(error.message, /safe relative/);
      assert.doesNotMatch(error.message, /PRIVATE BODY/);
      return true;
    },
  );
});

test("marker-free text bypasses the include byte budget", async () => {
  const text = "Native " + "x".repeat(262145);
  assert.equal(await expand(text, new Map()), text);
});
