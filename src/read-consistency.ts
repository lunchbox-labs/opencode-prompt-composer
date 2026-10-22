import { lstat, realpath } from "node:fs/promises";
import {
  type LoadedSettings,
  type SourceFile,
  readSource,
} from "./settings.ts";
import { discoverPrompts } from "./discovery.ts";
import { SettingsError } from "./errors.ts";

export async function verifyReads(
  files: SourceFile[],
  missing: string[] = [],
): Promise<void> {
  for (const file of files) {
    if (
      file.canonicalPath !== undefined &&
      (await realpath(file.path)) !== file.canonicalPath
    ) {
      throw new SettingsError(
        `Prompt input changed: ${file.path}. Retry composition.`,
      );
    }
    const current = await readSource(file.canonicalPath ?? file.path);
    if (current.text !== file.text || current.mode !== file.mode) {
      throw new SettingsError(
        `Prompt input changed: ${file.path}. Retry composition.`,
      );
    }
  }
  for (const path of missing) {
    try {
      await lstat(path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
    throw new SettingsError(
      `A prompt source was created: ${path}. Retry composition.`,
    );
  }
}

export async function verifyInventory(settings: LoadedSettings): Promise<void> {
  const current = await discoverPrompts({
    directory: settings.context.directory ?? settings.context.root,
    worktree: settings.context.worktree ?? settings.context.root,
  });
  const identity = (inventory: typeof current) =>
    JSON.stringify([
      inventory.directories,
      [...inventory.files].map(([name, file]) => [name, file.path]),
    ]);
  if (identity(current) !== identity(settings.inventory)) {
    throw new SettingsError("Prompt discovery changed. Retry composition.");
  }
}
