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

test("only stable published releases run verification before npm publication", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const workflow = parse(
    await readFile(
      new URL("../.github/workflows/publish.yml", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(workflow.name, "Publish");
  assert.equal(workflow["run-name"], undefined);
  assert.deepEqual(workflow.on, { release: { types: ["published"] } });
  assert.doesNotMatch(JSON.stringify(workflow), /inputs\./);
  assert.deepEqual(Object.keys(workflow.jobs), ["verify", "publish"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const { verify, publish } = workflow.jobs;
  assert.equal(verify.name, "Verify");
  assert.equal(publish.name, "Publish npm");
  assert.equal(verify.needs, undefined);
  assert.equal(verify.environment, undefined);
  assert.match(verify.if, /!github\.event\.release\.prerelease/);
  assert.equal(
    verify.if.replace(/\s+/g, " ").trim(),
    "github.repository == 'lunchbox-labs/opencode-prompt-composer' && github.event_name == 'release' && !github.event.release.prerelease",
  );
  assert.equal(verify.env.RELEASE_TAG, "${{ github.event.release.tag_name }}");
  assert.deepEqual(verify.outputs, {
    access: "${{ steps.release.outputs.access }}",
  });
  const checkout = verify.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(
    checkout.with.ref,
    "refs/tags/${{ github.event.release.tag_name }}",
  );
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);
  assert.ok(
    verify.steps.some(
      (step) =>
        step.run ===
        "git merge-base --is-ancestor HEAD refs/remotes/origin/main",
    ),
  );
  assert.ok(
    verify.steps.some(
      (step) =>
        step.env?.WORKFLOW_COMMIT === "${{ github.sha }}" &&
        step.run.includes("git rev-parse HEAD"),
    ),
  );
  let previous = verify.steps.findIndex(
    (step) => step.run === "node scripts/validate-release.mjs",
  );
  assert.ok(previous >= 0);
  for (const command of [
    "npm ci",
    "npm run check",
    "npm run test:package",
    "npm run test:native",
  ]) {
    const index = verify.steps.findIndex((step) => step.run === command);
    assert.ok(index > previous);
    previous = index;
  }
  const upload = verify.steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  const download = publish.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@"),
  );
  assert.equal(upload.with.name, download.with.name);
  assert.equal(upload.with.path, "release/");
  assert.equal(download.with.path, "release");
  const pack = verify.steps.findIndex((step) =>
    step.run?.includes("npm pack --ignore-scripts --pack-destination release"),
  );
  assert.ok(pack > previous);
  assert.match(verify.steps[pack].run, /sha256sum/);
  assert.ok(
    verify.steps.findIndex((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    ) > pack,
  );
  assert.equal(publish.needs, "verify");
  assert.equal(publish.environment, "npm");
  assert.deepEqual(publish.permissions, {
    contents: "read",
    "id-token": "write",
  });
  const npm = publish.steps.find((step) => step.run?.includes("npm publish"));
  assert.equal(npm.workingDirectory, undefined);
  assert.equal(npm["working-directory"], "release");
  assert.deepEqual(npm.env, {
    NPM_ACCESS: "${{ needs.verify.outputs.access }}",
    NPM_CONFIG_PROVENANCE: "true",
  });
  assert.ok(
    npm.run.indexOf("sha256sum --check SHA256SUMS") <
      npm.run.indexOf("npm publish"),
  );
  assert.match(
    npm.run,
    /npm publish \.\/\*\.tgz --ignore-scripts --access "\$NPM_ACCESS" --tag latest/,
  );
});

test("publish workflow needs only read access and npm OIDC with no custom credentials or repository mutation jobs", async () => {
  const { readFile } = await import("node:fs/promises");
  const { parse } = await import("yaml");
  const source = await readFile(
    new URL("../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const workflow = parse(source);
  assert.doesNotMatch(source, /secrets\.|vars\./);
  const allowed = new Set([
    "actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
    "actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333",
  ]);
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    assert.ok(job.environment === undefined || job.environment === "npm");
    assert.equal(
      job.permissions?.contents ?? workflow.permissions.contents,
      "read",
    );
    assert.equal(
      job.permissions?.["id-token"],
      jobName === "publish" ? "write" : undefined,
    );
    assert.doesNotMatch(
      JSON.stringify(job.outputs ?? {}),
      /token|secrets\.|vars\./,
    );
    for (const step of job.steps) {
      if (step.uses) {
        assert.ok(allowed.has(step.uses));
      }
      assert.equal(step.env?.GH_TOKEN, undefined);
    }
  }
});
