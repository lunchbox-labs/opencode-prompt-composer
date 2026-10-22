import type { Config } from "@opencode-ai/plugin";
import type { PromptInventory } from "./discovery.ts";
import { expandIncludes } from "./includes.ts";
import type { SourceFile } from "./read-consistency.ts";
import { SettingsError, diagnosticName } from "./errors.ts";

export interface Composition {
  config: Config;
  reads: SourceFile[];
}

export async function compose(
  config: Config,
  inventory: PromptInventory,
): Promise<Composition> {
  const result = structuredClone(config);
  const reads: SourceFile[] = [];
  const expand = (text: string, consumer: string) =>
    expandIncludes(text, inventory.files, (file) => reads.push(file), consumer);
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
  return { config: result, reads };
}
