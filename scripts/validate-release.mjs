import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const core = String.raw`(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`;
const stableVersion = new RegExp(`^${core}$`);
const prereleaseVersion = new RegExp(
  String.raw`^${core}-[0-9a-z-]+(?:\.[0-9a-z-]+)*$`,
  "i",
);

const repository =
  "git+https://github.com/lunchbox-labs/opencode-prompt-composer.git";

/**
 * The published packages in publication order: core first, because both
 * adapters depend on it at the same version.
 */
export const releasePackages = Object.freeze([
  Object.freeze({
    directory: "packages/core",
    name: "@lunchbox-labs/prompt-composer-core",
  }),
  Object.freeze({
    directory: "packages/opencode",
    name: "@lunchbox-labs/opencode-prompt-composer",
  }),
  Object.freeze({
    directory: "packages/kilo",
    name: "@lunchbox-labs/kilo-prompt-composer",
  }),
]);
const [corePackage] = releasePackages;

// A pre-release run publishes a pre-release version only, and a normal run a
// stable version only, so npm's latest tag never moves to a pre-release.
/** Validates one package manifest and its lockfile entry for publication. */
export function validatePackage(
  manifest,
  { directory, name },
  tag,
  lock,
  { prerelease = false } = {},
) {
  if (manifest.private !== undefined && manifest.private !== false) {
    throw new Error(
      `${name}: remove the private publication guard only after release setup is approved.`,
    );
  }
  if (manifest.name !== name) {
    throw new Error(`The npm package name in ${directory} must be ${name}.`);
  }
  if (typeof manifest.version !== "string" || manifest.version === "0.0.0") {
    throw new Error(
      `${name}: publishing requires a non-placeholder semantic version.`,
    );
  }
  if (prerelease && !prereleaseVersion.test(manifest.version)) {
    throw new Error(
      `${name}: a pre-release requires a pre-release semantic version, such as 1.2.3-beta.1.`,
    );
  }
  if (!prerelease && !stableVersion.test(manifest.version)) {
    throw new Error(
      `${name}: a release requires a stable semantic version; publish pre-release versions as a pre-release.`,
    );
  }
  if (tag !== `v${manifest.version}`) {
    throw new Error(
      `${name}: the release tag must equal v followed by the package version.`,
    );
  }
  const access = manifest.publishConfig?.access;
  if (
    !["public", "restricted"].includes(access) ||
    (access === "restricted" && !manifest.name.startsWith("@"))
  ) {
    throw new Error(
      `${name}: set an approved publishConfig.access; restricted packages require a scope.`,
    );
  }
  if (manifest.repository?.url !== repository) {
    throw new Error(
      `${name}: the package repository must match the trusted publisher repository.`,
    );
  }
  if (
    manifest.publishConfig?.registry !== undefined &&
    manifest.publishConfig.registry !== "https://registry.npmjs.org"
  ) {
    throw new Error(
      `${name}: this workflow publishes only to https://registry.npmjs.org.`,
    );
  }
  const entry = lock?.packages?.[directory];
  if (entry?.name !== manifest.name || entry?.version !== manifest.version) {
    throw new Error(
      `${name}: the lockfile package name and version must match the release manifest.`,
    );
  }
  return { name: manifest.name, version: manifest.version, access };
}

/**
 * Validates the three manifests, in releasePackages order, as one release:
 * one version, one access, and adapters that depend on exactly that core.
 */
export function validateRelease(manifests, tag, lock, options = {}) {
  if (
    !Array.isArray(manifests) ||
    manifests.length !== releasePackages.length
  ) {
    throw new Error(
      "A release validates the core, OpenCode and Kilo packages together.",
    );
  }
  const results = releasePackages.map((expected, index) =>
    validatePackage(manifests[index], expected, tag, lock, options),
  );
  const [{ version, access }] = results;
  if (results.some((result) => result.version !== version)) {
    throw new Error(
      "packages/core, packages/opencode and packages/kilo must hold the same version.",
    );
  }
  if (results.some((result) => result.access !== access)) {
    throw new Error("Every released package must have the same access.");
  }
  for (const [index, manifest] of manifests.entries()) {
    const expected = index === 0 ? {} : { [corePackage.name]: version };
    if (
      JSON.stringify(manifest.dependencies ?? {}) !== JSON.stringify(expected)
    ) {
      throw new Error(
        index === 0
          ? `${corePackage.name} must have no runtime dependencies.`
          : `${results[index].name} must depend only on ${corePackage.name} at exactly ${version}.`,
      );
    }
  }
  return {
    version,
    access,
    packages: results.map((result) => result.name),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const read = (path) =>
    JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
  const result = validateRelease(
    releasePackages.map(({ directory }) => read(`${directory}/package.json`)),
    process.env.RELEASE_TAG,
    read("package-lock.json"),
    { prerelease: process.env.RELEASE_PRERELEASE === "true" },
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `access=${result.access}\npackages=${result.packages.join(" ")}\nversion=${result.version}\n`,
    );
  }
  console.log(
    `Validated ${result.packages.join(", ")} at ${result.version} for ${result.access} publication.`,
  );
}
