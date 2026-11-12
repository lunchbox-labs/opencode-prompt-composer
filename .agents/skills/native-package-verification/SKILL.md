---
name: native-package-verification
description: Use when verifying changes to composition behavior, host integration, viewer behavior, package exports, or distributed files.
---

Read the root and packages/*/package.json manifests, tests/hosts.ts, tests/package.integration.ts, tests/native.integration.ts and the affected tests before selecting checks. Use the committed lockfile and supported Node version; install with npm ci when needed. Do not change dependencies, versions, or security exceptions to make checks pass.

Run npm run check for static and unit checks. Run npm run test:package for exports or distribution changes; inspect the packed file list and exercise the packed package rather than relying on source imports. Keep root .agents, .codex, .claude, .opencode and CLAUDE.md contributor files out of every package, and tests and sources out of the core package. Preserve packages/opencode/docs/examples and packages/kilo/docs/examples as shipped product examples.

Run npm run test:native for host, composition, or viewer changes. Inspect its setup first: it resolves and installs the supported host named by NATIVE_HOST (opencode by default, or kilo) and uses isolated fixtures. Run each host a change can affect, using the existing OPENCODE_TEST_VERSION or KILO_TEST_VERSION lanes when needed, without weakening the compatibility baseline. Follow the existing harness; do not invoke paid model/API calls. Report unavailable dependencies, hosts, or blocked checks rather than replacing native evidence with a mock.

Inspect actual loaded agent/command text and skill-tool bodies, plus viewer behavior where affected. Configuration presence alone does not prove body composition. Verify required, recursive, optional and escaped includes against the relevant existing cases; generated skill slash commands remain outside the composition contract. Restart the server between changed startup definitions.

Report commands, exit results, host/version and lane, observed loaded-body/package evidence, and any skipped or unavailable checks. Distinguish source inference, unit/packed tests and native runtime observations. Keep detailed task evidence on the linked issue, not in committed plan documents.
