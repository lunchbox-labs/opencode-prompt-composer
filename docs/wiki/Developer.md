# Developer documentation

For contributors and maintainers working on Prompt Composer:

- [Workspace layout](#workspace-layout), [local builds and checks](#build-a-local-package): the packages, local builds, runtime boundaries and compatibility checks.
- [Publishing](Publishing): trusted publisher setup and the release workflow.

The plugin's state machines are documented in [docs/state-machines.md](https://github.com/lunchbox-labs/opencode-prompt-composer/blob/main/docs/state-machines.md). These wiki pages are published from [docs/wiki](https://github.com/lunchbox-labs/opencode-prompt-composer/tree/main/docs/wiki) on every push to `main` that changes them; change them there.

The repository's [AGENTS.md](https://github.com/lunchbox-labs/opencode-prompt-composer/blob/main/AGENTS.md) and linked shared standards remain the authoritative machine instructions. Runnable examples and the license stay in the repository and the published adapter packages. [User documentation](Home#user-documentation) covers installation and everyday use.

Prompt Composer's include safety engine and dialog navigation originated in the MIT-licensed [Config Composer](https://github.com/lunchbox-labs/opencode-config-composer) project. Configuration composition belongs to Config Composer, and inline prompt inclusion to Prompt Composer.

## Workspace layout

The repository is an npm workspace with one lockfile. Its three packages are released together at one version:

| Directory | Package | Contents |
| --- | --- | --- |
| `packages/core` | `@lunchbox-labs/prompt-composer-core` | Discovery, include expansion, the server hooks, the prompt viewer, the host profiles in `src/host.ts`, and the unit tests |
| `packages/opencode` | `@lunchbox-labs/opencode-prompt-composer` | The OpenCode adapter and its examples |
| `packages/kilo` | `@lunchbox-labs/kilo-prompt-composer` | The Kilo CLI adapter and its examples |

A host profile holds what differs between hosts as data: the product name in messages, the global, project and home config directories, the environment variables, whether the home directory is trimmed, and the metadata of built-in skills. The core takes a profile in `createServer` and `createTui`, and each adapter passes its own and re-exports the result with the host's plugin types. The core has no runtime dependency on a host package, and each adapter depends on the core at exactly the same version.

The OpenCode adapter builds against `@opencode-ai/plugin` and `@opencode-ai/sdk` 1.19.5 with `@opentui/*` 0.4.5, and the Kilo adapter against `@kilocode/plugin` and `@kilocode/sdk` 7.8.27 with `@opentui/*` 0.5.11. The [baseline tests](https://github.com/lunchbox-labs/opencode-prompt-composer/tree/main/tests) check these pins in the manifests and lockfile. Linting, formatting, TypeScript settings and the integration tests are shared at the root, and `tests/hosts.ts` describes each host for them.

## Build a local package

Use the committed npm lockfile. CI uses Node 24; the packages require Node 22.18 or later.

```sh
npm ci
npm run build
npm pack --workspaces
```

`npm run build` builds the core first, then the adapters. Install the core tarball and the tarball for your host into a separate directory. Register that installed adapter's absolute directory in `opencode.jsonc` or `kilo.jsonc` and, when testing the viewer, `tui.jsonc`. The host selects the corresponding server or TUI export. This exercises a local candidate without publishing it.

## Runtime boundaries

The server composes native agent and command bodies through the config hook and skill bodies through the skill tool's after hook. It preserves host metadata and publishes no partially composed config. The TUI reads loaded config and agent metadata; it does not write files or execute prompts.

Startup snippet capture is shared by normalized project context for the lifetime of the imported module. Instance disposal can rerun plugin factories without resetting that capture; a fresh process loads changed snippets. The separately exported `includes` API reads files when called. Keep these distinct lifetime contracts when changing the implementation.

Composition degrades instead of failing: a failing include expands to nothing, a malformed marker stays literal, and a consumer over the 256 KiB limit or left empty keeps its native text, each with a warning toast and a server log entry. Past the include count limit, only the first limit problem is reported. Consumers compose independently, hooks do not reject, and discovery used by startup capture skips unusable entries. A failed capture is not cached, so the next plugin factory captures again. The exported `includes` API and discovery without a skip callback keep their strict behavior.

The skill parser isolates the body from native framing and leaves names, directories and sampled filenames literal. When include markers are present, truncated output, unknown or ambiguous framing, or missing or invalid native name and directory metadata leaves the native output unchanged so the skill still loads; a warning toast explains that its includes were not expanded. Kilo's built-in skills, whose metadata `dir` is `builtin`, use a shorter wrapper without the sampled-file footer, and only the Kilo profile accepts it. Exact wrapper strings in tests protect this host boundary.

## Checks

| Command | Coverage |
| --- | --- |
| `npm run check` | Typechecking, lint, formatting and the unit tests of every package |
| `npm run test:package` | For each host: built tarball installation of the core and adapter, public exports, runtime use and declarations |
| `npm run test:native` | Real host server, npm plugin loading, skill execution, process restart and terminal viewer, for the host in `NATIVE_HOST` |

`npm run test:native` runs OpenCode by default; set `NATIVE_HOST=kilo` for Kilo CLI. The native suite uses isolated configuration and a local model fixture; no provider account is needed. On Kilo it also disables telemetry and limits both the primary and the small model to the fixture provider. It downloads the host and verifies the ripgrep prerequisite. Some viewer checks replace rendering, while the PTY/ConPTY path exercises real terminal interaction and asserts that browsing sends no model request. Preserve both layers.

Tests should protect observable behavior, safety boundaries and host contracts. Use existing representative paths instead of duplicating wording or increasing test counts. The [shared standards](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/common.md#meaningful-tests) define the testing policy.

## Host compatibility

The authoritative ranges and floors live in [tests/opencode.json](https://github.com/lunchbox-labs/opencode-prompt-composer/blob/main/tests/opencode.json) and [tests/kilo.json](https://github.com/lunchbox-labs/opencode-prompt-composer/blob/main/tests/kilo.json); they are separate from pinned SDK/build dependencies and are not shipped in the packages. No host runtime engine restriction is declared.

| Host | CLI package | Version lane variable |
| --- | --- | --- |
| OpenCode | `opencode-ai` | `OPENCODE_TEST_VERSION` |
| Kilo CLI | `@kilocode/cli` | `KILO_TEST_VERSION` |

By default, native tests fetch fresh canonical metadata for the host's CLI package, choose the newest stable version in that range and install the exact platform binary. They verify the actual CLI version and fail on registry or artifact errors instead of using stale fallback versions. Set the lane variable to `floor` for the configured floor, or to an exact version inside the range.

[Check CI](https://github.com/lunchbox-labs/opencode-prompt-composer/blob/main/.github/workflows/check.yml) covers Linux and Windows, both hosts, and latest-compatible and floor versions. OpenCode also runs a Config Composer-first registration; Config Composer is an OpenCode plugin, so Kilo runs standalone only. For coexistence, build the Config Composer revision pinned in that workflow and set `CONFIG_COMPOSER_DIR` to its checkout before running `npm run test:native`. Its fixture follows that baseline's configuration format; substituting current Config Composer main requires a separate fixture compatibility review.
