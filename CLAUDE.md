# Claude Code instructions

@AGENTS.md

## Claude Code notes

- The shared Lunchbox Labs standards linked from `AGENTS.md` are in the public `lunchbox-labs/.github` repository
  under `agent-guidance/`. Read `common.md`, `workflows.md`, and `npm-packages.md` before editing. In cloud sessions
  look for a checkout at `../lunchbox-labs/.github`; clone `https://github.com/lunchbox-labs/.github` there when absent.
- Install with `npm ci`. Node 22.18 or newer is required; CI runs Node 24.
- `npm run check` runs typecheck, lint, format check, and unit tests. Run `npm run test:package` separately for the
  packed-package test.
- `npm run test:native` needs x64 Linux or Windows, ripgrep, and network access to the npm registry. It resolves the
  newest OpenCode release in the range from `tests/opencode.json`, installs it into a temporary directory, and drives
  the real TUI. Run it through npm; the test asserts `npm_execpath` is set.
