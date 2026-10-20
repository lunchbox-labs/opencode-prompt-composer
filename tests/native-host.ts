import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

// Keep this test dependency separate from the pinned SDK/build toolchain.
const semver = createRequire(import.meta.url)("semver") as {
  valid(version: string): string | null;
  validRange(range: string): string | null;
  satisfies(version: string, range: string): boolean;
  maxSatisfying(versions: string[], range: string): string | null;
};
const execute = promisify(execFile);

export function verifyNativeVersion(
  version: string,
  range: string,
  actual?: string,
): void {
  assert.ok(
    semver.validRange(range) !== null,
    `Invalid engines.opencode range: ${range}`,
  );
  assert.equal(
    semver.valid(version),
    version,
    `Expected exact native version, got ${version}`,
  );
  assert.ok(
    semver.satisfies(version, range),
    `OpenCode ${version} does not satisfy engines.opencode ${range}`,
  );
  if (actual !== undefined) {
    assert.equal(
      actual,
      version,
      "Installed actual CLI version differs from resolved native version",
    );
  }
}

export async function resolveNativeVersion(options: {
  npm: string;
  range: string;
  cache: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  requested?: string;
}): Promise<string> {
  assert.ok(
    semver.validRange(options.range) !== null,
    `Invalid engines.opencode range: ${options.range}`,
  );
  if (
    options.requested !== undefined &&
    options.requested !== "latest-compatible"
  ) {
    verifyNativeVersion(options.requested, options.range);
    return options.requested;
  }
  // Query the canonical release package, not a platform artifact or dist-tag.
  // Fresh per-run cache plus mandatory online revalidation prevents lockfiles,
  // installed binaries and cached metadata from selecting an old compatible host.
  await mkdir(options.cache, { recursive: true });
  const freshCache = await mkdtemp(join(options.cache, "resolution-"));
  try {
    const result = await execute(
      process.execPath,
      [
        options.npm,
        "view",
        `opencode-ai@${options.range}`,
        "version",
        "--json",
        "--prefer-online",
        "--prefer-offline=false",
        "--offline=false",
        "--fetch-retries=0",
        "--cache",
        freshCache,
      ],
      { env: options.env, timeout: 60_000, signal: options.signal },
    );
    const value: unknown = JSON.parse(result.stdout);
    const versions = typeof value === "string" ? [value] : value;
    assert.ok(
      Array.isArray(versions) &&
        versions.every((version) => typeof version === "string"),
      "Invalid npm release metadata",
    );
    const version = semver.maxSatisfying(versions, options.range);
    assert.ok(
      version !== null,
      `No compatible OpenCode release for ${options.range}`,
    );
    verifyNativeVersion(version, options.range);
    return version;
  } finally {
    await rm(freshCache, { recursive: true, force: true });
  }
}
