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

Mark an include optional with `?` when the snippet may be absent, such as personal guidance in a shared project agent:

```markdown
{{include?:personal/review.md}}
```

If no discovered prompts directory contains the file, the marker expands to nothing; a developer opts in by adding `~/.config/opencode/prompts/personal/review.md`. Everything else matches `{{include:...}}`: an invalid path, an unreadable or invalid file, a cycle or a limit leaves that include out and shows a warning.

Prompt files live in `prompts/` under OpenCode's configuration directories. Later discovered files override earlier files with the same relative path. See [Discovery](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Discovery) for precedence and limits.

Skill bodies expand through the native `skill` tool; automatically generated skill slash commands do not expand includes.

Run `/view-prompts`, choose Agents or Commands, then select a component to read its complete loaded text in a scrollable viewer. Text longer than 65,536 characters, or with a line longer than 4,096 characters, opens as a list of parts. Configured agents are shown by default; use **Show built-in agents** to include native defaults. Skill composition is supported, but the viewer omits skills due to API limitations.

Prompt snippets are captured when the project loads. Restart the OpenCode server after editing snippets or native prompt definitions.

Problems never stop OpenCode from loading a prompt. An include that cannot be expanded is left out, a malformed marker stays as written, and a prompt over the 256 KiB limit keeps its native text. Prompt files that link outside their prompts directory or cannot be read are ignored. Each of these shows a warning toast.

## Documentation

- [Usage and native file references](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Usage)
- [Discovery and overrides](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Discovery)
- [Review guidance example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Review-guidance)
- [On-demand verification skill example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/On-demand-verification)
- [Downloads](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Downloads)

Runnable projects are in [docs/examples](docs/examples/).

Contributor and maintainer guidance is in the [Developer wiki](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Developer).
