import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test(
  "cancelled native terminal driver terminates and reaps its stalled host",
  { skip: process.platform !== "linux", timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "prompt-tui-cleanup-"));
    const binary = join(root, "host.py");
    let host;
    let driver;
    t.after(async () => {
      driver?.kill("SIGKILL");
      if (host !== undefined) {
        try {
          process.kill(host, "SIGKILL");
        } catch {
          /* Already reaped. */
        }
      }
      await rm(root, { recursive: true, force: true });
    });
    await writeFile(
      binary,
      "#!/usr/bin/env python3\nimport os, signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\nopen('host.pid', 'w').write(str(os.getpid()))\nwhile True: time.sleep(1)\n",
    );
    await chmod(binary, 0o755);
    driver = spawn(
      "python3",
      [
        fileURLToPath(new URL("./native-tui.py", import.meta.url)),
        binary,
        root,
      ],
      { stdio: "ignore" },
    );
    const exited = once(driver, "exit");
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = await readFile(join(root, "host.pid"), "utf8").catch(
        () => "",
      );
      if (value !== "") {
        host = Number(value);
        break;
      }
      await setTimeout(50);
    }
    assert.ok(
      host !== undefined,
      "Stalled host must start before cancellation",
    );
    driver.kill("SIGTERM");
    await exited;
    assert.throws(
      () => process.kill(host, 0),
      { code: "ESRCH" },
      "Driver must reap even a host that ignores SIGTERM",
    );
  },
);
