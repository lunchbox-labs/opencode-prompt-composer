# OpenCode Prompt Composer

Share prompt text across native OpenCode agents, commands and on-demand skills. Include reusable files directly in the native bodies that need them. Config Composer is not required.

Package: **`@lunchbox-labs/opencode-prompt-composer`**. Requires Node **22.18+**. Native tests cover OpenCode **1.19.x** (floor **1.19.0**); other host versions are untested, not blocked. Independently maintained; not affiliated with OpenCode or Anomaly.

## Install

Add the published package to the `plugin` list in `opencode.jsonc`. Add it to `tui.jsonc` too if you want the `/agent-prompts` read-only viewer:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-prompt-composer"] }
```

OpenCode selects the server and TUI entrypoints.

`/agent-prompts` is a read-only preview of the complete composed agent prompt text currently loaded by the connected OpenCode server, including expanded prompt includes. Select an agent, then a page; Escape or Back returns to the previous view. All loaded text is preserved across pages. Disabled agents are labeled, and agents without configured prompt text show a native-fallback notice. Command templates are outside this agent-only viewer.

OpenCode's system instructions, conversation history, tool schemas, and skills loaded later are outside this preview. The viewer works with remote servers and reads only loaded server config. Reopen it to fetch the latest loaded text; saved files are reflected after the server loads them.

## Use explicit includes

Write shared text in `.opencode/prompts/review.md`:

```markdown
Check the implementation and report actionable findings with evidence.
```

Include it in an agent prompt, command template, or on-demand skill body:

```markdown
Review the supplied changes.

{{include:review.md}}

Distinguish observed behavior from assumptions.
```

Includes expand recursively; each included file is trimmed at its edges. Escape a literal marker with `\{{include:review.md}}`. Native command syntax such as `$ARGUMENTS`, `$1`, `@file` and shell fragments stays intact. Native metadata is preserved. Disabled agents and agents with absent or blank prompts retain their native behavior.

Prompt files come from fixed `prompts/` directories under OpenCode's discovered configuration directories: global config, project `.opencode` ancestors, home `.opencode`, then `OPENCODE_CONFIG_DIR`. The last discovered file with the same relative path wins. Project discovery follows `OPENCODE_DISABLE_PROJECT_CONFIG`; there are no custom source mappings.

There is no Prompt Composer settings file or policy layer. Put any before/after guidance explicitly in each native body, in the order you want. Existing `prompt-composer.jsonc` files are ignored. Includes accept safe relative `.md` and `.txt` paths, with containment checks, UTF-8 validation, and limits of 64 KiB per snippet, 256 KiB per expanded body, 32 nesting levels and 256 includes. Bodies without include markers pass through without an include-size limit.

The public `@lunchbox-labs/opencode-prompt-composer/includes` utility exports `expandIncludes(text, sources, onRead?, consumer?)`. Its registry maps relative names to `{path, root, relativePath}`; optional read callbacks receive `{path, canonicalPath, text, mode}`. The editor overlay argument, editor metadata and settings/schema exports have been removed.

## Native boundaries

Agent prompts and configured command templates expand when OpenCode runs the plugin's config hook. Skill bodies expand when the native `skill` tool returns them. If its output contains an include marker, the supported OpenCode 1.19.x wrapper is checked before locating the body; its name, base directory and sampled filenames remain literal. Unknown, incomplete or ambiguous framing is then rejected without publishing a partially composed result. Marker-free output passes through without framing checks. Output explicitly marked truncated by the host is always rejected.

OpenCode's automatically generated `/skill-name` commands use cached skill text outside these hooks: **includes in that slash route do not expand**. A configured command with its own explicit includes is supported. Frontmatter, `AGENTS.md`, direct file reads and other tool output are outside this plugin's composition boundary. The read-only `/agent-prompts` viewer shows the complete composed agent prompt text returned by the server; it does not load skills.

Edit native bodies and snippets in your usual editor. Reload or restart the OpenCode instance to refresh loaded agent/command bodies and cached skill definitions. A new skill-tool call reads its referenced snippets again, but does not invalidate the host's cached skill body. Reopening the viewer only fetches the server's currently loaded text.

Composition errors preserve the previous config object or skill output. OpenCode 1.19.x logs and ignores config-hook failures, so an error does **not** guarantee startup stops or that the host refuses the original unexpanded text. Check host errors and loaded text after editing includes.

## Documentation

- [Wiki](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki) and [published npm tarball downloads](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Downloads)
- [Usage and compatibility checks](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Usage)
- [Discovery and overrides](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Discovery)
- [Migration from Config Composer](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Migration)
- [Review guidance example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Review-guidance)
- [On-demand verification skill example](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/On-demand-verification)
- [Extraction provenance](https://github.com/lunchbox-labs/opencode-prompt-composer/wiki/Extraction-provenance)

Runnable example projects remain under `docs/examples/`, including their native definitions, skills and prompt includes. Setup instructions are in the wiki examples above.
