import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureFilesystem, verifyFilesystem } from "../src/filesystem.ts";

test("read-only identity covers global roots even when the project mount matches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-filesystem-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(root, "config");
  t.after(() => {
    if (previous === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previous;
    }
  });
  const global = join(root, "config/opencode");
  await mkdir(global, { recursive: true });
  const context = { root, directory: root, worktree: root };
  const captured = await captureFilesystem(context);
  await verifyFilesystem(context, captured);
  await assert.rejects(
    verifyFilesystem(context, undefined),
    /matching local filesystem identities/,
  );
  // Newly created settings directories on the same filesystem remain previewable.
  await mkdir(join(root, ".opencode"));
  await verifyFilesystem(context, captured);
  await rename(global, `${global}-server`);
  await mkdir(global);
  await assert.rejects(
    verifyFilesystem(context, captured),
    /matching local filesystem identities/,
  );
});
