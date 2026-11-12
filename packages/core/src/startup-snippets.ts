import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  type DiscoveredPrompt,
  type DiscoveryContext,
  discoverPrompts,
  hostHome,
} from "./discovery.ts";
import {
  type PromptDependency,
  type SkippedInclude,
  SnippetChangedError,
  expandWithReader,
  readSnippet,
} from "./include-core.ts";
import { mapBounded } from "./bounded.ts";
import { SettingsError } from "./errors.ts";
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
interface FailedRead {
  reference: string;
  source: DiscoveredPrompt;
  error: unknown;
}

const CAPTURE_ATTEMPTS = 3;
const snippetKeptChanging = (product: string) =>
  `A prompt snippet kept changing while loading. Restart ${product} once edits settle.`;

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

/**
 * A read that failed because an editor was saving the file at that moment
 * succeeds, or fails differently, when read again. Only a failure that repeats
 * unchanged is kept in the capture.
 */
async function verifyFailedReads(failed: readonly FailedRead[]): Promise<void> {
  await mapBounded(failed, async ({ reference, source, error }) => {
    const changedWhileReading = () =>
      new SettingsError(
        `Prompt input changed: ${source.path}. Retry composition.`,
      );
    if (error instanceof SnippetChangedError) {
      throw changedWhileReading();
    }
    const again = await read(reference, source);
    if (
      "source" in again ||
      errorMessage(again.error) !== errorMessage(error)
    ) {
      throw changedWhileReading();
    }
  });
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
  const failedReads: FailedRead[] = [];
  for (const [index, [reference, source]] of entries.entries()) {
    const entry = loaded[index];
    captured.set(reference, entry);
    if ("source" in entry) {
      reads.push(entry.source);
    } else {
      failedReads.push({ reference, source, error: entry.error });
    }
  }
  // Detect edits to early reads, reads that failed mid-save, and discovery
  // changes before publishing. Read checks run in sequence beside discovery,
  // so together they hold at most twice the descriptors of either one. An
  // edited read is still reported before a discovery change, as checking in
  // sequence would.
  const checks = await Promise.allSettled([
    verifyReads(reads).then(() => verifyFailedReads(failedReads)),
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
          // Hooks reuse this capture until restart, so trying again cannot help.
          throw entry.error instanceof SnippetChangedError
            ? new SettingsError(snippetKeptChanging(context.host.name))
            : entry.error;
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
      // The verification advice targets library callers; here, a restart retries.
      const reason = errorMessage(attempted.changed)
        .replace(/ Retry composition\.$/, "")
        .replace(" Try again.", "");
      warnings.push(
        `Prompt files could not be confirmed unchanged after ${CAPTURE_ATTEMPTS} reads, so the latest reads are used. Restart ${context.host.name} once edits settle. ${reason}`,
      );
    }
    return { expand: attempted.expand, warnings };
  }
}

/** Capture all winning raw snippets once, including files first used by later skills/profiles. */
export function startupSnippets(
  context: DiscoveryContext,
): Promise<StartupSnippets> {
  const { host } = context;
  const normalized = {
    directory: resolve(context.directory),
    worktree: resolve(context.worktree),
    host,
  };
  const key = JSON.stringify([
    host.name,
    normalized.directory,
    normalized.worktree,
  ]);
  const previous = snapshots.get(key);
  if (previous !== undefined) {
    return previous;
  }
  const home = homedir();
  const environment = { ...process.env };
  const xdg = environment.XDG_CONFIG_HOME;
  environment.XDG_CONFIG_HOME =
    xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".config");
  environment[host.env.testHome] = resolve(hostHome(host, environment));
  const custom = environment[host.env.configDirectory];
  if (custom !== undefined && custom !== "") {
    environment[host.env.configDirectory] = resolve(custom);
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
