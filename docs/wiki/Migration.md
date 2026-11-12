# Migration

## From older Prompt Composer settings

Current Prompt Composer uses explicit includes in native bodies. It no longer reads `prompt-composer.jsonc`, accepts plugin options, or provides the `/compose-prompts` editor.

Move each default or per-agent prepend/append into the appropriate native agent body at the intended position. Shared guidance can live in a snippet referenced by several agents. Preserve the intended order and resolve any formerly conditional guidance explicitly; there is no prompt-profile selection mechanism.

Replace source-alias references such as `{{include:@team/review.md}}` with `{{include:review.md}}` after moving the file into a discovered `prompts/` directory. Remove obsolete settings after transferring the guidance. Keep native agent, command and skill definitions in the host's own files. [Discovery](Discovery) explains override order.

Use `/view-prompts` to inspect loaded agent prompts and command templates. Edit files in your normal editor and restart the OpenCode or Kilo server to capture new snippets. The viewer does not save or apply settings.

## Using Config Composer alongside Prompt Composer

Config Composer is an OpenCode plugin, so this section applies to the OpenCode package only. The packages are independent. Config Composer owns configuration composition; Prompt Composer owns prompt includes. When using both, register Config Composer first so Prompt Composer receives the resulting agent availability. Avoid older Config Composer releases that also expand prompts, which can expand escaped markers twice.

Compatibility testing uses an explicit Config Composer baseline; it does not establish compatibility with every Config Composer revision. See [Developer](Developer#host-compatibility) for the test policy. Configuration migration belongs in [Config Composer's documentation](https://github.com/lunchbox-labs/opencode-config-composer/wiki).

Agents without a nonblank authored prompt retain native fallback. To compose guidance into such an agent, author its native prompt intentionally and place includes there.
