import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  type DiscoveredPrompt,
  type DiscoveryContext,
  discoverPrompts,
} from "./discovery.ts";
import {
  type PromptDependency,
  expandWithReader,
  missingSnippet,
  readSnippet,
} from "./include-core.ts";
import { verifyInventory, verifyReads } from "./read-consistency.ts";

type Expand = (text: string, consumer: string) => Promise<string>;
type Captured = { source: PromptDependency } | { error: unknown };

// Native instance disposal reruns factories but keeps the same imported module.
const snapshots = new Map<string, Promise<Expand>>();

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

async function capture(
  context: DiscoveryContext,
  environment: NodeJS.ProcessEnv,
): Promise<Expand> {
  const inventory = await discoverPrompts(context, environment);
  // Bound open handles even for the largest supported prompt inventory.
  const entries = [...inventory.files];
  const loaded: Captured[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(16, entries.length) }, async () => {
      while (next < entries.length) {
        const index = next++;
        const [reference, source] = entries[index];
        loaded[index] = await read(reference, source);
      }
    }),
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
  // Detect edits to early reads and discovery changes before publishing.
  await verifyReads(reads);
  await verifyInventory(context, inventory, environment);
  return (text, consumer) =>
    expandWithReader(
      text,
      (reference) => {
        const entry = captured.get(reference);
        if (entry === undefined) {
          throw missingSnippet(reference);
        }
        if ("error" in entry) {
          throw entry.error;
        }
        return Promise.resolve(entry.source);
      },
      consumer,
    );
}

/** Capture all winning raw snippets once, including files first used by later skills/profiles. */
export function startupSnippets(context: DiscoveryContext): Promise<Expand> {
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
  // Keep hooks registered if capture fails; they report the same failure on use.
  // The rejected promise stays cached so repaired files cannot silently reload.
  loaded.catch(() => undefined);
  return loaded;
}
