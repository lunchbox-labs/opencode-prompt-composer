# Agent instructions

Read the applicable shared Lunchbox Labs standards before editing this repository:

- [Common agent guidance](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/common.md)
- [Workflow conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/workflows.md)
- [npm package conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/npm-packages.md)
- [Agent tooling conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/agent-tooling.md)
- [State machine conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/state-machines.md)

These documents must be read explicitly; GitHub does not automatically inherit them here.

## Layout

This repository is an npm workspace with one lockfile and two published packages released together at one version:

- `packages/core` (`@lunchbox-labs/prompt-composer-core`, private): discovery, include expansion, the server hooks, the prompt viewer and the host profiles in `src/host.ts`, with the unit tests. It is never published and has no runtime dependency on a host package.
- `packages/opencode` (`@lunchbox-labs/opencode-prompt-composer`) and `packages/kilo` (`@lunchbox-labs/kilo-prompt-composer`): thin adapters that pass their host profile to the core and ship their host's examples in `docs/examples/`. Their build bundles the core with tsdown (`tsdown.config.mjs` at the root), keeping every other import external, so they don't depend on it.

Put host differences in the host profile as data rather than in branches. Root `tests/` holds the package, native, example, release and baseline tests, and `tests/hosts.ts` describes each host for them. Shared tooling and its configuration live at the root.

## Commands

`npm run check` runs static checks and the unit tests of every package. Run `npm run test:package` separately for packed-package validation of both hosts, and `npm run test:native` for native integration; set `NATIVE_HOST=kilo` for Kilo CLI, and `OPENCODE_TEST_VERSION` or `KILO_TEST_VERSION` for a version lane.

## Documentation

The GitHub wiki is published from `docs/wiki/`: the Wiki workflow replaces the wiki with that folder on every push to `main` that changes it, so edit pages there, never in the wiki itself. Each file is one page named after its filename, with `_Sidebar.md` as the sidebar; link pages by name, as in `[Usage](Usage)`. Keep in-depth user and developer guides in the wiki, and the root and package READMEs to a short introduction that links to them.

Write documentation for knowledgeable OpenCode and Kilo CLI users: explain plugin-specific concepts without host or package-install basics or unnecessary cautions. Keep installation examples simple and unversioned. Use short, relevant README snippets and put full, simple, realistic examples in each adapter's `docs/examples/`. Keep maintainer publishing and release-process walkthroughs out of the README and user pages; the wiki's Developer pages hold them, and release notes are still appropriate.

The plugin's state machines are documented in [docs/state-machines.md](docs/state-machines.md). Update it in the same PR as any change to their states, triggers or exits, with tests for each transition and failure path the change adds or alters.

## Contributor workflows

For authoring, diagnostics, examples, viewer or restart behavior changes, request an independent `opencode-user-review`, and `kilo-user-review` when Kilo CLI users are affected. For discovery, include expansion, native prompt ownership, skill-body or host integration changes, request an independent `composition-contract-review`. Use both when both areas change; skip unrelated roles. Give reviewers the diff/base and relevant test or runtime evidence.

Use `.agents/skills/native-package-verification/SKILL.md` for applicable package/native checks. These contributor workflows do not require the plugin or alter the shipped examples. The [agent tooling conventions](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/agent-tooling.md) cover the file layout, invocation in each tool and reviewer permissions.
