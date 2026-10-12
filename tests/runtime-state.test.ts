import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "@opencode-ai/plugin";
import { publishState, readState } from "../src/runtime-state.ts";
import { packageName } from "../src/registration.ts";
import { resolve } from "node:path";

test("prompt editor attestation rejects changed bodies or availability while tolerating unrelated model metadata", () => {
  const root = resolve(".");
  const native: Config = {
    plugin: [packageName],
    agent: { review: { prompt: "Original", disable: false } },
    command: { check: { template: "Original command" } },
  };
  const applied = structuredClone(native);
  applied.agent!.review!.prompt = "Composed";
  applied.command!.check.template = "Composed command";
  publishState(applied, {}, native, { root }, []);
  assert.equal(
    readState(applied, root).native.agent?.review?.prompt,
    "Original",
  );
  applied.agent!.review!.model = "fixture/changed-model";
  assert.doesNotThrow(() => readState(applied, root));
  for (const mutate of [
    (config: Config) => {
      config.agent!.review!.prompt = "Changed";
    },
    (config: Config) => {
      config.command!.check.template = "Changed";
    },
    (config: Config) => {
      config.agent!.review!.disable = true;
    },
  ]) {
    const changed = structuredClone(applied);
    mutate(changed);
    assert.throws(() => readState(changed, root), /changed after composition/);
  }
});
