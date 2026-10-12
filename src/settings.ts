import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { Ajv } from "ajv";
import {
  type Node as JsonNode,
  type ParseError,
  parse,
  parseTree,
} from "jsonc-parser";
import schema from "../schema.json" with { type: "json" };
import { type PromptInventory, discoverPrompts } from "./discovery.ts";
import { SettingsError } from "./errors.ts";

export interface Operations {
  prepend?: string[];
  append?: string[];
}
export interface AgentPrompt extends Operations {
  inheritDefaults?: boolean;
}
export interface PromptDocument {
  $schema?: string;
  defaults?: Operations;
  agents?: Record<string, AgentPrompt>;
}
export interface SourceFile {
  path: string;
  text: string;
  mode: number;
  canonicalPath?: string;
}
export interface SourceDocument extends SourceFile {
  value: PromptDocument;
}
export interface SettingsContext {
  root: string;
  directory?: string;
  worktree?: string;
}
export interface LoadedSettings {
  context: SettingsContext;
  documents: SourceDocument[];
  inventory: PromptInventory;
  effective: PromptDocument;
  missing: string[];
}
const validate = new Ajv({ allErrors: true }).compile<PromptDocument>(schema);

function uniqueKeys(node: JsonNode | undefined): void {
  if (node?.type === "object") {
    const keys =
      node.children?.map((child): unknown => child.children?.[0].value) ?? [];
    if (new Set(keys).size !== keys.length) {
      throw new SettingsError("Duplicate JSON keys in prompt settings.");
    }
  }
  node?.children?.forEach(uniqueKeys);
}

const sourceByteLimit = 1024 * 1024;

function validateSourceText(text: string, limit = sourceByteLimit): void {
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new SettingsError("A prompt source exceeds its size limit.");
  }
  if (text.includes("\0")) {
    throw new SettingsError("Prompt sources cannot contain NUL bytes.");
  }
}

export function parseSettings(text: string): PromptDocument {
  validateSourceText(text);
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  uniqueKeys(parseTree(text));
  if (errors.length !== 0 || !validate(value)) {
    throw new SettingsError(
      `Invalid prompt settings. ${validate.errors?.map((item) => `${item.instancePath} ${item.message ?? ""}`).join("; ") ?? ""}`,
    );
  }
  return value;
}

export function configurationDirectory(): string {
  const configured = process.env.OPENCODE_CONFIG_DIR;
  if (configured !== undefined && configured !== "") {
    return resolve(configured);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg !== undefined && isAbsolute(xdg)
    ? join(xdg, "opencode")
    : join(homedir(), ".config/opencode");
}

export function resolvePath(value: string, directory: string): string {
  if (value.trim() === "" || value.includes("\0")) {
    throw new SettingsError("Select a valid prompt settings path.");
  }
  return resolve(
    directory,
    value.startsWith("~/") ? join(homedir(), value.slice(2)) : value,
  );
}

export async function readSource(
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
      throw error;
    }
    throw new SettingsError(
      `Could not read prompt source ${path}. Check that it is a readable UTF-8 regular file.`,
    );
  }
}

export async function loadSettings(
  context: SettingsContext,
  overlays: ReadonlyMap<string, string> = new Map(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<LoadedSettings> {
  const inventory = await discoverPrompts(
    {
      directory: context.directory ?? context.root,
      worktree: context.worktree ?? context.root,
    },
    environment,
  );
  const result: LoadedSettings = {
    context,
    documents: [],
    inventory,
    effective: {},
    missing: [],
  };
  let bytes = 0;
  for (const directory of inventory.directories) {
    const path = join(directory, "prompt-composer.jsonc");
    try {
      await lstat(path);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        result.missing.push(path);
        continue;
      }
      throw error;
    }
    const file = await readSource(path);
    const text = overlays.get(path) ?? file.text;
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > 8 * 1024 * 1024) {
      throw new SettingsError(
        "Prompt settings exceed the 8 MiB total text limit.",
      );
    }
    const value = parseSettings(text);
    result.documents.push({ ...file, text, value });
    if (value.defaults !== undefined) {
      result.effective.defaults = {
        ...result.effective.defaults,
        ...value.defaults,
      };
    }
    for (const [name, policy] of Object.entries(value.agents ?? {})) {
      result.effective.agents ??= {};
      const previous = Object.hasOwn(result.effective.agents, name)
        ? result.effective.agents[name]
        : {};
      Object.defineProperty(result.effective.agents, name, {
        value: { ...previous, ...policy },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return result;
}
