# Review guidance

The reviewer and `/check` command share `prompts/review/findings.md`. Agent rules prepend review context and append a reminder without copying the agent's body into settings.

Use this directory as an OpenCode project after registering the plugin in your shared configuration. Its `.opencode` directory contains the complete example. Run `/check` or select `review`. Both use the same findings format; the agent also receives the configured additions.

To override a format from the global OpenCode config directory, put a file with the same relative name in this project's prompt directory. Ancestor project directories, home `.opencode`, and the custom config directory can override this file. See the [discovery order](../../discovery.md).
