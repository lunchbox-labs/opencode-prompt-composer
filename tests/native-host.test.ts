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

// Each host's lanes use its own version numbers; the resolver logic is shared.
const lanes = [
  {
    product: "OpenCode",
    cliPackage: "opencode-ai",
    major: 1,
    minor: 19,
  },
  {
    product: "Kilo",
    cliPackage: "@kilocode/cli",
    major: 7,
    minor: 8,
  },
];

for (const lane of lanes) {
  // A version in the lane's tested minor series, or a neighbour of it.
  const v = (minorOffset: number, patch: number | string) =>
    `${lane.major}.${lane.minor + minorOffset}.${patch}`;
  const series = `${lane.major}.${lane.minor}.x`;
  const { product, cliPackage } = lane;
  test(
    `${product} resolver fetches fresh registry metadata and selects newest matching stable release`,
    { timeout: 60_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "prompt-host-resolver-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      let requests = 0;
      let unavailable = false;
      let versions = [v(0, 0), v(-1, 99), v(1, 0), v(0, "8-beta.1"), v(0, 2)];
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
            name: cliPackage,
            "dist-tags": { latest: v(1, 0) },
            versions: Object.fromEntries(
              versions.map((version) => [
                version,
                { name: cliPackage, version },
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
        JSON.stringify({ version: v(0, 0) }),
      );
      const options = {
        product,
        cliPackage,
        npm,
        range: series,
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
      assert.equal(await resolveNativeVersion(options), v(0, 2));
      const firstRequests = requests;
      versions = [...versions, v(0, 9), v(0, 4)];
      assert.equal(await resolveNativeVersion(options), v(0, 9));
      assert.ok(
        requests > firstRequests,
        "Every resolution must fetch registry metadata afresh",
      );
      assert.equal(
        await resolveNativeVersion({
          ...options,
          range: `>=${v(0, 2)} <${v(0, 9)}`,
        }),
        v(0, 4),
      );
      const beforeFloor = requests;
      assert.equal(
        await resolveNativeVersion({ ...options, requested: v(0, 0) }),
        v(0, 0),
      );
      assert.equal(
        requests,
        beforeFloor,
        "Explicit floor lane must stay reproducible",
      );
      await assert.rejects(
        resolveNativeVersion({ ...options, requested: v(1, 0) }),
        /does not satisfy/,
      );
      await assert.rejects(
        resolveNativeVersion({ ...options, range: `${lane.major + 1}.x` }),
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

  test(`${product} version verification rejects mismatches and versions outside declared range`, () => {
    verifyNativeVersion(product, v(0, 0), series);
    verifyNativeVersion(product, v(0, 9), series, v(0, 9));
    for (const version of [
      v(-1, 34),
      v(1, 0),
      v(0, "9-beta.1"),
      "latest",
      `v${v(0, 0)}`,
    ]) {
      assert.throws(() => verifyNativeVersion(product, version, series));
    }
    assert.throws(() => verifyNativeVersion(product, v(0, 0), "invalid range"));
    assert.throws(
      () => verifyNativeVersion(product, v(0, 0), series, v(0, 9)),
      /actual CLI/,
    );
  });
}
