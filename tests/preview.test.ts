import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CODE_POINTS_PER_VIEW,
  MAX_CODE_POINTS_PER_VIEW_LINE,
  previewParts,
} from "../src/preview.ts";

test("text within the view limits opens as one complete view", () => {
  const prompt = "Use evidence 🙂 and state uncertainty.\r\n".repeat(600);
  assert.ok(prompt.length > 20_000);
  for (const text of [
    prompt,
    "",
    "x".repeat(MAX_CODE_POINTS_PER_VIEW_LINE),
    `${"x".repeat(MAX_CODE_POINTS_PER_VIEW_LINE)}\nrest`,
    `${"x".repeat(MAX_CODE_POINTS_PER_VIEW_LINE - 1)}\r\nrest`,
    `${"🙂\n".repeat(MAX_CODE_POINTS_PER_VIEW / 2 - 1)}🙂🙂`,
  ]) {
    assert.deepEqual(previewParts(text), [text]);
  }
});

test("oversized text splits into bounded views at line breaks without losing characters", () => {
  const line = "Use evidence 🙂 and state uncertainty.\r\n";
  for (const text of [
    "x".repeat(MAX_CODE_POINTS_PER_VIEW_LINE + 1),
    `${"🙂".repeat(3 * MAX_CODE_POINTS_PER_VIEW_LINE)}\n`,
    line.repeat(Math.ceil((3 * MAX_CODE_POINTS_PER_VIEW) / line.length)),
    "\n".repeat(MAX_CODE_POINTS_PER_VIEW + 1),
    `${"$ARGUMENTS \\{{include:literal.md}}\n".repeat(4000)}${"界".repeat(2 * MAX_CODE_POINTS_PER_VIEW_LINE)}\n tail`,
  ]) {
    const parts = previewParts(text);
    assert.equal(parts.join(""), text);
    for (const [index, part] of parts.entries()) {
      assert.notEqual(part, "");
      assert.ok(Array.from(part).length <= MAX_CODE_POINTS_PER_VIEW);
      assert.equal(part.isWellFormed(), true);
      for (const segment of part.split("\n")) {
        assert.ok(Array.from(segment).length <= MAX_CODE_POINTS_PER_VIEW_LINE);
      }
      // Only a line longer than one view allows can end a view mid-line.
      if (index < parts.length - 1 && !part.endsWith("\n")) {
        assert.equal(
          Array.from(part.slice(part.lastIndexOf("\n") + 1)).length,
          MAX_CODE_POINTS_PER_VIEW_LINE,
        );
      }
    }
  }
});
