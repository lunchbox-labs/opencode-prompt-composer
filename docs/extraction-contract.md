# Extraction provenance

The extraction starts from Config Composer main `d21789c4234dc3f05c1ebf7336cd277f1c0df6c9`, including native Markdown/JSONC command expansion from #76. The MIT include safety engine, dependency capture, connection check and dialog navigation were adapted; unrelated configuration composition was not copied.

Audited open work:

- [#75](https://github.com/lunchbox-labs/opencode-config-composer/pull/75), `91838ef01fb92915c3384e7ad275ce020a965d77`: concise OpenCode-fluent docs and examples without redundant component mappings informed these docs.
- [#77](https://github.com/lunchbox-labs/opencode-config-composer/pull/77), `9637df18a170c62630f8f5381e3cbdc7c73e277c`: external configuration-profile selection remains Config Composer's responsibility; none of its state machinery is copied.
- [#78](https://github.com/lunchbox-labs/opencode-config-composer/pull/78), `669d7c511c855302b71615a3b39de6c3284243b1`: preserve nonfatal missing/disabled target diagnostics and fatal malformed/unsafe fragments. Named prompt-reference diagnostics are superseded by the approved filesystem include interface. Generic native component discovery remains outside this package.

Approved changes from the original inventory: conventional automatic prompt discovery replaces source aliases and explicit prompt maps; plain-text/include arrays replace named promptRefs; only defaults and per-agent operations remain. Profile-targeted prompting, groups, imports and adapters are intentionally absent. See [migration](migration.md) and [discovery](discovery.md).

Config-only [PR #80](https://github.com/lunchbox-labs/opencode-config-composer/pull/80) merged as `dc80b31e3178b340245efa26dabd3c42d963a031`. Neither package is required by the other. When both are installed, Config Composer must run first so Prompt Composer receives final agent availability. Full editor coexistence is tested against [Config Composer #82](https://github.com/lunchbox-labs/opencode-config-composer/pull/82) at `34c4e8491cd33ff9f7952623882a98738c6e752d`; marker-only checks against #80 were insufficient. Native tests now exercise both editor load/apply paths, enabled/disabled agents, and command-only composition. No source-repository working files were changed.
