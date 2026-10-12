# On-demand verification

The native `verification` skill includes a reusable checklist from `.opencode/prompts/verification.md`. There is no Prompt Composer settings file and no skill mapping. OpenCode discovers the skill; the plugin expands the checklist only when the skill tool returns its body.

Use this directory as an OpenCode project with the plugin registered, then ask your agent to load `verification`. Editing the checklist updates the next skill load. Skill discovery and permissions remain OpenCode's responsibility.
