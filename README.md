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

Use `{{include?:personal/review.md}}` for an include that may be absent, and run `/view-prompts` to read the loaded agent and command text. Restart the OpenCode server after editing snippets. A problem with an include shows a warning toast and never stops a prompt from loading; [Usage](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Usage#snippet-lifetime) describes what is kept.

## Documentation

The [wiki](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki) has the full guides:

- [Usage](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Usage): includes, optional includes, the prompt viewer and native file references.
- [Discovery](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Discovery): prompt directories, precedence and limits.
- [Migration](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Migration): older Prompt Composer settings and Config Composer ordering.
- [Review guidance](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Review-guidance) and [On-demand verification](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/On-demand-verification): walkthroughs of the runnable projects in [docs/examples](docs/examples/).
- [Downloads](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Downloads): published package versions.
- [Developer](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Developer): development, compatibility testing and publishing.
