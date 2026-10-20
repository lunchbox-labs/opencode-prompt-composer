import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nativeTerminal } from "./native-terminal.ts";

test(
  "portable terminal cancellation reaps a stalled native child",
  { timeout: 20_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "prompt-portable-cleanup-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    const terminal = nativeTerminal({
      binary: process.execPath,
      args: [
        "-e",
        "process.on('SIGTERM',()=>{});console.log('Ready');setInterval(()=>{},1000)",
      ],
      project: root,
      env: process.env,
      signal: controller.signal,
    });
    t.after(terminal.stop);
    await terminal.wait("Ready");
    controller.abort();
    await terminal.stop();
    assert.throws(() => process.kill(terminal.pid, 0), { code: "ESRCH" });
  },
);
