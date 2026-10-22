# OpenCode Prompt Composer

Share prompt text across native OpenCode agents, commands and on-demand skills. Include reusable files in native bodies, or prepend and append guidance to named agents. Config Composer is not required.

Package: **`@lunchbox-labs/opencode-prompt-composer`**. Requires Node **22.18+**. Native tests cover OpenCode **1.19.x** (floor **1.19.0**); other host versions are untested, not blocked. Independently maintained; not affiliated with OpenCode or Anomaly.

## Install

Add the published package to the `plugin` list in `opencode.jsonc`. Add it to `tui.jsonc` too if you want the `/compose-prompts` read-only viewer:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-prompt-composer"] }
```

OpenCode selects the server and TUI entrypoints.

`/compose-prompts` displays agent prompts and command templates currently loaded by the connected OpenCode server, including disabled-agent and native-fallback labels. Select an entry, then a page; Escape or Back returns to the previous view. Long text is available in full. The viewer works with remote servers and does not read local prompt files, edit settings, apply changes, or execute templates. Reopen it to fetch the latest loaded text; saved files are only reflected after the server loads them.

## Documentation

- [Wiki](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki) and [published npm tarball downloads](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Downloads)
- [Usage and compatibility checks](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Usage)
- [Discovery and overrides](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Discovery)
- [Migration from Config Composer](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Migration)
- [Review guidance example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Review-guidance)
- [On-demand verification skill example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/On-demand-verification)
- [Extraction provenance](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Extraction-provenance)

Runnable example projects remain under `docs/examples/`, including their native definitions, skills and prompt includes. Setup instructions are in the wiki examples above.
