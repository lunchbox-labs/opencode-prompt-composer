# Discovery

The tested OpenCode range is listed in the [root README](../README.md). The discovery baseline is source commit `733b2c627e5aec39cb33cc22373bdce33053ef2c`.

The loader mirrors [`ConfigPaths.directories`](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/config/paths.ts). It visits:

1. The global XDG OpenCode config directory (`~/.config/opencode` without an absolute `XDG_CONFIG_HOME`).
2. Existing `.opencode` directories, nearest opened directory first, ascending through the worktree. Non-Git projects ascend to the filesystem root.
3. Home `.opencode`, if present.
4. `OPENCODE_CONFIG_DIR`, when set.

Duplicate directory paths retain their first occurrence. Each directory contributes `prompts/` and optional `prompt-composer.jsonc`. Later roots win filename collisions, including nested names such as `review/findings.md`. In particular, the pinned host's directory ordering is **not** a nearest-project-always-wins rule. A worktree-root `.opencode` overrides a descendant `.opencode`; home `.opencode` and the custom host config directory follow project directories.

This matches [agent](https://github.com/anomalyco/opencode/blob/733b2c627e5aec39cb33cc22373bdce33053ef2c/packages/opencode/src/config/agent.ts) and command directory precedence, not every skill-specific discovery source. There is no scanning of `.agents`, `.claude`, remote skill URLs, or arbitrary configured skill paths for prompt files. OpenCode has no generic prompt registry; this package owns discovery. Native component definitions remain OpenCode's responsibility.

References are forward-slash relative filenames, including the extension. Nested references are registry-relative, not relative to the including file. `.md` and `.txt` remain distinct names. No frontmatter name overrides are interpreted in snippets; their content is plain text.

Safety retains the extraction's restrictions: no absolute paths, traversal, hidden path segments, backslashes, control characters, unsafe extensions, canonical escapes, invalid UTF-8 or NUL. Symlinks within a discovered prompt root are allowed; escaping symlinks and directory cycles fail. Limits are 64 KiB per included file, 256 KiB per expanded body, 32 include levels and 256 include occurrences. Discovery is bounded to 4096 entries and 32 directory levels; settings total at most 8 MiB and 1 MiB per file.

Under `/compose-prompts`, choose **Browse prompt files** to inspect exact relative filenames. Selecting a file shows its literal include marker, winning path, and shadowed paths in discovery order. This view is read-only and checks the current files again on selection. If loaded prompt inputs changed, apply saved prompt settings before reopening; return to Compose prompts and reopen the list to refresh its filenames.
