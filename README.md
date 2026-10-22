# OpenCode Prompt Composer

Share reusable prompt text across native OpenCode agents, commands and on-demand skills with explicit inline includes.

Requires Node **22.18+**. Tested with OpenCode **1.19.x**, starting at **1.19.0**.

## Install

Add the package to `plugin` in `opencode.jsonc`, and to `tui.jsonc` for the prompt viewer:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-prompt-composer"] }
```

## Include shared text

Write shared text in `.opencode/prompts/review.md`:

```markdown
Check the implementation and report actionable findings with evidence.
```

Include it where it belongs in an agent prompt, command template or skill body:

```markdown
Review the supplied changes.

{{include:review.md}}

Distinguish observed behavior from assumptions.
```

Includes accept relative `.md` and `.txt` paths and expand recursively. Each included file is trimmed at its edges; surrounding text determines spacing. Escape a literal marker with `\{{include:review.md}}`.

Prompt files live in `prompts/` under OpenCode's configuration directories. Later discovered files override earlier files with the same relative path. See [Discovery](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Discovery) for precedence and limits.

Skill bodies expand through the native `skill` tool; automatically generated skill slash commands do not expand includes.

Run `/view-prompts`, choose Agents or Commands, then select a component to read its complete loaded text. Skill composition is supported, but the viewer omits skills due to API limitations.

Run `/reload-prompts`, or choose Reload prompts in `/view-prompts`, after editing prompts. Wait until OpenCode sessions are idle first. Global JSON configuration changes require restarting OpenCode.

## Documentation

- [Usage](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Usage)
- [Discovery and overrides](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Discovery)
- [Review guidance example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Review-guidance)
- [On-demand verification skill example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/On-demand-verification)
- [Downloads](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Downloads)

Runnable projects are in [docs/examples](docs/examples/).
