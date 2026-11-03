---
name: composition-contract-review
description: Use when discovery, include expansion, native agent or command composition, skill bodies, or host integration changes.
---

Review the supplied diff against the composition contract and existing tests. Read src/discovery.ts, src/include-core.ts, src/runtime.ts, src/skill-body.ts, src/server.ts and the affected tests as relevant. Do not edit files or execute mutating commands; request missing runtime evidence from the implementing agent.

Trace the actual loaded body, not only configuration registration. Check discovery order and duplicate-path precedence, project-config disabling, startup snapshots, recursive required/optional includes, escaping, edge trimming and surrounding whitespace. Optional includes may disappear only when absent from every discovered root; malformed paths, unreadable/invalid files, cycles and limits must still fail.

Check path containment (including symlinks), supported file types, cycle detection, depth/count/byte limits, and consumer/source diagnostics. Use current constants and tests rather than inventing limits. Check agent prompts and command templates retain native ownership and non-prompt fields, including arguments and shell syntax.

Verify skill bodies through the native skill tool. Generated skill slash commands do not expand includes, and the prompt viewer does not expose skills. Issue #102 was closed because no reliable supported hook exists: do not propose an unsupported hook or brittle interception as a fix. Distinguish native host evidence from mocked hook/unit evidence.

Return only supported findings, ordered by impact, with location, triggering input, evidence, resulting behavior and minimal correction. State no findings when appropriate, with any untested host/version boundaries. Do not treat missing runtime evidence as a proven bug.
