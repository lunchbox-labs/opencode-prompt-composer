# Review guidance

The reviewer and `/check` command share `prompts/review/findings.md`. Agent rules prepend review context and append a reminder without copying the agent's body into settings.

Use this directory as an OpenCode project after registering the plugin in your shared configuration. Its `.opencode` directory contains the complete example. Run `/check` or select `review`. Both use the same findings format; the agent also receives the configured additions.

To specialize a shared format for this project, put a file with the same relative name in this project's prompt directory. See the pinned [discovery order](../../discovery.md) for additional home/custom-directory overrides.
