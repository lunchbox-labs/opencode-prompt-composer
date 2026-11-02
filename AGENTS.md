# Agent instructions

Read the applicable shared Lunchbox Labs standards before editing this repository:

- [Common agent guidance](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/common.md)
- [Workflow conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/workflows.md)
- [npm package conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/npm-packages.md)

These documents must be read explicitly; GitHub does not automatically inherit them here.

`npm run check` includes static checks and unit tests. Run `npm run test:package` separately for packed-package validation and `npm run test:native` for native integration.

Write documentation for knowledgeable OpenCode users: explain plugin-specific concepts without host or package-install basics or unnecessary cautions. Keep installation examples simple and unversioned. Use short, relevant README snippets and put full, simple, realistic examples in `docs/examples/`. Omit maintainer publishing and release-process walkthroughs; release notes are still appropriate.

## Local workflows

For authoring, diagnostics, examples, viewer or restart behavior changes, request an independent `opencode-user-review`. For discovery, include expansion, native prompt ownership or skill-body changes, request an independent `composition-contract-review`. Use both when both areas change; skip unrelated roles. Give reviewers the diff/base and relevant test or runtime evidence, then address supported findings before handoff.

Each reviewer reads its canonical procedure in `.agents/skills/<name>/SKILL.md`; the same-named files under `.codex/agents`, `.claude/agents` and `.opencode/agents` only register the role. Codex inherits parent permissions; non-editing behavior is an instruction, not a separate read-only sandbox. Claude and OpenCode adapters restrict editing tools. If a runtime cannot delegate, report that limitation rather than calling self-review independent.

Use `.agents/skills/native-package-verification/SKILL.md` for applicable package/native checks. Codex and OpenCode discover the shared skills directly; Claude's `.claude/skills` entries forward to them. These contributor workflows do not require the plugin or alter the shipped examples.
