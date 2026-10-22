import type { Config } from "@opencode-ai/plugin";
import { SettingsError, diagnosticName } from "./errors.ts";

export async function compose(
  config: Config,
  expand: (text: string, consumer: string) => Promise<string>,
): Promise<Config> {
  const result = structuredClone(config);
  for (const [name, agent] of Object.entries(result.agent ?? {})) {
    if (
      agent === undefined ||
      agent.disable === true ||
      typeof agent.prompt !== "string" ||
      agent.prompt.trim() === ""
    ) {
      continue;
    }
    agent.prompt = await expand(agent.prompt, `agent ${diagnosticName(name)}`);
  }
  for (const [name, command] of Object.entries(result.command ?? {})) {
    if (typeof command.template !== "string") {
      throw new SettingsError("Native commands must contain valid templates.");
    }
    command.template = await expand(
      command.template,
      `command ${diagnosticName(name)}`,
    );
  }
  return result;
}
