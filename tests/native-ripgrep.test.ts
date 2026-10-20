import assert from "node:assert/strict";
import { test } from "node:test";
import { ripgrepTarget } from "./native-ripgrep.ts";

test("native ripgrep preparation uses verified platform archives", () => {
  assert.equal(ripgrepTarget("win32").executable, "rg.exe");
  assert.equal(ripgrepTarget("linux").executable, "rg");
  for (const platform of ["win32", "linux"]) {
    assert.match(ripgrepTarget(platform).sha256, /^[a-f0-9]{64}$/);
  }
  assert.throws(() => ripgrepTarget("darwin"), /Linux or Windows/);
});
