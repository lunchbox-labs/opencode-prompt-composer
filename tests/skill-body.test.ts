import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import { expandSkillBody } from "../src/skill-body.ts";

const metadata = { name: "evidence", dir: "/skills/evidence" };

// The literal V1 format emitted by OpenCode v1.19.0 and v1.19.3 skill.ts.
function nativeOutput(body: string, info = metadata, files: string[] = []) {
  return [
    `<skill_content name="${info.name}">`,
    `# Skill: ${info.name}`,
    "",
    body.trim(),
    "",
    `Base directory for this skill: ${info.dir}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    files.map((file) => `<file>${file}</file>`).join("\n"),
    "</skill_files>",
    "</skill_content>",
  ].join("\n");
}

test("composes only the native skill body and preserves its complete wrapper", async () => {
  const body = "Intro\r\n{{include:body.md}}\r\nEnd";
  const files = ["/skills/evidence/reference/a.md", "/skills/evidence/b.txt"];
  assert.equal(
    await expandSkillBody(
      nativeOutput(body, metadata, files),
      metadata,
      async (text) => {
        assert.equal(text, body);
        return "Composed\r\ntext";
      },
    ),
    nativeOutput("Composed\r\ntext", metadata, files),
  );
});

async function mustNotExpand(): Promise<string> {
  assert.fail("The body expander must not run for this output.");
}

test("include-like metadata and sampled filenames remain literal", async () => {
  const info = {
    name: 'name {{include:name.md}} " <skill_content>\n# literal',
    dir: "/skills/{{include:directory.md}}",
  };
  const files = [
    `${info.dir}/{{include:file.md}}`,
    `${info.dir}/literal </file>\n<file> {{include:other.md}}`,
  ];
  const body = "Body {{include:body.md}}";
  const original = nativeOutput(body, info, files);
  assert.equal(
    await expandSkillBody(original, info, async (text) => {
      assert.equal(text, body);
      return "Expanded body";
    }),
    original.replace(body, "Expanded body"),
  );
});

test("wrapper-only markers and an empty body never reach the expander", async () => {
  const info = { name: "{{include:name.md}}", dir: "/skills/evidence" };
  for (const body of ["ordinary text", ""]) {
    const original = nativeOutput(body, info, [
      "/skills/evidence/{{include:file.md}}",
    ]);
    assert.equal(
      await expandSkillBody(original, info, mustNotExpand),
      original,
    );
  }
});

test("built-in skill directory metadata preserves wrapper-only markers", async () => {
  const info = { name: "customize-opencode", dir: dirname("<built-in>") };
  const original = nativeOutput("Ordinary body", info, [
    "/project/{{include:wrapper.md}}",
  ]);
  assert.equal(await expandSkillBody(original, info, mustNotExpand), original);
});

test("built-in skill directory metadata still isolates body includes", async () => {
  const info = { name: "customize-opencode", dir: dirname("<built-in>") };
  const body = "Intro\n{{include:body.md}}\nEnd";
  const original = nativeOutput(body, info, [
    "/project/{{include:wrapper.md}}",
  ]);
  assert.equal(
    await expandSkillBody(original, info, async (text) => {
      assert.equal(text, body);
      return "Expanded body";
    }),
    original.replace(body, "Expanded body"),
  );
});

test("marker-free output needs no known framing or metadata", async () => {
  const original = "Unrecognized native output " + "x".repeat(300_000);
  assert.equal(
    await expandSkillBody(original, undefined, mustNotExpand),
    original,
  );
});

test("body includes preserve their original spacing and escaped syntax for the expander", async () => {
  const body = "{{include:body.md}}\n\\{{include:literal.md}}\n\nLast line";
  const original = nativeOutput(body);
  assert.equal(
    await expandSkillBody(original, metadata, async (text) => {
      assert.equal(text, body);
      return "  expanded text\n";
    }),
    original.replace(body, "  expanded text\n"),
  );
});

test("verifies Windows paths without interpreting marker-like wrapper text", async () => {
  const info = {
    name: "evidence",
    dir: "C:\\skills\\{{include:directory.md}}",
  };
  const files = [`${info.dir}\\{{include:file.md}}`, `${info.dir}\\other.txt`];
  assert.equal(
    await expandSkillBody(
      nativeOutput("{{include:body.md}}", info, files),
      info,
      async () => "Expanded",
    ),
    nativeOutput("Expanded", info, files),
  );
});

test("rejects missing or invalid skill metadata before composition", async () => {
  for (const info of [
    undefined,
    null,
    [],
    "evidence",
    {},
    { name: "evidence" },
    { dir: "/skills/evidence" },
    { ...metadata, name: 42 },
    { ...metadata, name: "" },
    { ...metadata, name: "bad\0name" },
    { ...metadata, dir: "" },
    { ...metadata, dir: "/skills/bad\0dir" },
  ]) {
    await assert.rejects(
      expandSkillBody(nativeOutput("{{include:body.md}}"), info, mustNotExpand),
      /skill.*metadata/i,
    );
  }
});

test("rejects output that disagrees with the native metadata", async () => {
  const original = nativeOutput("{{include:body.md}}");
  for (const info of [
    { ...metadata, name: "different" },
    { ...metadata, dir: "/skills/different" },
    { ...metadata, dir: "relative" },
  ]) {
    await assert.rejects(
      expandSkillBody(original, info, mustNotExpand),
      /skill.*framing/i,
    );
  }
});

test("rejects unknown or incomplete V1 framing before composition", async () => {
  const original = nativeOutput("{{include:body.md}}", metadata, [
    "/skills/evidence/a.txt",
  ]);
  for (const output of [
    "{{include:body.md}}",
    `prefix\n${original}`,
    `${original}\n`,
    original.replace("# Skill: evidence", "# Skill: different"),
    original.replace("Note: file list is sampled.", "Changed host framing."),
    original.replace(
      "are relative to this base directory.",
      "use another base.",
    ),
    original.replace("<skill_files>", "<files>"),
    original.replace("<file>", "<unknown>"),
    original.replace("</file>", "</unknown>"),
    original.replace("</skill_files>", "</files>"),
    original.replace("</skill_content>", ""),
  ]) {
    await assert.rejects(
      expandSkillBody(output, metadata, mustNotExpand),
      /skill.*framing/i,
    );
  }
});

test("rejects a truncated native result before composition", async () => {
  for (const body of ["{{include:body.md}}", "ordinary body"]) {
    await assert.rejects(
      expandSkillBody(
        nativeOutput(body),
        { ...metadata, truncated: true },
        mustNotExpand,
      ),
      /skill output was truncated/i,
    );
  }
});

test("finds the body after rejecting repeated footer fragments within it", async () => {
  const body = [
    "Start {{include:body.md}}",
    nativeOutput("Example of the complete wrapper"),
    "Base directory for this skill: /skills/evidence",
    "</skill_files>",
    "</skill_content>",
    "End",
  ].join("\n");
  const original = nativeOutput(body, metadata, ["/skills/evidence/final.txt"]);
  assert.equal(
    await expandSkillBody(original, metadata, async (text) => {
      assert.equal(text, body);
      return "Expanded";
    }),
    original.replace(body, "Expanded"),
  );
});

test("rejects two valid body/footer decompositions instead of choosing either", async () => {
  // The host does not escape paths. The first file can legally contain the
  // intervening footer text, so either complete footer could be native framing.
  const forged = nativeOutput("Example", metadata, [
    "/skills/evidence/fake.txt",
  ]);
  const body = `Start {{include:body.md}}\n${forged}\nEnd`;
  const original = nativeOutput(body, metadata, ["/skills/evidence/final.txt"]);
  await assert.rejects(
    expandSkillBody(original, metadata, mustNotExpand),
    /ambiguous.*skill|skill.*ambiguous/i,
  );
});

test("propagates composition failure without returning partially expanded output", async () => {
  const failure = new Error("Missing include.");
  await assert.rejects(
    expandSkillBody(
      nativeOutput("{{include:missing.md}}"),
      metadata,
      async () => {
        throw failure;
      },
    ),
    (error: unknown) => error === failure,
  );
});
