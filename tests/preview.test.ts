import assert from "node:assert/strict";
import { test } from "node:test";

test("page boundaries retain empty text, long lines, CRLF and trailing newlines", async () => {
  const { previewPages } = await import("../src/preview.ts");
  for (const text of [
    "",
    "x".repeat(240),
    "x".repeat(241),
    "\r\n".repeat(60),
    `${"🙂".repeat(239)}$ARGUMENTS\\{{include:literal.md}}\n`,
  ]) {
    const pages = previewPages(text);
    assert.ok(pages.length >= 1);
    assert.equal(pages.join(""), text);
    for (const page of pages) {
      assert.ok(Array.from(page).length <= 240);
      assert.ok(page.split("\n").length <= 7);
      assert.equal(page.isWellFormed(), true);
    }
  }
});
