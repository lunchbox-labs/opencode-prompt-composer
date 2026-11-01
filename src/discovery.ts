import type { Stats } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { SettingsError } from "./errors.ts";

export interface DiscoveryContext {
  directory: string;
  worktree: string;
}
export interface DiscoveredPrompt {
  path: string;
  root: string;
  relativePath: string;
}
export interface PromptInventory {
  directories: string[];
  files: Map<string, DiscoveredPrompt>;
}
type Lookup = { metadata: Stats } | { error: unknown };

const MAX_ENTRIES = 4096;
// Child lookups hold no descriptors. Batches still bound how many run at once
// and how many run ahead of an earlier sibling's failure.
const LOOKUP_BATCH = 16;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function contained(root: string, path: string): boolean {
  const local = relative(root, path);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

export function projectDiscoveryEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return !["true", "1"].includes(
    environment.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase() ?? "",
  );
}

/** Mirrors ConfigPaths.directories in OpenCode 1.18.34; environment is injectable for isolated tests. */
export async function discoveryDirectories(
  context: DiscoveryContext,
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => Promise<boolean> = exists,
): Promise<string[]> {
  const xdg = environment.XDG_CONFIG_HOME;
  const global = join(
    xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".config"),
    "opencode",
  );
  const directories = [global];
  if (projectDiscoveryEnabled(environment)) {
    const stop =
      context.worktree === "/" ? undefined : resolve(context.worktree);
    for (
      let current = resolve(context.directory), count = 0;
      ;
      current = dirname(current), count++
    ) {
      if (count >= 256) {
        throw new SettingsError(
          "Prompt discovery exceeds the ancestor-directory limit.",
        );
      }
      const directory = join(current, ".opencode");
      if (await pathExists(directory)) {
        directories.push(directory);
      }
      if (current === stop || dirname(current) === current) {
        break;
      }
    }
  }
  const home = join(environment.OPENCODE_TEST_HOME ?? homedir(), ".opencode");
  if (await pathExists(home)) {
    directories.push(home);
  }
  if (
    environment.OPENCODE_CONFIG_DIR !== undefined &&
    environment.OPENCODE_CONFIG_DIR !== ""
  ) {
    directories.push(resolve(environment.OPENCODE_CONFIG_DIR));
  }
  return [...new Set(directories)];
}

export async function discoverPrompts(
  context: DiscoveryContext,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<PromptInventory> {
  const directories = await discoveryDirectories(context, environment);
  const files = new Map<string, DiscoveredPrompt>();
  let entries = 0;
  for (const directory of directories) {
    const root = join(directory, "prompts");
    if (!(await exists(root))) {
      continue;
    }
    const canonicalRoot = await realpath(root);
    // Resolve and check a child before stat so rejected targets are never inspected.
    async function lookup(child: string): Promise<Lookup> {
      try {
        const target = await realpath(child);
        if (!contained(canonicalRoot, target)) {
          throw new SettingsError(
            `A discovered prompt escapes its prompts directory: ${child}.`,
          );
        }
        const local = relative(canonicalRoot, target).split(sep);
        if (local.some((part) => part.startsWith("."))) {
          throw new SettingsError(
            "A discovered prompt resolves to a hidden path.",
          );
        }
        return { metadata: await stat(target) };
      } catch (error) {
        return { error };
      }
    }
    async function scan(path: string, parents: Set<string>): Promise<void> {
      const canonical = await realpath(path);
      if (!contained(canonicalRoot, canonical)) {
        throw new SettingsError(
          `A discovered prompt escapes its prompts directory: ${path}.`,
        );
      }
      if (parents.has(canonical) || parents.size >= 32) {
        throw new SettingsError(
          `Prompt directory cycle or depth limit at ${path}.`,
        );
      }
      const info = await stat(canonical);
      if (!info.isDirectory()) {
        // A child was a directory when looked up, so for a child this means
        // the tree changed during discovery rather than a configuration error.
        throw new SettingsError(
          parents.size === 0
            ? `Prompt discovery expects a directory: ${path}.`
            : `Prompt discovery changed: ${path}. Retry composition.`,
        );
      }
      const names = (await readdir(path))
        .filter((name) => !name.startsWith("."))
        .sort((a, b) => a.localeCompare(b));
      for (let start = 0; start < names.length; start += LOOKUP_BATCH) {
        const batch = names.slice(start, start + LOOKUP_BATCH);
        // Settle a batch of lookups, then apply it in sorted order so the
        // inventory and the first reported error match a sequential walk.
        // Entries past the limit are not looked up; counting fails first.
        const lookups = await Promise.all(
          batch
            .slice(0, MAX_ENTRIES - entries)
            .map((name) => lookup(join(path, name))),
        );
        for (const [index, name] of batch.entries()) {
          if (++entries > MAX_ENTRIES) {
            throw new SettingsError(
              `Prompt discovery exceeds ${MAX_ENTRIES} entries.`,
            );
          }
          const result = lookups[index];
          if ("error" in result) {
            throw result.error;
          }
          const child = join(path, name);
          if (result.metadata.isDirectory()) {
            await scan(child, new Set([...parents, canonical]));
          } else if (
            result.metadata.isFile() &&
            [".md", ".txt"].includes(extname(name).toLowerCase())
          ) {
            const reference = relative(root, child).split(sep).join("/");
            files.set(reference, {
              path: child,
              root,
              relativePath: reference,
            });
          }
        }
      }
    }
    await scan(root, new Set());
  }
  return { directories, files };
}
