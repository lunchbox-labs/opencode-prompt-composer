import type { Config, Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { diagnosticName } from "./errors.ts";
import {
  type NoticeVariant,
  errorMessage,
  firstProblem,
  notify,
} from "./notices.ts";
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
interface Notice {
  toast: string;
  details: string;
}

function incompleteNotice(incomplete: IncompleteConsumer[]): Notice {
  const problems = incomplete.flatMap(({ consumer, problems }) =>
    problems.map((problem) => `${consumer}: ${problem}`),
  );
  const toast =
    incomplete.length === 1
      ? `Some includes were not expanded in ${incomplete[0].consumer}. ${firstProblem(incomplete[0].problems)}`
      : `Some includes were not expanded in ${incomplete.length} prompts. ${firstProblem(problems)}`;
  return {
    toast,
    details: ["Some includes were not expanded.", ...problems].join("\n- "),
  };
}

function warningsNotice(warnings: readonly string[]): Notice {
  return {
    toast: firstProblem(warnings),
    details: warnings.join("\n"),
  };
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
      const notices: Notice[] = [];
      const announce = (variant: NoticeVariant = "warning") => {
        if (notices.length > 0) {
          notify(
            input,
            notices.map((notice) => notice.toast).join(" "),
            variant,
            notices.map((notice) => notice.details).join("\n"),
          );
        }
      };
      const first = firstConfig;
      firstConfig = false;
      const optionsNotice =
        first && ignoredOptions.length > 0
          ? `Plugin options are not supported and were ignored: ${ignoredOptions.join(", ")}.`
          : undefined;
      let snippets: Awaited<typeof startup>;
      try {
        snippets = await startup;
      } catch (error) {
        const failure = `Prompt files could not be read, so no includes were expanded; agents, commands and skills keep their native text. ${errorMessage(error)}`;
        notices.push({ toast: failure, details: failure });
        if (optionsNotice !== undefined) {
          notices.push({ toast: optionsNotice, details: optionsNotice });
        }
        announce("error");
        return;
      }
      const { config: composed, incomplete } = await compose(
        native,
        snippets.expand,
      );
      // Most actionable first: a toast is cut off after 600 characters.
      if (incomplete.length > 0) {
        notices.push(incompleteNotice(incomplete));
      }
      if (first && snippets.warnings.length > 0) {
        notices.push(warningsNotice(snippets.warnings));
      }
      if (optionsNotice !== undefined) {
        notices.push({ toast: optionsNotice, details: optionsNotice });
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
        async (body, consumer, skip) =>
          (await startup).expand(body, consumer, skip),
        (reason, details) => notify(input, reason, "warning", details),
      );
    },
  } satisfies Hooks);
};

export default {
  id: "prompt-composer",
  server: PromptComposer,
} satisfies PluginModule;
