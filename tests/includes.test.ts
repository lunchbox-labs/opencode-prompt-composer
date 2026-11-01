import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type TestContext, test } from "node:test";
import {
  MAX_PROMPT_BYTES,
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
  assert.equal(
    reads[0].canonicalPath,
    await realpath(join(root, "prompts/outer.md")),
  );
  assert.equal(reads[0].text, "Review {{include:inner.txt}}");
});

test("public includes stay live and observer mutation cannot alter loaded text", async (t) => {
  const { sources } = await fixture(t);
  await writeFile(join(sources, "body.md"), " First ");
  let observations = 0;
  const observe = (read: PromptDependency) => {
    observations++;
    read.text = "Observer edit";
    read.canonicalPath = "Observer path";
  };
  assert.equal(
    await expandIncludes("{{include:body.md}}", sources, observe),
    "First",
  );
  await writeFile(join(sources, "body.md"), " Second ");
  assert.equal(
    await expandIncludes(
      "{{include:body.md}} {{include:body.md}}",
      sources,
      observe,
    ),
    "Second Second",
  );
  assert.equal(observations, 3);
  await assert.rejects(
    expandIncludes("{{include:body.md}}", sources, () => {
      throw new Error("PRIVATE CALLBACK");
    }),
    (error: Error) => {
      assert.match(error.message, /Could not read prompt include/);
      assert.doesNotMatch(error.message, /PRIVATE CALLBACK/);
      return true;
    },
  );
});

test("rejects unsafe and malformed references without reading outside the alias", async (t) => {
  const { root, sources } = await fixture(t);
  await writeFile(join(root, "outside.md"), "secret");
  for (const marker of ["include", "include?"]) {
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
        expandIncludes(`{{${marker}:${reference}}}`, sources),
        /safe relative/,
      );
    }
    await assert.rejects(
      expandIncludes(`{{${marker}:a.md`, sources),
      /invalid syntax/,
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
  for (const marker of ["include", "include?"]) {
    await assert.rejects(
      expandIncludes(`{{${marker}:link.md}}`, sources),
      /escapes/,
    );
    await writeFile(join(root, "prompts/cycle.md"), `{{${marker}:cycle.md}}`);
    await assert.rejects(
      expandIncludes(`{{${marker}:cycle.md}}`, sources),
      /cycle/,
    );
  }
});

test("optional includes expand discovered snippets and drop only missing ones", async (t) => {
  const { sources } = await fixture(t);
  await writeFile(
    join(sources, "personal.md"),
    "  Personal {{include:shared.txt}}  ",
  );
  await writeFile(join(sources, "shared.txt"), "evidence{{include?:none.txt}}");
  await writeFile(join(sources, "requires.md"), "{{include:missing.md}}");
  assert.equal(
    await expandIncludes(
      "A {{include?:personal.md}} B{{include?:missing.md}} C \\{{include?:personal.md}} \\{{include?:",
      sources,
    ),
    "A Personal evidence B C {{include?:personal.md}} {{include?:",
  );
  // A nested marker keeps its own form inside an optional snippet.
  await assert.rejects(
    expandIncludes("{{include?:requires.md}}", sources),
    (error: Error) => {
      assert.match(error.message, /"missing\.md" does not exist/);
      assert.match(error.message, /chain: "requires\.md" -> "missing\.md"/);
      return true;
    },
  );
});

