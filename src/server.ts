import type { Config, Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { expandIncludes } from "./includes.ts";
import { SettingsError } from "./errors.ts";
import { discoverPrompts } from "./discovery.ts";
import { compose } from "./runtime.ts";
import { verifyInventory, verifyReads } from "./read-consistency.ts";

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
  if (Object.keys(options).length > 0) {
    throw new SettingsError("Prompt Composer does not accept plugin options.");
  }
  const context = {
    directory: input.directory,
    worktree: input.worktree,
  };
  const snapshots = new WeakMap<object, { native: Bodies; applied: Bodies }>();
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
      const inventory = await discoverPrompts(context);
      const composed = await compose(native, inventory);
      await verifyReads(composed.reads);
      await verifyInventory(context, inventory);
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
        const inventory = await discoverPrompts(context);
        output.output = await expandIncludes(
          output.output,
          inventory.files,
          undefined,
          "skill output (source file unavailable)",
        );
      }
    },
  } satisfies Hooks);
};

export default {
  id: "prompt-composer",
  server: PromptComposer,
} satisfies PluginModule;
