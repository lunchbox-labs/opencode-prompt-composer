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

Run `/view-prompts`, choose Agents or Commands, then select a component to read its complete loaded text. Configured agents are shown by default; use **Show built-in agents** to include native defaults. Skill composition is supported, but the viewer omits skills due to API limitations.

Prompt snippets are captured when the project loads. Restart the OpenCode server after editing snippets or native prompt definitions.

## Includes and native `{file:}` references

OpenCode substitutes `{file:path}` inside JSON configuration strings before plugins run. The path resolves relative to the configuration file or `~/`, the reference is not recursive, there is no escape, and a missing file fails configuration loading. Use it to load one whole prompt from a file.

Includes work inside Markdown agent, command and skill bodies, expand recursively, resolve against the discovered `prompts/` directories, and accept the `\{{include:...}}` escape. A prompt loaded through `{file:}` can contain include markers; they expand normally because the plugin sees the substituted text.

## Documentation

- [Usage](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Usage)
- [Discovery and overrides](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Discovery)
- [Review guidance example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Review-guidance)
- [On-demand verification skill example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/On-demand-verification)
- [Downloads](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Downloads)

Runnable projects are in [docs/examples](docs/examples/).
