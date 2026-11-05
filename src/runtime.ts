import type { Config } from "@opencode-ai/plugin";
import { diagnosticName } from "./errors.ts";
import type { SkippedInclude } from "./include-core.ts";
import { errorMessage } from "./notices.ts";

export type ConsumerExpand = (
  text: string,
  consumer: string,
  skip: SkippedInclude,
) => Promise<string>;

/** Problems in one consumer, in the order they were found. */
export interface IncompleteConsumer {
  consumer: string;
  problems: string[];
}

/**
 * Composes each agent prompt and command template independently. A failing
 * include expands to nothing within its consumer; a consumer that cannot be
 * composed at all, or would be left empty, keeps its native text. Neither
 * affects other consumers.
 */
export async function compose(
  config: Config,
  expand: ConsumerExpand,
): Promise<{ config: Config; incomplete: IncompleteConsumer[] }> {
  const result = structuredClone(config);
  const incomplete: IncompleteConsumer[] = [];
  const composeOne = async (text: string, consumer: string) => {
    const problems: string[] = [];
    const report = () => {
      if (problems.length > 0) {
        incomplete.push({ consumer, problems });
      }
    };
    try {
      const composed = await expand(text, consumer, (problem) =>
        problems.push(problem),
      );
      // An agent or command left with no text would silently lose its role.
      if (problems.length > 0 && composed.trim() === "") {
        // Lead with the fallback so the toast says the marker text remains.
        problems[0] = `Its native text was kept because nothing else was left. ${problems[0]}`;
        report();
        return text;
      }
      report();
      return composed;
    } catch (error) {
      problems.push(
        `${errorMessage(error)} Its native text was kept unexpanded.`,
      );
      report();
      return text;
    }
  };
  for (const [name, agent] of Object.entries(result.agent ?? {})) {
    if (
      agent === undefined ||
      agent.disable === true ||
      typeof agent.prompt !== "string" ||
      agent.prompt.trim() === ""
    ) {
      continue;
    }
    agent.prompt = await composeOne(
      agent.prompt,
      `agent ${diagnosticName(name)}`,
    );
  }
  for (const [name, command] of Object.entries(result.command ?? {})) {
    if (typeof command.template !== "string") {
      continue;
    }
    command.template = await composeOne(
      command.template,
      `command ${diagnosticName(name)}`,
    );
  }
  return { config: result, incomplete };
}
