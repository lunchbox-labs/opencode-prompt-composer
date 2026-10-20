import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRelease as validate } from "../scripts/validate-release.mjs";

const release = {
  name: "@lunchbox-labs/opencode-prompt-composer",
  version: "1.2.3",
  repository: {
    url: "git+https://github.com/lunchbox-labs/opencode-prompt-composer.git",
  },
  publishConfig: { access: "public" },
};

const lock = {
  name: release.name,
  version: release.version,
  packages: { "": { name: release.name, version: release.version } },
};
const validateRelease = (manifest, tag) => validate(manifest, tag, lock);

test("release validation rejects stale or missing lockfile versions", () => {
  for (const broken of [
    undefined,
    { ...lock, version: "1.2.2" },
    { ...lock, packages: { "": { name: release.name, version: "1.2.2" } } },
  ]) {
    assert.throws(() => validate(release, "v1.2.3", broken), /lockfile/);
  }
});

test("release validation accepts explicit public and scoped restricted stable releases", () => {
  assert.deepEqual(validateRelease(release, "v1.2.3"), {
    name: release.name,
    version: "1.2.3",
    access: "public",
  });
  assert.equal(
    validateRelease(
      { ...release, publishConfig: { access: "restricted" } },
      "v1.2.3",
    ).access,
    "restricted",
  );
});

test("release validation rejects private, provisional, mismatched, prerelease, and misrouted packages", () => {
  for (const change of [
    { private: true },
    { private: "false" },
    { name: "package-name-tbd" },
    { name: "invalid name" },
    { name: "opencode-prompt-composer" },
    { name: "@other/opencode-prompt-composer" },
    { version: "0.0.0" },
    { version: "1.2.3-beta.1" },
    { version: "01.2.3" },
    { publishConfig: undefined },
    { publishConfig: { access: "other" } },
    { name: "unscoped", publishConfig: { access: "restricted" } },
    {
      publishConfig: { access: "public", registry: "https://example.invalid" },
    },
    { repository: { url: "git+https://github.com/example/other.git" } },
  ]) {
    assert.throws(() => validateRelease({ ...release, ...change }, "v1.2.3"));
  }
  for (const tag of [
    undefined,
    "1.2.3",
    "v1.2.4",
    "main",
    "v1.2.3;echo unexpected",
  ]) {
    assert.throws(() => validateRelease(release, tag), /release tag/);
  }
});

test("manual lifecycle isolates permissions and gates publication on verified artifacts", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /^ {2}release:/m);
  assert.match(workflow, /^ {2}workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /inputs:/);
  const jobs = workflow.split(/(?=^ {2}\w+:)/m);
  const prepare = jobs.find((job) => job.startsWith("  prepare:\n"));
  const verify = jobs.find((job) => job.startsWith("  verify:\n"));
  const publish = jobs.find((job) => job.startsWith("  publish:\n"));
  const finish = jobs.find((job) => job.startsWith("  finish:\n"));
  assert.ok(prepare && verify && publish && finish);
  assert.match(prepare, /github\.ref == 'refs\/heads\/main'/);
  assert.match(prepare, /contents: write/);
  assert.doesNotMatch(prepare, /id-token: write/);
  assert.match(prepare, /node scripts\/validate-release\.mjs/);
  assert.match(prepare, /node scripts\/release-lifecycle\.mjs prepare/);
  assert.match(verify, /needs: prepare/);
  assert.doesNotMatch(verify, /contents: write|id-token: write/);
  assert.match(verify, /cmp release\/\*\.tgz release-repack\/\*\.tgz/);
  assert.match(publish, /needs: \[prepare, verify\]/);
  assert.match(publish, /contents: read/);
  assert.match(publish, /id-token: write/);
  assert.match(publish, /node scripts\/release-lifecycle\.mjs npm/);
  assert.match(finish, /needs: \[prepare, verify, publish\]/);
  assert.match(finish, /contents: write/);
  assert.doesNotMatch(finish, /id-token: write/);
  assert.match(finish, /node scripts\/release-lifecycle\.mjs finish/);
  for (const job of [publish, finish]) {
    assert.ok(
      job.indexOf("actions/checkout@") <
        job.indexOf("actions/download-artifact@"),
    );
    assert.ok(
      job.indexOf("sha256sum --check") <
        job.indexOf("node scripts/release-lifecycle.mjs"),
    );
  }
});