test("enforces text, snippet, composed-size, count and nesting budgets", async (t) => {
  const { root, sources } = await fixture(t);
  for (const content of [Buffer.from([0xff]), "bad\0text", "x".repeat(65537)]) {
    await writeFile(join(root, "prompts/bad.md"), content);
    await assert.rejects(expandIncludes("{{include:bad.md}}", sources));
    await assert.rejects(expandIncludes("{{include?:bad.md}}", sources));
  }
  await writeFile(join(root, "prompts/valid.md"), "x".repeat(65536));
  await assert.rejects(
    expandIncludes("{{include:valid.md}}".repeat(5), sources),
    /256 KiB/,
  );

  await writeFile(join(root, "prompts/empty.md"), "");
  for (const marker of ["{{include:empty.md}}", "{{include?:missing.md}}"]) {
    await assert.rejects(
      expandIncludes(marker.repeat(257), sources),
      /count or nesting/,
    );
  }
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

test("escaped markers require only linear UTF-8 measurement work", async (t) => {
  const byteLength = Buffer.byteLength.bind(Buffer);
  let measuredCharacters = 0;
  t.mock.method(
    Buffer,
    "byteLength",
    (...args: Parameters<typeof byteLength>) => {
      if (typeof args[0] === "string") {
        measuredCharacters += args[0].length;
      }
      return byteLength(...args);
    },
  );

  for (const count of [100, 1000]) {
    const text = "pré \\{{include:rules.md}}🧭".repeat(count);
    measuredCharacters = 0;
    assert.equal(
      await expand(text, new Map()),
      "pré {{include:rules.md}}🧭".repeat(count),
    );
    assert.ok(
      measuredCharacters <= 2 * text.length,
      `Measured ${measuredCharacters} characters for ${text.length} input characters`,
    );
  }
});

test("initial byte limits still apply before escaped markers shrink the output", async () => {
  const marker = "\\{{include:literal.md}}";
  const prefix =
    "é".repeat(100) + "x".repeat(MAX_PROMPT_BYTES - 200 - marker.length);
  assert.equal(
    await expand(prefix + marker, new Map()),
    prefix + "{{include:literal.md}}",
  );
  await assert.rejects(expand(prefix + marker + "x", new Map()), {
    name: "PromptComposerError",
    message: "The composed prompt exceeds the 256 KiB limit.",
  });
});

test("composed multibyte output accepts the exact byte limit and rejects one extra byte", async (t) => {
  const { sources } = await fixture(t);
  const snippet = "é".repeat(32768);
  await writeFile(join(sources, "full.md"), snippet);
  const text = "{{include:full.md}}".repeat(4);
  assert.equal(await expandIncludes(text, sources), snippet.repeat(4));
  await assert.rejects(expandIncludes(text + "x", sources), {
    name: "PromptComposerError",
    message:
      'The composed prompt exceeds the 256 KiB limit. Include chain: "full.md".',
  });
});

test("UTF-8 limits account for native surrogate boundaries through empty includes", async (t) => {
  const { sources } = await fixture(t);
  const block = "x".repeat(65520);
  await writeFile(join(sources, "block.md"), block);
  await writeFile(join(sources, "empty.md"), "");
  const empty = "{{include:empty.md}}";
  for (const [suffix, expected] of [
    [`\ud800${empty}${empty}\udc00`, "\ud800\udc00"],
    [`\ud800${empty}${empty}\udc00${empty}`, "\ud800\udc00"],
    [`\ud800${empty}${empty}é`, "\ud800é"],
    [`é${empty}\udc00`, "é\udc00"],
    [`\udc00${empty}\ud800`, "\udc00\ud800"],
  ]) {
    const padding = "x".repeat(
      MAX_PROMPT_BYTES - 4 * block.length - Buffer.byteLength(expected, "utf8"),
    );
    const text = "{{include:block.md}}".repeat(4) + padding + suffix;
    assert.equal(
      await expandIncludes(text, sources),
      block.repeat(4) + padding + expected,
    );
    await assert.rejects(expandIncludes(text + "x", sources), /256 KiB limit/);
  }
});

test("nested byte-limit errors retain the marker position, consumer and include chain", async (t) => {
  const { sources } = await fixture(t);
  await writeFile(join(sources, "full.md"), "x".repeat(65536));
  await writeFile(
    join(sources, "outer.md"),
    "\n\n  " + "{{include:full.md}}\n".repeat(4),
  );
  const inventory = new Map(
    ["outer.md", "full.md"].map((name) => [
      name,
      { root: sources, path: join(sources, name), relativePath: name },
    ]),
  );
  await assert.rejects(
    expand("{{include:outer.md}}", inventory, undefined, "agent review"),
    {
      name: "PromptComposerError",
      message:
        'The composed prompt exceeds the 256 KiB limit. Consumer: agent review. at "outer.md":6:1 Include chain: "outer.md" -> "full.md".',
    },
  );
});
