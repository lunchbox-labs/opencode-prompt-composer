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

test("verification gates every release mutation and supplies pinned metadata to all later jobs", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/publish.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(workflow.name, "Publish");
  assert.deepEqual(workflow.on, { workflow_dispatch: null });
  assert.deepEqual(Object.keys(workflow.jobs), [
    "verify",
    "prepare",
    "publish",
    "finish",
  ]);
  const { verify, prepare, publish, finish } = workflow.jobs;
  assert.equal(workflow["run-name"], undefined);
  assert.equal(verify.name, "Verify package and source");
  assert.equal(prepare.name, "Prepare ${{ needs.verify.outputs.tag }}");
  assert.equal(publish.name, "Publish npm ${{ needs.verify.outputs.tag }}");
  assert.equal(finish.name, "Publish GitHub ${{ needs.verify.outputs.tag }}");
  assert.equal(verify.needs, undefined);
  assert.equal(verify.environment, undefined);
  assert.equal(verify.env, undefined);
  assert.match(verify.if, /github\.ref == 'refs\/heads\/main'/);
  assert.deepEqual(verify.outputs, {
    access: "${{ steps.release.outputs.access }}",
    name: "${{ steps.release.outputs.name }}",
    version: "${{ steps.release.outputs.version }}",
    tag: "${{ steps.release.outputs.tag }}",
    commit: "${{ github.sha }}",
  });
  assert.equal(prepare.needs, "verify");
  assert.equal(prepare.outputs, undefined);
  assert.deepEqual(publish.needs, ["verify", "prepare"]);
  assert.deepEqual(finish.needs, ["verify", "publish"]);
  const source = verify.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(source.with.ref, "${{ github.sha }}");
  const metadata = verify.steps.findIndex((step) => step.id === "release");
  assert.match(verify.steps[metadata].run, /package\.json/);
  assert.match(
    verify.steps[metadata].run,
    /node scripts\/validate-release\.mjs/,
  );
  let previous = metadata;
  for (const command of [
    "npm ci",
    "npm run check",
    "npm run test:package",
    "npm run test:native",
  ]) {
    const index = verify.steps.findIndex((step) => step.run === command);
    assert.ok(
      index > previous,
      `${command} must run after metadata and previous checks`,
    );
    previous = index;
  }
  const pack = verify.steps.findIndex((step) =>
    step.run?.includes("cmp release/*.tgz release-repack/*.tgz"),
  );
  assert.ok(pack > previous);
  assert.ok(
    verify.steps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    ) > pack,
  );
  for (const [job, stage] of [
    [prepare, "prepare"],
    [publish, "npm"],
    [finish, "finish"],
  ]) {
    const operation = job.steps.find((step) =>
      step.run?.includes(`node scripts/release-lifecycle.mjs ${stage}`),
    );
    assert.ok(operation);
    for (const [key, output] of [
      ["NPM_PACKAGE_NAME", "name"],
      ["NPM_PACKAGE_VERSION", "version"],
      ["RELEASE_TAG", "tag"],
      ["RELEASE_COMMIT", "commit"],
    ]) {
      assert.equal(
        operation.env[key],
        "${{ needs.verify.outputs." + output + " }}",
      );
    }
    assert.deepEqual(
      job.permissions,
      stage === "npm"
        ? { contents: "read", "id-token": "write" }
        : { contents: "read" },
    );
  }
  assert.equal(publish.environment, "npm");
  const npm = publish.steps.find((step) =>
    step.run?.includes("node scripts/release-lifecycle.mjs npm"),
  );
  assert.equal(npm.env.NPM_ACCESS, "${{ needs.verify.outputs.access }}");
});
