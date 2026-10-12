import { createHash } from "node:crypto";
import type { Config } from "@opencode-ai/plugin";
import {
  type SettingsContext,
  type SourceFile,
  configurationDirectory,
} from "./settings.ts";
import { serverEntry } from "./registration.ts";
import { SettingsError } from "./errors.ts";

const key = "__promptComposerRuntime";
export const fingerprint = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function bodyConfig(config: Config): Config {
  return {
    agent: Object.fromEntries(
      Object.entries(config.agent ?? {}).map(([name, value]) => [
        name,
        {
          ...(value?.prompt === undefined ? {} : { prompt: value.prompt }),
          ...(value?.disable === undefined ? {} : { disable: value.disable }),
        },
      ]),
    ),
    command: Object.fromEntries(
      Object.entries(config.command ?? {}).map(([name, value]) => [
        name,
        { template: value.template },
      ]),
    ),
  };
}

export function publishState(
  config: Config,
  options: Record<string, unknown>,
  native: Config,
  context: SettingsContext,
  files: SourceFile[],
): void {
  const matches = (config.plugin ?? []).flatMap((entry, index) =>
    (Array.isArray(entry) && entry[1] === options) ||
    serverEntry(
      Array.isArray(entry) ? entry[0] : entry,
      configurationDirectory(),
    )
      ? [index]
      : [],
  );
  if (matches.length !== 1) {
    return;
  }
  const next = [...(config.plugin ?? [])];
  const entry = next[matches[0]];
  next[matches[0]] = [
    Array.isArray(entry) ? entry[0] : entry,
    {
      ...(Array.isArray(entry) ? entry[1] : {}),
      [key]: {
        version: 1,
        context: {
          ...context,
          directory: context.directory ?? context.root,
          worktree: context.worktree ?? context.root,
        },
        native: bodyConfig(native),
        applied: bodyConfig(config),
        inputs: Object.fromEntries(
          files.map((file) => [file.path, fingerprint(file.text)]),
        ),
      },
    },
  ];
  config.plugin = next;
}

function parseBodies(value: unknown): Config {
  if (
    !record(value) ||
    (value.agent !== undefined && !record(value.agent)) ||
    (value.command !== undefined && !record(value.command))
  ) {
    throw new SettingsError("Invalid Prompt Composer native baseline.");
  }
  const agent: NonNullable<Config["agent"]> = {};
  const command: NonNullable<Config["command"]> = {};
  for (const [name, item] of Object.entries(value.agent ?? {})) {
    if (
      !record(item) ||
      (item.prompt !== undefined && typeof item.prompt !== "string") ||
      (item.disable !== undefined && typeof item.disable !== "boolean")
    ) {
      throw new SettingsError("Invalid native agent baseline.");
    }
    Object.defineProperty(agent, name, {
      value: { prompt: item.prompt, disable: item.disable },
      enumerable: true,
    });
  }
  for (const [name, item] of Object.entries(value.command ?? {})) {
    if (!record(item) || typeof item.template !== "string") {
      throw new SettingsError("Invalid native command baseline.");
    }
    Object.defineProperty(command, name, {
      value: { template: item.template },
      enumerable: true,
    });
  }
  return { agent, command };
}

export function readState(
  config: unknown,
  root: string,
): {
  native: Config;
  context: SettingsContext;
  inputs: Record<string, string>;
} {
  if (!record(config) || !Array.isArray(config.plugin)) {
    throw new SettingsError(
      "Prompt Composer server registration is unavailable.",
    );
  }
  const markers: unknown[] = config.plugin.flatMap((entry: unknown) =>
    Array.isArray(entry) && record(entry[1]) && record(entry[1][key])
      ? [entry[1][key]]
      : [],
  );
  const marker = markers[0];
  if (
    markers.length !== 1 ||
    !record(marker) ||
    marker.version !== 1 ||
    !record(marker.context) ||
    marker.context.root !== root ||
    typeof marker.context.directory !== "string" ||
    typeof marker.context.worktree !== "string" ||
    !record(marker.inputs)
  ) {
    throw new SettingsError(
      "Matching Prompt Composer server baseline is unavailable. Reload the server plugin before editing.",
    );
  }
  const applied = parseBodies(marker.applied);
  if (
    JSON.stringify(bodyConfig(applied)) !==
    JSON.stringify(bodyConfig(parseBodies(config)))
  ) {
    throw new SettingsError(
      "Native prompt state changed after composition. Reload before editing.",
    );
  }
  const inputs: Record<string, string> = {};
  for (const [path, hash] of Object.entries(marker.inputs)) {
    if (typeof hash !== "string") {
      throw new SettingsError("Invalid prompt input revision.");
    }
    Object.defineProperty(inputs, path, { value: hash, enumerable: true });
  }
  return {
    native: parseBodies(marker.native),
    context: {
      root,
      directory: marker.context.directory,
      worktree: marker.context.worktree,
    },
    inputs,
  };
}
