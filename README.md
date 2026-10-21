# OpenCode Prompt Composer

Share prompt text across native OpenCode agents, commands and on-demand skills. Include reusable files in native bodies, or prepend and append guidance to named agents. Config Composer is not required.

Package: **`@lunchbox-labs/opencode-prompt-composer`**. Requires Node **22.18+**. Native tests cover OpenCode **1.19.x** (floor **1.19.0**); other host versions are untested, not blocked. Independently maintained; not affiliated with OpenCode or Anomaly.

## Install

Add the published package to the `plugin` list in `opencode.jsonc`. Add it to `tui.jsonc` too if you want the `/compose-prompts` editor:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-prompt-composer"] }
```

OpenCode selects the server and TUI entrypoints.

## Documentation

- [Wiki](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki) and [published npm tarball downloads](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Downloads)
- [Usage, editor and compatibility checks](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Usage)
- [Discovery and overrides](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Discovery)
- [Migration from Config Composer](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Migration)
- [Review guidance example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Review-guidance)
- [On-demand verification skill example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/On-demand-verification)
- [Extraction provenance](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Extraction-provenance)

Runnable example projects remain under `docs/examples/`, including their native definitions, skills and prompt includes. Setup instructions are in the wiki examples above.
