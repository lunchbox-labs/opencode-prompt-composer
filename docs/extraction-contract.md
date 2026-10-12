# Extraction provenance

The extraction starts from Config Composer main `d21789c4234dc3f05c1ebf7336cd277f1c0df6c9`, including native Markdown/JSONC command expansion from #76. The MIT include safety engine, dependency capture, connection check and dialog navigation were adapted; unrelated configuration composition was not copied.

Audited open work:

- [#75](https://github.com/lunchbox-labs/opencode-config-composer/pull/75), `91838ef01fb92915c3384e7ad275ce020a965d77`: concise OpenCode-fluent docs and examples without redundant component mappings informed these docs.
- [#77](https://github.com/lunchbox-labs/opencode-config-composer/pull/77), `9637df18a170c62630f8f5381e3cbdc7c73e277c`: external configuration-profile selection remains Config Composer's responsibility; none of its state machinery is copied.
- [#78](https://github.com/lunchbox-labs/opencode-config-composer/pull/78), `669d7c511c855302b71615a3b39de6c3284243b1`: preserve nonfatal missing/disabled target diagnostics and fatal malformed/unsafe fragments. Named prompt-reference diagnostics are superseded by the approved filesystem include interface. Generic native component discovery remains outside this package.

Approved changes from the original inventory: conventional automatic prompt discovery replaces source aliases and explicit prompt maps; plain-text/include arrays replace named promptRefs; only defaults and per-agent operations remain. Profile-targeted prompting, groups, imports and adapters are intentionally absent. See [migration](migration.md) and [discovery](discovery.md).

Coexistence baseline: config-only [PR #80](https://github.com/lunchbox-labs/opencode-config-composer/pull/80), commit `ab213bd9bcb8706fc7f0e2d7a04a2ffd8428ed0d`. Both registration orders are exercised against packed Prompt Composer. No source-repository working files were changed.
