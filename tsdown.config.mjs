import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// Builds a host package. Each host package's build script runs this config
// from that package's directory (npm runs workspace scripts there), so entries
// and output are relative to the package, not to this file.
//
// The private core is bundled into the package, and every other import stays
// a bare import that the host provides. The three entries build together, so a
// module more than one of them uses, such as the startup snippet cache, is
// emitted once in a shared chunk instead of being copied into each entry.

/** The plugin package whose types the package's declarations refer to. */
function hostPlugin() {
  const { name } = JSON.parse(readFileSync("package.json", "utf8"));
  const plugins = {
    "@lunchbox-labs/opencode-prompt-composer": "@opencode-ai/plugin",
    "@lunchbox-labs/kilo-prompt-composer": "@kilocode/plugin",
  };
  if (!Object.hasOwn(plugins, name)) {
    throw new Error(`Run this config from a host package, not ${name}.`);
  }
  return plugins[name];
}

export default defineConfig({
  cwd: process.cwd(),
  entry: {
    server: "src/server.ts",
    includes: "src/includes.ts",
    tui: "src/tui.ts",
  },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22.18",
  fixedExtension: false,
  // Core's sources sit outside the package's tsconfig, so the declaration
  // program is built from every file the entries import.
  dts: { tsc: { eager: true } },
  minify: false,
  failOnWarn: true,
  deps: {
    // Keep every package import external, then bring core back in.
    neverBundle: true,
    alwaysBundle: [/^@lunchbox-labs\/prompt-composer-core(?:\/|$)/],
    // Fail the build if anything from node_modules would be bundled.
    onlyBundle: [],
    // Node built-ins aside, the built code may import only the host's
    // renderer, which the TUI loads on demand from the host, and the
    // declarations only the host's plugin types.
    onlyImport: ["@opentui/core", hostPlugin()],
  },
});
