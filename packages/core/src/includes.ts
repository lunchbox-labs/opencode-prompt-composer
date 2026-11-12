import type { DiscoveredPrompt } from "./discovery.ts";
import {
  type PromptRead,
  expandWithReader,
  readSnippet,
} from "./include-core.ts";

export {
  MAX_SNIPPET_BYTES,
  MAX_PROMPT_BYTES,
  MAX_INCLUDE_DEPTH,
  MAX_INCLUDES,
  type PromptDependency,
  type PromptRead,
} from "./include-core.ts";

export async function expandIncludes(
  text: string,
  sources: ReadonlyMap<string, DiscoveredPrompt>,
  onRead?: PromptRead,
  consumer?: string,
): Promise<string> {
  return expandWithReader(
    text,
    (reference) => {
      const source = sources.get(reference);
      return source === undefined
        ? Promise.resolve(undefined)
        : readSnippet(reference, source, onRead);
    },
    consumer,
  );
}
