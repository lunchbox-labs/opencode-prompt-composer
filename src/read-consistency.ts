import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  type DiscoveryContext,
  type PromptInventory,
  discoverPrompts,
} from "./discovery.ts";
import { SettingsError } from "./errors.ts";

export interface SourceFile {
  path: string;
  text: string;
  mode: number;
  canonicalPath?: string;
}

const sourceByteLimit = 64 * 1024;

function validateSourceText(text: string, limit = sourceByteLimit): void {
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new SettingsError("A prompt source exceeds its size limit.");
  }
  if (text.includes("\0")) {
    throw new SettingsError("Prompt sources cannot contain NUL bytes.");
  }
}

async function readSource(
  path: string,
  limit = sourceByteLimit,
): Promise<SourceFile> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > limit) {
      throw new SettingsError(
        "Prompt sources must be regular files within the size limit.",
      );
    }
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const current = await file.stat();
      if (
        !current.isFile() ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        current.size > limit
      ) {
        throw new SettingsError(
          "A prompt source changed while loading. Try again.",
        );
      }
      const bytes = await file.readFile();
      if (bytes.length > limit) {
        throw new SettingsError("A prompt source exceeds its size limit.");
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      validateSourceText(text, limit);
      return { path, text, mode: current.mode & 0o777 };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof SettingsError) {
      throw new SettingsError(
        `${error.message} Source: ${JSON.stringify(path)}.`,
        { cause: error },
      );
    }
    throw new SettingsError(
      `Could not read prompt source ${path}. Check that it is a readable UTF-8 regular file.`,
    );
  }
}

export async function verifyReads(files: SourceFile[]): Promise<void> {
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
}

export async function verifyInventory(
  context: DiscoveryContext,
  inventory: PromptInventory,
): Promise<void> {
  const current = await discoverPrompts(context);
  const identity = (inventory: typeof current) =>
    JSON.stringify([
      inventory.directories,
      [...inventory.files].map(([name, file]) => [name, file.path]),
    ]);
  if (identity(current) !== identity(inventory)) {
    throw new SettingsError("Prompt discovery changed. Retry composition.");
  }
}
