# Prompt Composer core

The shared core of [OpenCode Prompt Composer](https://www.npmjs.com/package/@lunchbox-labs/opencode-prompt-composer) and [Kilo Prompt Composer](https://www.npmjs.com/package/@lunchbox-labs/kilo-prompt-composer). It holds prompt discovery, include expansion, the server hooks and the prompt viewer, and a host profile for each supported host.

Install the package for your host instead; it depends on this one at the same version:

```sh
npm install @lunchbox-labs/opencode-prompt-composer
npm install @lunchbox-labs/kilo-prompt-composer
```

The `./includes` and `./host` declarations have no host types. The `./server` and `./tui` declarations refer to `@opencode-ai/plugin` types and are internal to the adapters, which re-export the result with their host's own plugin types, so the package does not depend on a host package.

Requires Node **22.18+**. The [wiki](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki) documents both hosts, and [Developer](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Developer) describes the workspace.
