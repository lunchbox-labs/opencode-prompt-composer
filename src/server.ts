import type { Config, Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { SettingsError } from "./errors.ts";
import { notifyFailure } from "./notices.ts";
import { compose } from "./runtime.ts";
import { expandSkillBody } from "./skill-body.ts";
import { startupSnippets } from "./startup-snippets.ts";

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
  const startup = startupSnippets(context);
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
      let composed: Config;
      try {
        composed = await compose(native, await startup);
      } catch (error) {
        // The host logs and ignores this rejection; tell the user directly.
        const reason = error instanceof Error ? error.message : String(error);
        notifyFailure(input, `Prompt composition failed. ${reason}`);
        throw error;
      }
      // Publish only once the entire composition succeeds. Preserve all host metadata.
      if (composed.agent !== undefined) {
        config.agent = composed.agent;
      }
      if (composed.command !== undefined) {
        config.command = composed.command;
      }
      snapshots.set(config, {
        native: bodies(native),
        applied: bodies(composed),
      });
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "skill") {
        return;
      }
      output.output = await expandSkillBody(
        output.output,
        output.metadata,
        async (body) => {
          return (await startup)(
            body,
            "skill output (source file unavailable)",
          );
        },
      );
    },
  } satisfies Hooks);
};

export default {
  id: "prompt-composer",
  server: PromptComposer,
} satisfies PluginModule;
