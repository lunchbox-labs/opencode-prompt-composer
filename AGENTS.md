# Agent instructions

Read the applicable shared Lunchbox Labs standards before editing this repository:

- [Common agent guidance](https://github.com/lunchbox-labs/.github/blob/main/standards/agent-guidance.md)
- [Workflow conventions](https://github.com/lunchbox-labs/.github/blob/main/standards/workflows.md)
- [npm package conventions](https://github.com/lunchbox-labs/.github/blob/main/standards/npm-packages.md)

These documents must be read explicitly; GitHub does not automatically inherit them here.

`npm run check` includes static checks and unit tests. Run `npm run test:package` separately for packed-package validation and `npm run test:native` for native integration.

Write documentation for knowledgeable OpenCode users: explain plugin-specific concepts without host or package-install basics or unnecessary cautions. Keep installation examples simple and unversioned. Use short, relevant README snippets and put full, simple, realistic examples in `docs/examples/`. Omit maintainer publishing and release-process walkthroughs; release notes are still appropriate.
