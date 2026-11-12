import { type Host, kilo, opencode } from "../packages/core/src/host.ts";

/** What the package and native tests need to know about each host. */
export interface TestHost {
  id: "opencode" | "kilo";
  profile: Host;
  /** The adapter package's workspace directory. */
  workspace: string;
  packageName: string;
  /** The project config directory the fixtures write to. */
  projectDirectory: string;
  /** The host's plugin API package, which consumers type-check against. */
  pluginPackage: string;
  /** The host's npm CLI package, whose versions the native lanes resolve. */
  cliPackage: string;
  /** The platform package that holds the host binary. */
  platformPackage: (platform: NodeJS.Platform) => string;
  binary: string;
  /** Prefix of the host's own environment variables. */
  envPrefix: string;
  configFile: string;
  directoryHeader: string;
  /** Test-only host policy: the tested version range and its floor. */
  support: URL;
  /** Environment variable that picks the version lane. */
  versionVariable: string;
  /** Extra environment for the native host process. */
  extraEnv: Record<string, string>;
  /** Extra settings the native fixture config needs on this host. */
  extraConfig: Record<string, unknown>;
}

export const corePackage = {
  workspace: "packages/core",
  packageName: "@lunchbox-labs/prompt-composer-core",
};

export const hosts: Record<TestHost["id"], TestHost> = {
  opencode: {
    id: "opencode",
    profile: opencode,
    workspace: "packages/opencode",
    packageName: "@lunchbox-labs/opencode-prompt-composer",
    projectDirectory: ".opencode",
    pluginPackage: "@opencode-ai/plugin",
    cliPackage: "opencode-ai",
    platformPackage: (platform) =>
      platform === "win32" ? "opencode-windows-x64" : "opencode-linux-x64",
    binary: "opencode",
    envPrefix: "OPENCODE",
    configFile: "opencode.jsonc",
    directoryHeader: "x-opencode-directory",
    support: new URL("./opencode.json", import.meta.url),
    versionVariable: "OPENCODE_TEST_VERSION",
    extraEnv: {},
    extraConfig: {},
  },
  kilo: {
    id: "kilo",
    profile: kilo,
    workspace: "packages/kilo",
    packageName: "@lunchbox-labs/kilo-prompt-composer",
    projectDirectory: ".kilo",
    pluginPackage: "@kilocode/plugin",
    cliPackage: "@kilocode/cli",
    platformPackage: (platform) =>
      platform === "win32"
        ? "@kilocode/cli-windows-x64"
        : "@kilocode/cli-linux-x64",
    binary: "kilo",
    envPrefix: "KILO",
    configFile: "kilo.jsonc",
    directoryHeader: "x-kilo-directory",
    support: new URL("./kilo.json", import.meta.url),
    versionVariable: "KILO_TEST_VERSION",
    extraEnv: { KILO_TELEMETRY_LEVEL: "off" },
    // Kilo also picks a small model and enables its own providers by default;
    // the fixture keeps both on the local model server.
    extraConfig: {
      small_model: "fixture/model",
      enabled_providers: ["fixture"],
    },
  },
};

/** The host the native test runs against, from NATIVE_HOST (default opencode). */
export function nativeHost(env: NodeJS.ProcessEnv = process.env): TestHost {
  const id = env.NATIVE_HOST ?? "opencode";
  if (id !== "opencode" && id !== "kilo") {
    throw new Error(`NATIVE_HOST must be opencode or kilo, not ${id}`);
  }
  return hosts[id];
}
