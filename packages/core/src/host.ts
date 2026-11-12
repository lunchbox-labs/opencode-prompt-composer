/**
 * What differs between the hosts that load Prompt Composer. Every host loads
 * the same plugin and TUI API shape; these values mirror where each one
 * reads its configuration and how it names itself.
 */
export interface Host {
  /** Product name used in messages, such as "Restart OpenCode". */
  readonly name: string;
  /** Directory under XDG_CONFIG_HOME (or ~/.config) holding global config. */
  readonly globalDirectory: string;
  /** Config directories the host reads in each project ancestor, in load order. */
  readonly projectDirectories: readonly string[];
  /** Config directories the host reads under the home directory, in load order. */
  readonly homeDirectories: readonly string[];
  /** Environment variables the host reads for its config locations. */
  readonly env: {
    /** Set to "true" or "1" to skip project config directories. */
    readonly disableProjectConfig: string;
    /** An extra config directory, read last. */
    readonly configDirectory: string;
    /** Replaces the home directory, as the host's own tests do. */
    readonly testHome: string;
  };
  /** Whether the host trims surrounding whitespace from its home directory. */
  readonly trimsHome: boolean;
  /**
   * The skill metadata `dir` of the host's built-in skills, which it frames
   * without a base directory or file list, if it has any.
   */
  readonly builtinSkillDirectory?: string;
}

/** Mirrors OpenCode 1.19.0 through 1.19.5. */
export const opencode: Host = Object.freeze({
  name: "OpenCode",
  globalDirectory: "opencode",
  projectDirectories: Object.freeze([".opencode"]),
  homeDirectories: Object.freeze([".opencode"]),
  env: Object.freeze({
    disableProjectConfig: "OPENCODE_DISABLE_PROJECT_CONFIG",
    configDirectory: "OPENCODE_CONFIG_DIR",
    testHome: "OPENCODE_TEST_HOME",
  }),
  trimsHome: false,
});

/** Mirrors Kilo CLI 7.8.27. */
export const kilo: Host = Object.freeze({
  name: "Kilo",
  globalDirectory: "kilo",
  projectDirectories: Object.freeze([".kilocode", ".kilo"]),
  homeDirectories: Object.freeze([".kilocode", ".kilo"]),
  env: Object.freeze({
    disableProjectConfig: "KILO_DISABLE_PROJECT_CONFIG",
    configDirectory: "KILO_CONFIG_DIR",
    testHome: "KILO_TEST_HOME",
  }),
  trimsHome: true,
  builtinSkillDirectory: "builtin",
});
