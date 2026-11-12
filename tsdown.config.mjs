import { readFileSync } from "node:fs";
import { defineConfig } from "tsdown";

// Builds a host package. Each host package's build script runs this config
// from that package's directory (npm runs workspace scripts there), so entries
// and output are relative to the package, not to this file.
//
// The private core is bundled into the package, and every other import stays
// a bare import that the host provides. The three entries build together, so
// each core module is emitted once per package: a module more than one entry
// uses, such as the include engine and its error classes, goes to a shared
// chunk instead of being copied into each entry.

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

const entries = ["server", "includes", "tui"];

// A declaration that fails to emit is only a warning in the declaration
// plugin and leaves an empty `export {}`, so the build checks each entry's.
function requireDeclarations({ chunks }) {
  for (const entry of entries) {
    const declaration = chunks.find(
      (chunk) => chunk.fileName === `${entry}.d.ts`,
    );
    const code = declaration?.type === "chunk" ? declaration.code : "";
    if (!/^export\s+(?!\{\s*\};?\s*$)/m.test(code)) {
      throw new Error(`dist/${entry}.d.ts declares no exports.`);
    }
  }
}

export default defineConfig({
  cwd: process.cwd(),
  entry: Object.fromEntries(entries.map((entry) => [entry, `src/${entry}.ts`])),
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22.18",
  fixedExtension: false,
  // Load every file the package's tsconfig lists into the declaration
  // program up front. Without it, the declarations re-exported from core's
  // sources, which sit outside that tsconfig, come out empty.
  dts: { tsc: { eager: true } },
  hooks: { "build:done": requireDeclarations },
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
