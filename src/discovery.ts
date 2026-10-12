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
    environment.OPENCODE_DISABLE_PROJECT_CONFIG ?? "",
  );
}

/** Mirrors ConfigPaths.directories in OpenCode 1.18.34; environment is injectable for isolated tests. */
export async function discoveryDirectories(
  context: DiscoveryContext,
  environment: NodeJS.ProcessEnv = process.env,
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
      if (await exists(directory)) {
        directories.push(directory);
      }
      if (current === stop || dirname(current) === current) {
        break;
      }
    }
  }
  const home = join(environment.OPENCODE_TEST_HOME ?? homedir(), ".opencode");
  if (await exists(home)) {
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
        throw new SettingsError(
          `Prompt discovery expects a directory: ${path}.`,
        );
      }
      for (const entry of (await readdir(path, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        if (++entries > 4096) {
          throw new SettingsError("Prompt discovery exceeds 4096 entries.");
        }
        const child = join(path, entry.name);
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
        const metadata = await stat(target);
        if (metadata.isDirectory()) {
          await scan(child, new Set([...parents, canonical]));
        } else if (
          metadata.isFile() &&
          [".md", ".txt"].includes(extname(entry.name).toLowerCase())
        ) {
          const name = relative(root, child).split(sep).join("/");
          files.set(name, { path: child, root, relativePath: name });
        }
      }
    }
    await scan(root, new Set());
  }
  return { directories, files };
}
