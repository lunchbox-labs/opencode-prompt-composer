import type { PluginModule } from "@kilocode/plugin";
import { kilo } from "@lunchbox-labs/prompt-composer-core/host";
import { createServer } from "@lunchbox-labs/prompt-composer-core/server";

// Core is typed against OpenCode's plugin API. Kilo's API has the same shape,
// but its SDK client is a separate class with private members, so TypeScript
// can't relate the two. The types only differ in name at runtime.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The two APIs differ only in their type declarations.
const plugin = createServer(kilo) as unknown as PluginModule & { id: string };

export default plugin;
