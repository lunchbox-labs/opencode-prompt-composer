import type { Config, Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { diagnosticName } from "./errors.ts";
import { errorMessage, firstProblem, notify } from "./notices.ts";
import { type IncompleteConsumer, compose } from "./runtime.ts";
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
function incompleteMessage(incomplete: IncompleteConsumer[]): string {
  const consumers = incomplete.map((entry) => entry.consumer);
  const named =
    consumers.length > 3
      ? `${consumers.slice(0, 3).join(", ")} and ${consumers.length - 3} more`
      : consumers.join(", ");
  return `Some includes were not expanded in ${named}. ${firstProblem(incomplete.flatMap((entry) => entry.problems))}`;
}

const PromptComposer: Plugin = (input, options = {}) => {
  const ignoredOptions = Object.keys(options).map(diagnosticName);
  let firstConfig = true;
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
      const notices: string[] = [];
      let variant: "warning" | "error" = "warning";
      const announce = () => {
        if (notices.length > 0) {
          notify(input, notices.join(" "), variant);
        }
      };
      const first = firstConfig;
      firstConfig = false;
      if (first && ignoredOptions.length > 0) {
        notices.push(
          `Plugin options are not supported and were ignored: ${ignoredOptions.join(", ")}.`,
        );
      }
      let snippets: Awaited<typeof startup>;
      try {
        snippets = await startup;
      } catch (error) {
        variant = "error";
        notices.push(
          `Prompts could not be loaded, so includes were not expanded. ${errorMessage(error)}`,
        );
        announce();
        return;
      }
      if (first) {
        notices.push(...snippets.warnings);
      }
      const { config: composed, incomplete } = await compose(
        native,
        snippets.expand,
      );
      if (incomplete.length > 0) {
        notices.push(incompleteMessage(incomplete));
      }
      announce();
      // Preserve all host metadata.
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
    "tool.execute.after": async (call, output) => {
      if (call.tool !== "skill") {
        return;
      }
      output.output = await expandSkillBody(
        output.output,
        output.metadata,
        async (body, skip) =>
          (await startup).expand(
            body,
            "skill output (source file unavailable)",
            skip,
          ),
        (reason) => notify(input, reason),
      );
    },
  } satisfies Hooks);
};

export default {
  id: "prompt-composer",
  server: PromptComposer,
} satisfies PluginModule;
