import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { DiscoveredPrompt } from "./discovery.ts";
import { SettingsError, diagnosticName, sourcePosition } from "./errors.ts";

export const MAX_SNIPPET_BYTES = 64 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_INCLUDE_DEPTH = 32;
export const MAX_INCLUDES = 256;

const INCLUDE = /\\?\{\{include:([^{}]*)\}\}|\\?\{\{include:/g;

export interface PromptDependency {
  path: string;
  canonicalPath: string;
  text: string;
  mode: number;
}
export type PromptRead = (dependency: PromptDependency) => void;

interface Expansion {
  sources: ReadonlyMap<string, DiscoveredPrompt>;
  includes: number;
  onRead?: PromptRead;
  consumer?: string;
}

interface IncludeFrame {
  path: string;
  reference: string;
}

class IncludeError extends SettingsError {}

function promptSize(text: string): void {
  if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
    throw new SettingsError("The composed prompt exceeds the 256 KiB limit.");
  }
}

function contained(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function safeSnippetPath(path: string): boolean {
  return (
    !path.includes("\\") &&
    !path.includes(":") &&
    !Array.from(path).some((character) => character.charCodeAt(0) < 32) &&
    !isAbsolute(path) &&
    !path
      .split("/")
      .some(
        (part) =>
          part === ".." || part === "." || part === "" || part.startsWith("."),
      ) &&
    [".md", ".txt"].includes(extname(path).toLowerCase())
  );
}

async function snippet(
  reference: string,
  context: Expansion,
): Promise<{ text: string; path: string; sourceText: string; offset: number }> {
  const path = reference;
  if (!safeSnippetPath(path)) {
    throw new SettingsError(
      "Prompt includes require a safe relative .md or .txt file path.",
    );
  }
  const source = context.sources.get(reference);
  if (source === undefined) {
    throw new SettingsError(
      `Prompt ${diagnosticName(reference)} does not exist in the discovered prompts directories.`,
    );
  }
  const root = source.root;
  try {
    const sourceRoot = await realpath(root);
    const target = await realpath(resolve(sourceRoot, path));
    if (!contained(sourceRoot, target)) {
      throw new SettingsError(
        "A prompt include escapes its configured source directory.",
      );
    }
    if (!safeSnippetPath(relative(sourceRoot, target).split(sep).join("/"))) {
      throw new SettingsError(
        "A prompt include resolves to an unsafe file path.",
      );
    }
    const before = await lstat(target);
    if (!before.isFile() || before.size > MAX_SNIPPET_BYTES) {
      throw new SettingsError(
        "Prompt snippets must be regular UTF-8 files no larger than 64 KiB.",
      );
    }
    const file = await open(
      target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const current = await file.stat();
      if (
        !current.isFile() ||
        current.ino !== before.ino ||
        current.dev !== before.dev ||
        current.size > MAX_SNIPPET_BYTES
      ) {
        throw new SettingsError(
          "A prompt snippet changed while loading. Try again.",
        );
      }
      const bytes = await file.readFile();
      if (bytes.length > MAX_SNIPPET_BYTES) {
        throw new SettingsError(
          "Prompt snippets must be no larger than 64 KiB.",
        );
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (text.includes("\0")) {
        throw new SettingsError(
          "Prompt snippets must contain text without NUL bytes.",
        );
      }
      context.onRead?.({
        path: resolve(root, path),
        canonicalPath: target,
        text,
        mode: current.mode & 0o777,
      });
      return {
        text: text.trim(),
        path: target,
        sourceText: text,
        offset: text.length - text.trimStart().length,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof SettingsError) {
      throw error;
    }
    throw new SettingsError(
      `Could not read prompt include ${diagnosticName(reference)}. Check its source directory and file.`,
    );
  }
}

async function expand(
  text: string,
  context: Expansion,
  stack: IncludeFrame[],
  source?: { sourceText: string; offset: number },
): Promise<string> {
  let position = 0;
  let reference: string | undefined;
  try {
    promptSize(text);
    let result = "";
    let cursor = 0;
    for (const match of text.matchAll(INCLUDE)) {
      result += text.slice(cursor, match.index);
      position = match.index;
      reference = undefined;
      const marker = match[0];
      if (marker.startsWith("\\")) {
        result += marker.slice(1);
      } else {
        reference = match.at(1);
        if (reference === undefined) {
          throw new SettingsError(
            "A prompt include has invalid syntax. Use {{include:folder/prompt.md}}.",
          );
        }
        context.includes += 1;
        if (
          context.includes > MAX_INCLUDES ||
          stack.length >= MAX_INCLUDE_DEPTH
        ) {
          throw new SettingsError(
            "The prompt include count or nesting limit was exceeded.",
          );
        }
        const included = await snippet(reference, context);
        if (stack.some((frame) => frame.path === included.path)) {
          throw new SettingsError(
            "The prompt includes contain a cycle. Remove the recursive include.",
          );
        }
        result += await expand(
          included.text,
          context,
          [...stack, { path: included.path, reference }],
          included,
        );
      }
      promptSize(result);
      cursor = match.index + marker.length;
    }
    result += text.slice(cursor);
    promptSize(result);
    return result;
  } catch (error) {
    if (!(error instanceof SettingsError) || error instanceof IncludeError) {
      throw error;
    }
    const references = stack.map((frame) => diagnosticName(frame.reference));
    if (reference !== undefined) {
      references.push(
        safeSnippetPath(reference)
          ? diagnosticName(reference)
          : "[invalid reference]",
      );
    }
    const chain =
      references.length > 8
        ? [...references.slice(0, 3), "...", ...references.slice(-4)]
        : references;
    const frame = stack.at(-1);
    const location =
      source === undefined || frame === undefined
        ? ""
        : ` at ${diagnosticName(frame.reference)}:${sourcePosition(source.sourceText, source.offset + position)}`;
    throw new IncludeError(
      `${error.message}${context.consumer === undefined ? "" : ` Consumer: ${context.consumer}.`}${location}${chain.length === 0 ? "" : ` Include chain: ${chain.join(" -> ")}.`}`,
      { cause: error },
    );
  }
}

export async function expandIncludes(
  text: string,
  sources: ReadonlyMap<string, DiscoveredPrompt>,
  onRead?: PromptRead,
  consumer?: string,
): Promise<string> {
  if (!text.includes("{{include:")) {
    return text;
  }
  return expand(text, { sources, includes: 0, onRead, consumer }, []);
}
