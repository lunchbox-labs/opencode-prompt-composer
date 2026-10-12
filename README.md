# OpenCode Prompt Composer

Share prompt text across native OpenCode agents, commands and skills. Include reusable files where they belong in a body, or prepend and append guidance to named agents without changing their authored prompts.

Package: **`@lunchbox-labs/opencode-prompt-composer`**. Tested host: **OpenCode 1.18.34**, Node **22.18+**. Independently maintained; not affiliated with OpenCode or Anomaly.

## Include reusable text

Put snippets in a conventional `prompts/` directory, such as `.opencode/prompts/review/findings.md`. Use their relative filename in an existing agent, command or skill body:

```markdown
Review the changes and explain actionable findings.
{{include:review/findings.md}}
```

No prompt registry or file mapping is needed. Nested includes resolve against the same discovered files. `.md` and `.txt` are supported; `\{{include:review/findings.md}}` keeps a literal marker. Skill bodies expand only when OpenCode loads the skill, not eagerly into agents.

## Add agent guidance

Optional `prompt-composer.jsonc` lives beside `prompts/`. It has only defaults and named agent rules:

```jsonc
{
  "defaults": { "append": ["State uncertainty explicitly."] },
  "agents": {
    "review": {
      "prepend": ["{{include:review/context.md}}"],
      "append": ["Prioritize actionable findings."],
      "inheritDefaults": false
    }
  }
}
```

Composition order is default prepends, agent prepends, authored body, default appends, agent appends. Set `inheritDefaults: false` to omit both default lists. Lists retain their order. Later settings replace earlier values field by field, including whole arrays; an empty array clears that list. Native agents without an authored prompt retain OpenCode's built-in fallback rather than having it replaced with fragments. Missing or disabled agent targets produce a notice; malformed settings and unsafe or missing includes fail composition.

## Discovery and overrides

Prompt Composer mirrors the pinned host's **agent/command directory order**: global OpenCode config directory; project `.opencode` directories from the opened directory upward to the worktree; home `.opencode`; then `OPENCODE_CONFIG_DIR`. Later files with the same relative filename win. Settings use the same order. `OPENCODE_DISABLE_PROJECT_CONFIG` disables project discovery. There are no custom prompt directories or source aliases. [Exact discovery behavior](docs/discovery.md).

OpenCode continues to own agents, commands, skills, models and permissions. Prompt Composer discovers only its own prompt files and settings. **It is fully usable on its own and has no dependency on Config Composer.** It does not read configuration profiles or the other plugin's settings, schema or runtime markers.

If you choose to install both packages, register the config-only Config Composer first so prompt operations see its final enabled agents. Only this optional combination needs [Config Composer #82](https://github.com/lunchbox-labs/opencode-config-composer/pull/82) for editor coexistence. [Migration notes](docs/migration.md).

## Install

Add the published package to the `plugin` list in `opencode.jsonc`. Add it to `tui.jsonc` too if you want the prompt editor:

```jsonc
{ "plugin": ["@lunchbox-labs/opencode-prompt-composer"] }
```

OpenCode selects the server and TUI entrypoints. Config Composer is not required.

### Use a local build

Run `npm ci`, `npm run build`, and `npm pack`; install the tarball into a separate directory. Register the absolute installed package directory in the `plugin` list of `opencode.jsonc` and, for the editor, `tui.jsonc`. OpenCode selects each entrypoint. No registry release is required.

```jsonc
{ "plugin": ["/absolute/path/to/installed/opencode-prompt-composer"] }
```

## Edit prompt settings

`/compose-prompts` edits defaults or agent rules as JSON, previews complete composed agent prompts, command templates and notices, and saves JSONC without removing comments. Select **Apply saved prompt settings** from its main menu when agents are idle. This action remains available after files change. If no settings source exists, the edit menu can create project settings when project discovery is enabled.

Preview offers an agent/command chooser, then numbered pages of the selected text. Use Escape or OK to return to the page list, and Back or Escape to return to the chooser. Disabled agents and native fallbacks are labeled. Command placeholders stay literal; Preview does not invoke commands or show the full model request.

The editor checks the server filesystem and rejects stale settings or changed include dependencies. Edit snippet files through your normal editor; authored OpenCode files remain untouched. Composition uses OpenCode’s loaded agent and command bodies. After editing those native files externally, reload before previewing or saving prompt rules.

Select **Preview saved prompt changes** to inspect saved Prompt settings and snippets before applying them. It uses the currently loaded native definitions and the complete selected-body viewer, with **not applied** labels on the result and its pages. It verifies source reads, inventory, connection and filesystem identities for project/global/home/custom discovery locations before showing the snapshot. Missing identity evidence requires a server-plugin reload; unsupported filesystems cannot use this action. Directory identities detect accidental filesystem mismatches, not malicious servers or cloned filesystems. Errors and composition notices do not apply changes, dispose the instance or write files. Native definition edits still require reload; editor and save freshness checks remain strict. This preview does not execute skills or show the full model request.

## Examples and checks

- [Review guidance](docs/examples/review/README.md): one format shared by an agent and a native command.
- [On-demand verification](docs/examples/skill-guidance/README.md): a skill includes a shared checklist when loaded.

`npm run check`, `npm run test:package`, and `npm run test:native` cover source checks, packed installation, and real OpenCode behavior. Native tests use an isolated local model fixture and no provider account. CI runs on Linux and Windows, both standalone and with Config Composer first, using the compatibility fix from #82. Pull requests and ordinary pushes do not publish packages.

Maintainers: [release workflow setup](docs/publishing.md) covers the initial manual release and later npm trusted publishing.
