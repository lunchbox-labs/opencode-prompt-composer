import { realpath, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { discoveryDirectories } from "./discovery.ts";
import { SettingsError } from "./errors.ts";
import { record } from "./runtime-state.ts";
import type { SettingsContext } from "./settings.ts";

async function roots(context: SettingsContext) {
  return [
    ...new Set([
      context.root,
      ...(await discoveryDirectories(
        {
          directory: context.directory ?? context.root,
          worktree: context.worktree ?? context.root,
        },
        process.env,
        () => Promise.resolve(true),
      )),
    ]),
  ];
}

async function identity(path: string) {
  let canonical = await realpath(path);
  // The pinned Bun host returns a bare drive for Windows roots; stat needs C:\.
  if (process.platform === "win32" && /^[a-z]:$/i.test(canonical)) {
    canonical += "\\";
  }
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory() || info.ino === 0n || info.birthtimeNs === 0n) {
    throw new SettingsError(
      "Filesystem identity is unavailable. Reload on a supported local filesystem.",
    );
  }
  return {
    canonical,
    device: String(info.dev),
    inode: String(info.ino),
    created: String(info.birthtimeNs),
  };
}

/** Stable directory identities detect accidental client/server filesystem mismatches. */
export async function captureFilesystem(context: SettingsContext) {
  const locations = await roots(context);
  const anchors: {
    path: string;
    identity: Awaited<ReturnType<typeof identity>>;
  }[] = [];
  for (const location of locations) {
    let path = location;
    for (;;) {
      try {
        anchors.push({ path, identity: await identity(path) });
        break;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) ||
          dirname(path) === path
        ) {
          throw error;
        }
        path = dirname(path);
      }
    }
  }
  return { locations, anchors };
}

export async function verifyFilesystem(
  context: SettingsContext,
  value: unknown,
) {
  const mismatch = () =>
    new SettingsError(
      "Saved preview requires matching local filesystem identities and discovery locations. Reload the server plugin on this machine.",
    );
  const locations = await roots(context);
  if (
    !record(value) ||
    JSON.stringify(value.locations) !== JSON.stringify(locations) ||
    !Array.isArray(value.anchors) ||
    value.anchors.length !== locations.length
  ) {
    throw mismatch();
  }
  for (const anchor of value.anchors) {
    if (
      !record(anchor) ||
      typeof anchor.path !== "string" ||
      !record(anchor.identity) ||
      JSON.stringify(await identity(anchor.path)) !==
        JSON.stringify(anchor.identity)
    ) {
      throw mismatch();
    }
  }
}
