# Agent instructions

Read the applicable shared Lunchbox Labs standards before editing this repository:

- [Common agent guidance](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/common.md)
- [Workflow conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/workflows.md)
- [npm package conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/npm-packages.md)
- [Agent tooling conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/agent-tooling.md)

These documents must be read explicitly; GitHub does not automatically inherit them here.

`npm run check` includes static checks and unit tests. Run `npm run test:package` separately for packed-package validation and `npm run test:native` for native integration.

Write documentation for knowledgeable OpenCode users: explain plugin-specific concepts without host or package-install basics or unnecessary cautions. Keep installation examples simple and unversioned. Use short, relevant README snippets and put full, simple, realistic examples in `docs/examples/`. Omit maintainer publishing and release-process walkthroughs; release notes are still appropriate.

## Contributor workflows

For authoring, diagnostics, examples, viewer or restart behavior changes, request an independent `opencode-user-review`. For discovery, include expansion, native prompt ownership, skill-body or host integration changes, request an independent `composition-contract-review`. Use both when both areas change; skip unrelated roles. Give reviewers the diff/base and relevant test or runtime evidence.

Use `.agents/skills/native-package-verification/SKILL.md` for applicable package/native checks. These contributor workflows do not require the plugin or alter the shipped examples. The [agent tooling conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/agent-tooling.md) cover the file layout, invocation in each tool and reviewer permissions.
