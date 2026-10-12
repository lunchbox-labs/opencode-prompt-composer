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
