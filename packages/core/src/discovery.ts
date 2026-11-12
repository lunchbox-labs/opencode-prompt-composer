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
import type { Host } from "./host.ts";

export interface DiscoveryContext {
  directory: string;
  worktree: string;
  /** The host whose config directories hold the prompts. */
  host: Host;
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
/** Receives a warning for each entry that lenient discovery leaves out. */
export type SkippedEntry = (warning: string) => void;

/**
 * An entry lenient discovery can leave out. Without a reason it is left out
 * silently, because the result matches what is on disk.
 */
class SkippableEntryError extends SettingsError {
  readonly skipReason: string | undefined;
  constructor(message: string, skipReason?: string) {
    super(message);
    this.skipReason = skipReason;
  }
}
class EntryLimitError extends SettingsError {}

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
  host: Host,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return !["true", "1"].includes(
    environment[host.env.disableProjectConfig]?.toLowerCase() ?? "",
  );
}

/** The host's home directory, as its config paths use it. */
export function hostHome(
  host: Host,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const home = environment[host.env.testHome] ?? homedir();
  return host.trimsHome ? home.trim() : home;
}

/** Mirrors the host's ConfigPaths.directories; environment is injectable for isolated tests. */
export async function discoveryDirectories(
  context: DiscoveryContext,
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => Promise<boolean> = exists,
): Promise<string[]> {
  const { host } = context;
  // A line break pasted into the variable never names a real directory.
  const xdg = environment.XDG_CONFIG_HOME?.replace(/[\r\n]+/g, "");
  const global = join(
    xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), ".config"),
    host.globalDirectory,
  );
  const ancestors: string[] = [];
  let limited = false;
  if (projectDiscoveryEnabled(host, environment)) {
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
      ancestors.push(
        ...host.projectDirectories.map((name) => join(current, name)),
      );
      if (current === stop || dirname(current) === current) {
        break;
      }
    }
  }
  const home = hostHome(host, environment);
  const homes = host.homeDirectories.map((name) => join(home, name));
  // The existence checks are independent. Run them together; the earliest
  // failure in path order is reported, as checking in sequence would.
  const present = await mapBounded(
    limited ? ancestors : [...ancestors, ...homes],
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
  directories.push(
    ...homes.filter((_, index) => present[ancestors.length + index]),
  );
  const custom = environment[host.env.configDirectory];
  if (custom !== undefined && custom !== "") {
    directories.push(resolve(custom));
  }
  return [...new Set(directories)];
}

function skipWarning(error: unknown, path: string): string | undefined {
  if (error instanceof SkippableEntryError) {
    return error.skipReason === undefined
      ? undefined
      : `Ignored ${path}: ${error.skipReason}.`;
  }
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? ` (${error.code})`
      : "";
  return `Ignored ${path}: it could not be read${code}.`;
}

/**
 * Without `skip`, any unusable entry rejects discovery. With it, discovery
 * leaves the entry out, reports why through `skip` when the user can act on
 * it, and stops at the entry limit with what it found. Entries that escape or
 * hide behind their prompts directory are never inspected either way.
 */
export async function discoverPrompts(
  context: DiscoveryContext,
  environment: NodeJS.ProcessEnv = process.env,
  skip?: SkippedEntry,
): Promise<PromptInventory> {
  const directories = await discoveryDirectories(context, environment);
  const files = new Map<string, DiscoveredPrompt>();
  const invalid = new Map<string, DiscoveredPrompt>();
  let entries = 0;
  const leaveOut = (error: unknown, path: string): void => {
    if (skip === undefined || error instanceof EntryLimitError) {
      throw error;
    }
    const warning = skipWarning(error, path);
    if (warning !== undefined) {
      skip(warning);
    }
  };
  async function discoverRoot(directory: string): Promise<void> {
    const root = join(directory, "prompts");
    let present: boolean;
    try {
      present = await exists(root);
    } catch (error) {
      leaveOut(error, root);
      return;
    }
    if (!present) {
      return;
    }
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch (error) {
      // A dangling or looping prompts link provides no prompts, like an absent one.
      if (unresolvable(error)) {
        return;
      }
      leaveOut(error, root);
      return;
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
            throw new SkippableEntryError(
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
          throw new SkippableEntryError(
            `A discovered prompt escapes its prompts directory: ${child}.`,
            "it links outside its prompts directory",
          );
        }
        const local = relative(canonicalRoot, target).split(sep);
        if (local.some((part) => part.startsWith("."))) {
          throw new SkippableEntryError(
            "A discovered prompt resolves to a hidden path.",
            "it resolves to a hidden path",
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
        throw new SkippableEntryError(
          `A discovered prompt escapes its prompts directory: ${path}.`,
          "it links outside its prompts directory",
        );
      }
      if (parents.has(canonical) || parents.size >= 32) {
        throw new SkippableEntryError(
          `Prompt directory cycle or depth limit at ${path}.`,
          parents.has(canonical)
            ? undefined
            : "it exceeds the directory nesting limit",
        );
      }
      const info = await stat(canonical);
      if (!info.isDirectory()) {
        // A child was a directory when looked up, so for a child this means
        // the tree changed during discovery rather than a configuration error.
        throw new SkippableEntryError(
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
            throw new EntryLimitError(
              `Prompt discovery exceeds ${MAX_ENTRIES} entries.`,
            );
          }
          const result = lookups[index];
          const child = join(path, name);
          if ("error" in result) {
            leaveOut(result.error, child);
            continue;
          }
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
            try {
              await scan(child, new Set([...parents, canonical]));
            } catch (error) {
              leaveOut(error, child);
            }
          }
        }
      }
    }
    try {
      await scan(root, new Set());
    } catch (error) {
      leaveOut(error, root);
    }
  }
  try {
    for (const directory of directories) {
      await discoverRoot(directory);
    }
  } catch (error) {
    if (skip === undefined || !(error instanceof EntryLimitError)) {
      throw error;
    }
    skip(
      `The prompts directories have more than ${MAX_ENTRIES} entries; later entries were ignored.`,
    );
  }
  for (const [name, prompt] of invalid) {
    if (!files.has(name)) {
      files.set(name, prompt);
    }
  }
  return { directories, files };
}
