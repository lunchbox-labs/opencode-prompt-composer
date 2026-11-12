import type {
  Config,
  Hooks,
  Plugin,
  PluginInput,
  PluginModule,
} from "@opencode-ai/plugin";
import { diagnosticName } from "./errors.ts";
import type { Host } from "./host.ts";
import { hasIncludeMarker } from "./include-core.ts";
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

function incompleteNotice(
  incomplete: IncompleteConsumer[],
  product: string,
): Notice {
  const problems = incomplete.flatMap(({ consumer, problems }) =>
    problems.map((problem) => `${consumer}: ${problem}`),
  );
  const toast =
    incomplete.length === 1
      ? `Some includes were not expanded in ${incomplete[0].consumer}. ${firstProblem(incomplete[0].problems, product)}`
      : `Some includes were not expanded in ${incomplete.length} prompts. ${firstProblem(problems, product)}`;
  return {
    toast,
    details: ["Some includes were not expanded.", ...problems].join("\n- "),
  };
}

function warningsNotice(warnings: readonly string[], product: string): Notice {
  return {
    toast: firstProblem(warnings, product),
    details: warnings.join("\n"),
  };
}

type CommandPart = Parameters<
  NonNullable<Hooks["command.execute.before"]>
>[1]["parts"][number];

function partText(part: CommandPart): string | undefined {
  if (part.type === "text") {
    return part.text;
  }
  return part.type === "subtask" ? part.prompt : undefined;
}

// The host composes generated skill commands from cached skill content after
// substituting arguments and shell output, so their includes cannot be
// expanded (#102). The command list's `source` field, absent from the V1
// client types, tells them apart from configured commands, which were
// composed at config time.
async function isSkillCommand(
  input: PluginInput,
  command: string,
): Promise<boolean> {
  const listed = await input.client.command.list({
    query: { directory: input.directory },
  });
  const commands: unknown = listed.data;
  return (
    Array.isArray(commands) &&
    commands.some(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        entry.name === command &&
        "source" in entry &&
        entry.source === "skill",
    )
  );
}

const promptComposer =
  (host: Host): Plugin =>
  (input, options = {}) => {
    const ignoredOptions = Object.keys(options).map(diagnosticName);
    let firstConfig = true;
    const context = {
      directory: input.directory,
      worktree: input.worktree,
      host,
    };
    const startup = startupSnippets(context);
    const snapshots = new WeakMap<
      object,
      { native: Bodies; applied: Bodies }
    >();
    const warnedSkillCommands = new Set<string>();
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
          notices.push(incompleteNotice(incomplete, host.name));
        }
        if (first && snippets.warnings.length > 0) {
          notices.push(warningsNotice(snippets.warnings, host.name));
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
      "command.execute.before": async (call, output) => {
        try {
          if (
            warnedSkillCommands.has(call.command) ||
            !output.parts.some((part) => {
              const text = partText(part);
              return text !== undefined && hasIncludeMarker(text);
            }) ||
            !(await isSkillCommand(input, call.command))
          ) {
            return;
          }
          warnedSkillCommands.add(call.command);
          notify(
            input,
            `Skill ${diagnosticName(call.command)} ran as a slash command, which does not expand includes; its markers were sent as written. Ask the agent to load the skill instead.`,
          );
        } catch {
          // A throwing hook fails the command; the warning is best-effort.
        }
      },
      "tool.execute.after": async (call, output) => {
        if (call.tool !== "skill") {
          return;
        }
        output.output = await expandSkillBody(
          host,
          output.output,
          output.metadata,
          async (body, consumer, skip) =>
            (await startup).expand(body, consumer, skip),
          (reason, details) => notify(input, reason, "warning", details),
        );
      },
    } satisfies Hooks);
  };

/** The server plugin for one host. */
export function createServer(host: Host) {
  return {
    id: "prompt-composer",
    server: promptComposer(host),
  } satisfies PluginModule;
}
