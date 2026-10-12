import type { Config, Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { expandIncludes } from "./includes.ts";
import { SettingsError } from "./errors.ts";
import { loadSettings } from "./settings.ts";
import { compose } from "./runtime.ts";
import { publishState } from "./runtime-state.ts";
import { verifyInventory, verifyReads } from "./editor.ts";
import { captureFilesystem } from "./filesystem.ts";

interface Bodies {
  agents: Record<string, string>;
  commands: Record<string, string>;
}
function bodies(config: Config): Bodies {
  return {
    agents: Object.fromEntries(
      Object.entries(config.agent ?? {}).flatMap(([name, value]) =>
        typeof value?.prompt === "string" ? [[name, value.prompt]] : [],
      ),
    ),
    commands: Object.fromEntries(
      Object.entries(config.command ?? {}).map(([name, value]) => [
        name,
        value.template,
      ]),
    ),
  };
}
const PromptComposer: Plugin = (input, options = {}) => {
  if (
    Object.keys(options).some((key) => !["reloadToken"].includes(key)) ||
    (options.reloadToken !== undefined &&
      typeof options.reloadToken !== "string")
  ) {
    throw new SettingsError(
      "Prompt Composer plugin options support only reloadToken.",
    );
  }
  const context = {
    root:
      input.worktree !== "" && input.worktree !== "/"
        ? input.worktree
        : input.directory,
    directory: input.directory,
    worktree: input.worktree,
  };
  const snapshots = new WeakMap<object, { native: Bodies; applied: Bodies }>();
  let lastDiagnostic = "";
  return Promise.resolve({
    config: async (config) => {
      const native = structuredClone(config);
      const previous = snapshots.get(config);
      if (previous !== undefined) {
        for (const [name, agent] of Object.entries(native.agent ?? {})) {
          if (
            agent !== undefined &&
            Object.hasOwn(previous.applied.agents, name) &&
            agent.prompt === previous.applied.agents[name]
          ) {
            agent.prompt = previous.native.agents[name];
          }
        }
        for (const [name, command] of Object.entries(native.command ?? {})) {
          if (
            Object.hasOwn(previous.applied.commands, name) &&
            command.template === previous.applied.commands[name]
          ) {
            command.template = previous.native.commands[name];
          }
        }
      }
      const settings = await loadSettings(context);
      const composed = await compose(native, settings);
      await verifyReads(
        [...settings.documents, ...composed.reads],
        settings.missing,
      );
      await verifyInventory(settings);
      // Publish only once the entire composition succeeds. Preserve all host metadata.
      if (composed.config.agent !== undefined) {
        config.agent = composed.config.agent;
      }
      if (composed.config.command !== undefined) {
        config.command = composed.config.command;
      }
      snapshots.set(config, {
        native: bodies(native),
        applied: bodies(composed.config),
      });
      const diagnostic = composed.diagnostics
        .map((item) => item.message)
        .join("\n");
      if (diagnostic !== "" && diagnostic !== lastDiagnostic) {
        console.error(`[Prompt Composer] ${diagnostic}`);
      }
      lastDiagnostic = diagnostic;
      publishState(
        config,
        options,
        native,
        context,
        [...settings.documents, ...composed.reads],
        await captureFilesystem(context).catch(() => undefined),
      );
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "skill") {
        return;
      }
      const metadata: unknown = output.metadata;
      if (
        typeof metadata === "object" &&
        metadata !== null &&
        "truncated" in metadata &&
        metadata.truncated === true
      ) {
        throw new SettingsError(
          "The skill output was truncated before composition. Reduce its size and load it again.",
        );
      }
      if (output.output.includes("{{include:")) {
        const settings = await loadSettings(context);
        output.output = await expandIncludes(
          output.output,
          settings.inventory.files,
        );
      }
    },
  } satisfies Hooks);
};

export default {
  id: "prompt-composer",
  server: PromptComposer,
} satisfies PluginModule;
