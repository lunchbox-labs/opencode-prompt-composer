# Discovery

Prompt Composer discovers `prompts/` under the host's configuration directories. It follows this order:

1. The global XDG config directory: `~/.config/opencode` for OpenCode, or `~/.config/kilo` for Kilo, unless `XDG_CONFIG_HOME` is absolute.
2. Existing project config directories, starting at the opened directory and ascending through the worktree. Non-Git projects ascend to the filesystem root. OpenCode reads `.opencode`; Kilo reads `.kilocode` and then `.kilo` at each level.
3. The same config directories under the home directory, when present.
4. The custom config directory variable, when set.

| | OpenCode | Kilo CLI |
| --- | --- | --- |
| Global directory | `opencode` | `kilo` |
| Project and home directories | `.opencode` | `.kilocode`, then `.kilo` |
| Custom config directory | `OPENCODE_CONFIG_DIR` | `KILO_CONFIG_DIR` |
| Disable project discovery | `OPENCODE_DISABLE_PROJECT_CONFIG` | `KILO_DISABLE_PROJECT_CONFIG` |
| Home override used by host tests | `OPENCODE_TEST_HOME` | `KILO_TEST_HOME` |

Duplicate directory paths retain their first occurrence. Later files win collisions by relative filename, including nested names such as `review/findings.md`. A worktree-root config directory can override a descendant's; at each Kilo level `.kilo` overrides `.kilocode`. Home and custom config directories follow project directories. Setting the disable variable to `true` or `1` disables project discovery while retaining the other roots. Each package reads only its own host's directories and variables, so the Kilo package ignores `.opencode` and `OPENCODE_*`, and the OpenCode package ignores the Kilo ones.

This mirrors the host's agent/command directory order. It does not scan `.agents`, `.claude`, remote skill URLs or arbitrary skill paths for snippets. The host discovers native component definitions; Prompt Composer discovers only prompt snippets. The plugin ignores obsolete `prompt-composer.jsonc` files.

## References

Use forward-slash relative filenames with extensions. Nested includes resolve against the same discovered registry, not relative to the including file. `.md` and `.txt` are distinct names. Snippets are plain text; frontmatter is not interpreted as a name override.

Paths cannot be absolute or contain traversal, hidden segments, backslashes or control characters. Included files must be regular UTF-8 text without NUL. Symlinks contained within the prompt root are allowed. Symlinks that escape the prompt root or point to hidden paths, unreadable entries and directories past the nesting limit are ignored with a warning; directory cycles and a `prompts` path that is not a directory are ignored quietly. Ignored entries are never read.

## Limits

- Included file: 64 KiB.
- Body containing include syntax: 256 KiB before and after expansion. Marker-free native text bypasses this budget.
- Include expansion: 32 levels and 256 occurrences.
- Discovery: 4096 entries, 32 directory levels and 256 ancestor-directory iterations. Kilo checks both of its project directories in each iteration.

An include that breaks a limit is left out with a warning, and a prompt over 256 KiB keeps its native text. Past 4096 entries, discovery keeps what it found and ignores the rest with a warning. These limits apply to prompt snippets and composition, not to a settings file. See [Usage](Usage#snippet-lifetime) for when changes become visible.
