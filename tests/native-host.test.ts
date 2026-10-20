import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveNativeVersion, verifyNativeVersion } from "./native-host.ts";

const npm = process.env.npm_execpath;
assert.ok(npm !== undefined, "Run resolver tests through npm");

test(
  "native resolver fetches fresh registry metadata and selects newest matching stable release",
  { timeout: 60_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "prompt-host-resolver-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    let requests = 0;
    let unavailable = false;
    let versions = ["1.19.0", "1.18.99", "1.20.0", "1.19.8-beta.1", "1.19.2"];
    const server = createServer((_request, response) => {
      requests++;
      if (unavailable) {
        response.writeHead(503);
        response.end("unavailable");
        return;
      }
      response.setHeader("Cache-Control", "public, max-age=86400");
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          name: "opencode-ai",
          "dist-tags": { latest: "1.20.0" },
          versions: Object.fromEntries(
            versions.map((version) => [
              version,
              { name: "opencode-ai", version },
            ]),
          ),
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const home = join(root, "home");
    await mkdir(home);
    // Deliberately stale local inputs must not determine the registry selection.
    await writeFile(
      join(root, "package-lock.json"),
      JSON.stringify({ version: "1.19.0" }),
    );
    const options = {
      npm,
      range: "1.19.x",
      cache: join(root, "cache"),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        npm_config_userconfig: join(home, ".npmrc"),
        npm_config_registry: `http://127.0.0.1:${address.port}`,
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      },
      signal: t.signal,
    };
    assert.equal(await resolveNativeVersion(options), "1.19.2");
    const firstRequests = requests;
    versions = [...versions, "1.19.9", "1.19.4"];
    assert.equal(await resolveNativeVersion(options), "1.19.9");
    assert.ok(
      requests > firstRequests,
      "Every resolution must fetch registry metadata afresh",
    );
    assert.equal(
      await resolveNativeVersion({ ...options, range: ">=1.19.2 <1.19.9" }),
      "1.19.4",
    );
    const beforeFloor = requests;
    assert.equal(
      await resolveNativeVersion({ ...options, requested: "1.19.0" }),
      "1.19.0",
    );
    assert.equal(
      requests,
      beforeFloor,
      "Explicit floor lane must stay reproducible",
    );
    await assert.rejects(
      resolveNativeVersion({ ...options, requested: "1.20.0" }),
      /does not satisfy/,
    );
    await assert.rejects(
      resolveNativeVersion({ ...options, range: "2.x" }),
      /No match|No compatible|E404/,
    );
    unavailable = true;
    await assert.rejects(
      resolveNativeVersion(options),
      /503|unavailable/,
      "Registry failure must not fall back to previously resolved metadata",
    );
  },
);

test("native version verification rejects mismatches and versions outside declared range", () => {
  verifyNativeVersion("1.19.0", "1.19.x");
  verifyNativeVersion("1.19.9", "1.19.x", "1.19.9");
  for (const version of [
    "1.18.34",
    "1.20.0",
    "1.19.9-beta.1",
    "latest",
    "v1.19.0",
  ]) {
    assert.throws(() => verifyNativeVersion(version, "1.19.x"));
  }
  assert.throws(() => verifyNativeVersion("1.19.0", "invalid range"));
  assert.throws(
    () => verifyNativeVersion("1.19.0", "1.19.x", "1.19.9"),
    /actual CLI/,
  );
});
