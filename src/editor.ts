import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import type { Config } from "@opencode-ai/plugin";
import {
  type LoadedSettings,
  type SourceFile,
  loadSettings,
  parseSettings,
  readSource,
} from "./settings.ts";
import { type Composition, compose } from "./runtime.ts";
import { discoverPrompts } from "./discovery.ts";
import { SettingsError } from "./errors.ts";

export interface Edit {
  path: string;
  text: string;
}
export interface EditPlan {
  settings: LoadedSettings;
  edits: Edit[];
  preview: Composition;
  reads: SourceFile[];
}

export function editSetting(
  text: string,
  path: (string | number)[],
  value: unknown,
): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    }),
  );
}

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
        `Prompt input changed: ${file.path}. Reopen the editor.`,
      );
    }
    const current = await readSource(file.canonicalPath ?? file.path);
    if (current.text !== file.text || current.mode !== file.mode) {
      throw new SettingsError(
        `Prompt input changed: ${file.path}. Reopen the editor.`,
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
      `A prompt source was created: ${path}. Reopen the editor.`,
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
    throw new SettingsError("Prompt discovery changed. Reopen the editor.");
  }
}

export async function planEdits(
  settings: LoadedSettings,
  native: Config,
  edits: Edit[],
): Promise<EditPlan> {
  if (new Set(edits.map((edit) => edit.path)).size !== edits.length) {
    throw new SettingsError("A file can only be edited once per plan.");
  }
  for (const edit of edits) {
    const source = settings.documents.find((file) => file.path === edit.path);
    if (source === undefined || (source.mode & 0o222) === 0) {
      throw new SettingsError("Select a writable prompt settings source.");
    }
    parseSettings(edit.text, edit.path);
  }
  await verifyInventory(settings);
  await verifyReads(settings.documents, settings.missing);
  const before = await compose(native, settings);
  const updated = await loadSettings(
    settings.context,
    new Map(edits.map((edit) => [edit.path, edit.text])),
  );
  const preview = await compose(native, updated);
  const reads = [...before.reads, ...preview.reads];
  await verifyReads([...settings.documents, ...reads], settings.missing);
  return { settings, edits, preview, reads };
}

export async function savePlan(plan: EditPlan): Promise<void> {
  for (const edit of plan.edits) {
    parseSettings(edit.text, edit.path);
  }
  const held: { path: string; close: () => Promise<void> }[] = [];
  const staged: { edit: Edit; temporary: string; original: SourceFile }[] = [];
  const written: typeof staged = [];
  try {
    for (const path of [
      ...new Set(plan.edits.map((edit) => edit.path)),
    ].sort()) {
      const lockPath = `${path}.prompt-composer.lock`;
      const lock = await open(lockPath, "wx", 0o600).catch(() => {
        throw new SettingsError(
          "Another prompt edit is active. Retry after it finishes.",
        );
      });
      held.push({ path: lockPath, close: () => lock.close() });
    }
    await verifyInventory(plan.settings);
    await verifyReads(
      [...plan.settings.documents, ...plan.reads],
      plan.settings.missing,
    );
    for (const edit of plan.edits) {
      const original = plan.settings.documents.find(
        (file) => file.path === edit.path,
      );
      if (original === undefined) {
        throw new SettingsError("The edit plan is stale.");
      }
      const temporary = join(
        dirname(edit.path),
        `.prompt-composer-${randomUUID()}.tmp`,
      );
      await writeFile(temporary, edit.text, {
        flag: "wx",
        mode: original.mode,
      });
      staged.push({ edit, temporary, original });
      await chmod(temporary, original.mode);
    }
    await verifyInventory(plan.settings);
    await verifyReads(
      [...plan.settings.documents, ...plan.reads],
      plan.settings.missing,
    );
    for (const item of staged) {
      await rename(item.temporary, item.edit.path);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) {
      const current = await readSource(item.edit.path);
      if (current.text !== item.edit.text) {
        throw new SettingsError(
          `Concurrent edit prevented rollback of ${item.edit.path}. Inspect the file before retrying.`,
        );
      }
      await writeFile(item.temporary, item.original.text, {
        flag: "wx",
        mode: item.original.mode,
      });
      await chmod(item.temporary, item.original.mode);
      await rename(item.temporary, item.edit.path);
    }
    throw error;
  } finally {
    for (const item of staged) {
      await rm(item.temporary, { force: true });
    }
    for (const lock of held.reverse()) {
      await lock.close();
      await rm(lock.path, { force: true });
    }
  }
}
