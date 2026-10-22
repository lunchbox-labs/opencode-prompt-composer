import type { DiscoveredPrompt } from "./discovery.ts";
import {
  type PromptRead,
  expandWithReader,
  missingSnippet,
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
      if (source === undefined) {
        throw missingSnippet(reference);
      }
      return readSnippet(reference, source, onRead);
    },
    consumer,
  );
}
