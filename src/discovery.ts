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
import { mapBounded } from "./bounded.ts";
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
  /**
   * Winning prompts by relative path. A `.md` or `.txt` name that is not a
   * regular file is kept when no root has a regular file at that path, so
   * reading it fails as invalid instead of being treated as absent.
   */
  files: Map<string, DiscoveredPrompt>;
}
type Lookup =
  { metadata: Stats } | { brokenSymlink: true } | { error: unknown };

const MAX_ENTRIES = 4096;
// Bounds how many child lookups run at once and how many run ahead of an
// earlier sibling's failure. Under Bun each realpath briefly holds an O_PATH
// descriptor, so in the plugin host this also bounds discovery's descriptors.
const LOOKUP_BATCH = 16;

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function unresolvable(error: unknown): boolean {
  return hasCode(error, "ENOENT", "ELOOP", "ENOTDIR");
}

function promptName(name: string): boolean {
  return [".md", ".txt"].includes(extname(name).toLowerCase());
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
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

/** Mirrors ConfigPaths.directories in OpenCode 1.19.0 through 1.19.5; environment is injectable for isolated tests. */
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
  const ancestors: string[] = [];
  let limited = false;
  if (projectDiscoveryEnabled(environment)) {
    const stop =
      context.worktree === "/" ? undefined : resolve(context.worktree);
    for (
      let current = resolve(context.directory), count = 0;
      ;
      current = dirname(current), count++
    ) {
      if (count >= 256) {
        limited = true;
        break;
      }
      ancestors.push(join(current, ".opencode"));
      if (current === stop || dirname(current) === current) {
        break;
      }
    }
  }
  const home = join(environment.OPENCODE_TEST_HOME ?? homedir(), ".opencode");
  // The existence checks are independent. Run them together; the earliest
  // failure in path order is reported, as checking in sequence would.
  const present = await mapBounded(
    limited ? ancestors : [...ancestors, home],
    pathExists,
  );
  if (limited) {
    throw new SettingsError(
      "Prompt discovery exceeds the ancestor-directory limit.",
    );
  }
  const directories = [
    global,
    ...ancestors.filter((_, index) => present[index]),
  ];
  if (present[ancestors.length]) {
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
  const invalid = new Map<string, DiscoveredPrompt>();
  let entries = 0;
  for (const directory of directories) {
    const root = join(directory, "prompts");
    if (!(await exists(root))) {
      continue;
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch (error) {
      // A dangling or looping prompts link provides no prompts, like an absent one.
      if (unresolvable(error)) {
        continue;
      }
      throw error;
    }
    async function resolveChild(child: string): Promise<string | undefined> {
      try {
        return await realpath(child);
      } catch (error) {
        if (!unresolvable(error)) {
          throw error;
        }
        let entry: Stats;
        try {
          entry = await lstat(child);
        } catch (missing) {
          if (hasCode(missing, "ENOENT")) {
            throw new SettingsError(
              `Prompt discovery changed: ${child}. Retry composition.`,
            );
          }
          throw missing;
        }
        if (entry.isSymbolicLink()) {
          return undefined;
        }
        throw error;
      }
    }
    // Resolve and check a child before stat so rejected targets are never inspected.
    async function lookup(child: string): Promise<Lookup> {
      try {
        const target = await resolveChild(child);
        if (target === undefined) {
          return { brokenSymlink: true };
        }
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
        // No lookup starts for entries the count already places past the
        // limit. Walking an earlier subdirectory can use up the rest, so up to
        // LOOKUP_BATCH - 1 later siblings per directory still being walked may
        // be looked up past it; counting fails before their results are used.
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
          const metadata = "metadata" in result ? result.metadata : undefined;
          // A broken symlink with a prompt name fails only when an include
          // uses it, like other present names that are not regular files.
          if (promptName(name)) {
            const reference = relative(root, child).split(sep).join("/");
            (metadata?.isFile() === true ? files : invalid).set(reference, {
              path: child,
              root,
              relativePath: reference,
            });
          }
          if (metadata?.isDirectory() === true) {
            await scan(child, new Set([...parents, canonical]));
          }
        }
      }
    }
    await scan(root, new Set());
  }
  for (const [name, prompt] of invalid) {
    if (!files.has(name)) {
      files.set(name, prompt);
    }
  }
  return { directories, files };
}
