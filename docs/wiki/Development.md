# Development and testing

## Build a local package

Use the committed npm lockfile. CI uses Node 24; the package requires Node 22.18 or later.

```sh
npm ci
npm run build
npm pack
```

Install the generated tarball into a separate directory. Register that installed package's absolute directory in `opencode.jsonc` and, when testing the viewer, `tui.jsonc`. OpenCode selects the corresponding server or TUI export. This exercises a local candidate without publishing it.

## Runtime boundaries

The server composes native agent and command bodies through the config hook and skill bodies through the skill tool's after hook. It preserves host metadata and publishes no partially composed config. The TUI reads loaded config and agent metadata; it does not write files or execute prompts.

Startup snippet capture is shared by normalized project context for the lifetime of the imported module. Instance disposal can rerun plugin factories without resetting that capture; a fresh process loads changed snippets. The separately exported `includes` API reads files when called. Keep these distinct lifetime contracts when changing the implementation.

Composition degrades instead of failing: a failing include expands to nothing, a malformed marker stays literal, and a consumer over the 256 KiB limit or left empty keeps its native text, each with a warning toast and a server log entry. Past the include count limit, only the first limit problem is reported. Consumers compose independently, hooks do not reject, and discovery used by startup capture skips unusable entries. A failed capture is not cached, so the next plugin factory captures again. The exported `includes` API and discovery without a skip callback keep their strict behavior.

The skill parser isolates the body from native framing and leaves names, directories and sampled filenames literal. When include markers are present, truncated output, unknown or ambiguous framing, or missing or invalid native name and directory metadata leaves the native output unchanged so the skill still loads; a warning toast explains that its includes were not expanded. Exact wrapper strings in tests protect this host boundary.

## Checks

| Command | Coverage |
| --- | --- |
| `npm run check` | Typechecking, lint, formatting and unit tests |
| `npm run test:package` | Built tarball installation, public exports, runtime use and declarations |
| `npm run test:native` | Real OpenCode server, npm plugin loading, skill execution, process restart and terminal viewer |

The native suite uses isolated configuration and a local model fixture; no provider account is needed. It downloads the host and verifies the ripgrep prerequisite. Some viewer checks replace rendering, while the PTY/ConPTY path exercises real terminal interaction and asserts that browsing sends no model request. Preserve both layers.

Tests should protect observable behavior, safety boundaries and host contracts. Use existing representative paths instead of duplicating wording or increasing test counts. The [shared standards](https://github.com/lunchbox-labs/.github/blob/main/agent-guidance/common.md#meaningful-tests) define the testing policy.

## Host compatibility

The authoritative range and floor live in [tests/opencode.json](https://github.com/lunchbox-labs/opencode-prompt-composer/blob/main/tests/opencode.json); they are separate from pinned SDK/build dependencies and are not shipped in the package. No OpenCode runtime engine restriction is declared.

By default, native tests fetch fresh canonical `opencode-ai` metadata, choose the newest stable version in that range and install the exact platform binary. They verify the actual CLI version and fail on registry or artifact errors instead of using stale fallback versions. Set `OPENCODE_TEST_VERSION=floor` for the configured floor, or an exact version inside the range.

[Check CI](https://github.com/lunchbox-labs/opencode-prompt-composer/blob/main/.github/workflows/check.yml) covers Linux and Windows, latest-compatible and floor hosts, and standalone and Config Composer-first registrations. For coexistence, build the Config Composer revision pinned in that workflow and set `CONFIG_COMPOSER_DIR` to its checkout before running `npm run test:native`. Its fixture follows that baseline's configuration format; substituting current Config Composer main requires a separate fixture compatibility review.
