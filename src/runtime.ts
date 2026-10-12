import type { Config } from "@opencode-ai/plugin";
import { type PromptDependency, expandIncludes } from "./includes.ts";
import type { LoadedSettings, Operations, SourceFile } from "./settings.ts";
import { SettingsError, diagnosticName } from "./errors.ts";

export interface Diagnostic {
  kind: "agent" | "prompt";
  name: string;
  agent?: string;
  message: string;
}
export interface Composition {
  config: Config;
  diagnostics: Diagnostic[];
  reads: SourceFile[];
}
export async function compose(
  config: Config,
  settings: LoadedSettings,
  overlays: ReadonlyMap<string, string> = new Map(),
): Promise<Composition> {
  const result = structuredClone(config);
  const diagnostics: Diagnostic[] = [];
  const reads: SourceFile[] = [];
  const recordRead = (file: PromptDependency) => {
    reads.push({
      path: file.path,
      canonicalPath: file.canonicalPath,
      text: file.text,
      mode: file.mode,
    });
  };
  const expand = (text: string, consumer: string) =>
    expandIncludes(
      text,
      settings.inventory.files,
      recordRead,
      overlays,
      consumer,
    );
  const meaningful = new Set<Operations>();
  const policies = [
    { name: undefined, policy: settings.effective.defaults ?? {} },
    ...Object.entries(settings.effective.agents ?? {}).map(
      ([name, policy]) => ({ name, policy }),
    ),
  ];
  for (const { name, policy } of policies) {
    for (const operation of ["prepend", "append"] as const) {
      const owner = settings.documents.findLast((document) => {
        const value =
          name === undefined
            ? document.value.defaults
            : Object.hasOwn(document.value.agents ?? {}, name)
              ? document.value.agents?.[name]
              : undefined;
        return value?.[operation] !== undefined;
      });
      const pointer =
        name === undefined
          ? "/defaults"
          : `/agents/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
      for (const [index, text] of (policy[operation] ?? []).entries()) {
        const expanded = await expand(
          text,
          `settings${owner === undefined ? "" : ` ${diagnosticName(owner.path)}`} ${diagnosticName(`${pointer}/${operation}/${index}`)}`,
        );
        if (expanded.trim() !== "") {
          meaningful.add(policy);
        }
      }
    }
  }
  for (const [name, policy] of Object.entries(
    settings.effective.agents ?? {},
  )) {
    const agent = config.agent?.[name];
    if (
      !Object.hasOwn(config.agent ?? {}, name) ||
      config.agent?.[name]?.disable === true
    ) {
      diagnostics.push({
        kind: "agent",
        name,
        message: `Agent ${name} is missing or disabled; its prompt operations were skipped.`,
      });
    } else if (
      agent !== undefined &&
      (typeof agent.prompt !== "string" || agent.prompt.trim() === "") &&
      (meaningful.has(policy) ||
        (policy.inheritDefaults !== false &&
          meaningful.has(settings.effective.defaults ?? {})))
    ) {
      diagnostics.push({
        kind: "agent",
        name,
        message: `Agent ${name} has no authored prompt; its prompt additions were skipped to preserve OpenCode's native fallback.`,
      });
    }
  }
  for (const [name, agent] of Object.entries(result.agent ?? {})) {
    if (
      agent === undefined ||
      agent.disable === true ||
      typeof agent.prompt !== "string" ||
      agent.prompt.trim() === ""
    ) {
      continue;
    }
    const policy = Object.hasOwn(settings.effective.agents ?? {}, name)
      ? (settings.effective.agents?.[name] ?? {})
      : {};
    const operations = [
      ...(policy.inheritDefaults === false
        ? []
        : [settings.effective.defaults ?? {}]),
      policy,
    ];
    const parts = [
      ...operations.flatMap((item) => item.prepend ?? []),
      agent.prompt,
      ...operations.flatMap((item) => item.append ?? []),
    ];
    agent.prompt = await expand(
      parts.join("\n\n"),
      `agent ${diagnosticName(name)}`,
    );
  }
  for (const [name, command] of Object.entries(result.command ?? {})) {
    if (typeof command.template !== "string") {
      throw new SettingsError("Native commands must contain valid templates.");
    }
    if (command.template.includes("{{include:")) {
      command.template = await expand(
        command.template,
        `command ${diagnosticName(name)}`,
      );
    }
  }
  return { config: result, diagnostics, reads };
}
