import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  type DiscoveredPrompt,
  type DiscoveryContext,
  discoverPrompts,
} from "./discovery.ts";
import {
  type PromptDependency,
  type SkippedInclude,
  expandWithReader,
  readSnippet,
} from "./include-core.ts";
import { mapBounded } from "./bounded.ts";
import { errorMessage } from "./notices.ts";
import { verifyInventory, verifyReads } from "./read-consistency.ts";

export type Expand = (
  text: string,
  consumer: string,
  skip: SkippedInclude,
) => Promise<string>;
export interface StartupSnippets {
  expand: Expand;
  /** What capture left out or could not confirm; composition still uses the rest. */
  warnings: readonly string[];
}
type Captured = { source: PromptDependency } | { error: unknown };

const CAPTURE_ATTEMPTS = 3;

// Native instance disposal reruns factories but keeps the same imported module.
const snapshots = new Map<string, Promise<StartupSnippets>>();

async function read(
  reference: string,
  source: DiscoveredPrompt,
): Promise<Captured> {
  try {
    return { source: await readSnippet(reference, source) };
  } catch (error) {
    // An unused invalid file must not prevent otherwise valid composition.
    return { error };
  }
}

async function captureOnce(
  context: DiscoveryContext,
  environment: NodeJS.ProcessEnv,
  skip: (warning: string) => void,
): Promise<{ expand: Expand; changed?: unknown }> {
  const inventory = await discoverPrompts(context, environment, skip);
  const entries = [...inventory.files];
  const loaded = await mapBounded(entries, ([reference, source]) =>
    read(reference, source),
  );
  const captured = new Map<string, Captured>();
  const reads: PromptDependency[] = [];
  for (const [index, [reference]] of entries.entries()) {
    const entry = loaded[index];
    captured.set(reference, entry);
    if ("source" in entry) {
      reads.push(entry.source);
    }
  }
  // Detect edits to early reads and discovery changes before publishing. Both
  // checks only read, so they run together; together they hold at most twice
  // the descriptors of either one. An edited read is still reported before a
  // discovery change, as checking in sequence would.
  const checks = await Promise.allSettled([
    verifyReads(reads),
    verifyInventory(context, inventory, environment, () => undefined),
  ]);
  const changed: unknown = checks.find(
    (check): check is PromiseRejectedResult => check.status === "rejected",
  )?.reason;
  const expand: Expand = (text, consumer, skipInclude) =>
    expandWithReader(
      text,
      (reference) => {
        const entry = captured.get(reference);
        if (entry === undefined) {
          return Promise.resolve(undefined);
        }
        if ("error" in entry) {
          throw entry.error;
        }
        return Promise.resolve(entry.source);
      },
      consumer,
      skipInclude,
    );
  return { expand, changed };
}

async function capture(
  context: DiscoveryContext,
  environment: NodeJS.ProcessEnv,
): Promise<StartupSnippets> {
  for (let attempt = 1; ; attempt++) {
    const warnings: string[] = [];
    const attempted = await captureOnce(context, environment, (warning) =>
      warnings.push(warning),
    );
    if (attempted.changed !== undefined) {
      if (attempt < CAPTURE_ATTEMPTS) {
        continue;
      }
      warnings.push(
        `Prompt files kept changing while loading, so the latest reads are used. ${errorMessage(attempted.changed)}`,
      );
    }
    return { expand: attempted.expand, warnings };
  }
}

/** Capture all winning raw snippets once, including files first used by later skills/profiles. */
export function startupSnippets(
  context: DiscoveryContext,
): Promise<StartupSnippets> {
  const normalized = {
    directory: resolve(context.directory),
    worktree: resolve(context.worktree),
  };
  const key = JSON.stringify([normalized.directory, normalized.worktree]);
  const previous = snapshots.get(key);
  if (previous !== undefined) {
    return previous;
  }
  const home = homedir();
  const environment = { ...process.env };
  const xdg = environment.XDG_CONFIG_HOME;
  environment.XDG_CONFIG_HOME =
    xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config");
  environment.OPENCODE_TEST_HOME = resolve(
    environment.OPENCODE_TEST_HOME ?? home,
  );
  if (
    environment.OPENCODE_CONFIG_DIR !== undefined &&
    environment.OPENCODE_CONFIG_DIR !== ""
  ) {
    environment.OPENCODE_CONFIG_DIR = resolve(environment.OPENCODE_CONFIG_DIR);
  }
  const loaded = capture(normalized, environment);
  snapshots.set(key, loaded);
  // Hooks report a failed capture on use. Forget it so the next instance
  // reload captures again instead of keeping the failure until restart.
  loaded.catch(() => {
    if (snapshots.get(key) === loaded) {
      snapshots.delete(key);
    }
  });
  return loaded;
}
