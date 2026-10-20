import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const version = "15.1.0";

/** Match the native host dependency; verify upstream release archive checksums. */
export function ripgrepTarget(platform: string = process.platform) {
  assert.ok(
    ["linux", "win32"].includes(platform),
    "Native ripgrep requires Linux or Windows",
  );
  return platform === "win32"
    ? {
        target: "x86_64-pc-windows-msvc",
        extension: "zip",
        executable: "rg.exe",
        sha256:
          "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
      }
    : {
        target: "x86_64-unknown-linux-musl",
        extension: "tar.gz",
        executable: "rg",
        sha256:
          "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
      };
}

export async function prepareRipgrep(
  root: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
) {
  const target = ripgrepTarget();
  const archiveName = `ripgrep-${version}-${target.target}.${target.extension}`;
  const archive = join(root, archiveName);
  // Network/extraction is an explicit prerequisite, outside the native HTTP
  // request deadline. An instance reload must never interrupt a cold download.
  await execute(
    process.platform === "win32" ? "curl.exe" : "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "2",
      "--max-time",
      "60",
      `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${archiveName}`,
      "--output",
      archive,
    ],
    { env, timeout: 120_000, signal },
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(archive))
      .digest("hex"),
    target.sha256,
    "Native ripgrep archive checksum mismatch",
  );
  await execute(
    process.platform === "win32" ? "tar.exe" : "tar",
    ["-xf", archive, "-C", root],
    { env, timeout: 30_000, signal },
  );
  const directory = join(root, `ripgrep-${version}-${target.target}`);
  const actual = await execute(
    join(directory, target.executable),
    ["--version"],
    { env, timeout: 10_000, signal },
  );
  assert.equal(actual.stdout.split(/\s+/)[1], version, actual.stdout);
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = `${directory}${delimiter}${env[pathKey] ?? ""}`;
}
