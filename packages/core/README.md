# Prompt Composer core

The source that the [OpenCode](../opencode/) and [Kilo CLI](../kilo/) packages share: prompt discovery, include expansion, the server hooks, the prompt viewer, and a host profile for each host in `src/host.ts`.

This package is private and is never published. Each host package's build bundles it with [tsdown](https://tsdown.dev/), so the published packages don't depend on it. Its `exports` point at the TypeScript sources, for the host packages' build and typecheck within the workspace; its version is not released.

[Developer](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Developer) describes the workspace.
