# On-demand verification

This project contains a native `verification` skill and a reusable checklist in `.opencode/prompts/verification.md`.

Register the plugin, open this folder as the project and ask the agent to load `verification` through the native skill tool. Prompt Composer expands the include in the returned skill body while preserving the host wrapper. The automatically generated skill slash command does not expand includes.

The checklist is captured when the project first initializes in the server process, even if the skill is loaded later. Restart the server after editing it. OpenCode owns skill discovery and permissions. This is a project example; the package does not install global help skills.
