import type { TuiPluginModule } from "@kilocode/plugin/tui";
import { kilo } from "@lunchbox-labs/prompt-composer-core/host";
import { createTui } from "@lunchbox-labs/prompt-composer-core/tui";

// Core is typed against OpenCode's TUI API. Kilo's API has the same shape,
// but its SDK client is a separate class with private members, and its
// command templates may be missing. The viewer checks each template's type
// before showing it, and the client types only differ in name at runtime.
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The two APIs differ only in their type declarations.
const plugin = createTui(kilo) as unknown as TuiPluginModule & {
  id: string;
};

export default plugin;
