# Migrating from Config Composer

Prompt Composer works independently; Config Composer is not required. If you retain Config Composer for its separate configuration features, use its config-only version from [PR #80](https://github.com/lunchbox-labs/opencode-config-composer/pull/80). Do not register Prompt Composer beside older Config Composer versions that still expand prompts: two expanders can duplicate fragments and consume escaped markers twice.

When using both packages, register Config Composer **before** Prompt Composer so prompt operations see its final agent availability. Do not reverse that order: agents enabled later by Config Composer would miss composition, and its availability changes invalidate Prompt Composer's editor baseline. Only this optional editor coexistence requires [Config Composer #82](https://github.com/lunchbox-labs/opencode-config-composer/pull/82), which excludes downstream prompt/template text from its configuration freshness checks; merged #80 alone does not support both editors. This package does not modify the other plugin's private runtime metadata.

Move reusable text into conventional `prompts/` directories. Change `{{include:@team/review.md}}` to `{{include:review.md}}` after placing that file under a discovered `prompts/` root. Remove configurable `sourceDirectories` and explicit prompt component mappings; later roots resolve duplicate relative filenames automatically.

Move independent defaults and per-agent prepend/append lists into `prompt-composer.jsonc`. Replace ordered `promptRefs` with ordered include strings in the agent's `append` list, placing those reference includes before its other appends. `inheritDefaults` remains supported. Keep native agent, command and skill definitions in OpenCode's own files.

Configuration-profile-driven prompt switching was intentionally removed by agreement. There is no profile bridge, prompt profile system, conditional group selection or `inheritGroups`. Decide explicitly which formerly conditional fragments should be unconditional; do not automatically flatten conflicting profiles. Model, permission and profile settings stay in `config-composer.jsonc`.

Prompt definitions, source-alias editing and automatic alias renames disappear with the removed registries. The standalone editor covers agent/default rules, preview, save and apply. Rename or edit snippet files in your normal editor and update their include consumers explicitly. The package does not rewrite native OpenCode files.

The runtime leaves agents without an authored prompt on the native fallback. To attach rules to such an agent, supply an intentional native prompt through OpenCode; this package does not scrape or replace internal built-in system prompts.
