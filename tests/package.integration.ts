import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const npm = process.env.npm_execpath;
assert.ok(npm !== undefined, "Run package tests through npm");

test(
  "packed plugin installs independently and exposes working runtime, schema and declarations",
  { timeout: 180_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "prompt-package-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const packed = await execute(
      process.execPath,
      [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: resolve(".") },
    );
    const [{ filename, files }] = JSON.parse(packed.stdout) as {
      filename: string;
      files: { path: string }[];
    }[];
    assert.ok(files.some((file) => file.path === "dist/server.d.ts"));
    assert.ok(files.some((file) => file.path === "LICENSE"));
    assert.ok(!files.some((file) => file.path.startsWith("tests/")));
    await execute(
      process.execPath,
      [
        npm,
        "install",
        "--prefix",
        root,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        join(root, filename),
        "@opencode-ai/plugin@1.18.34",
        "@types/node@24.19.1",
      ],
      { timeout: 120_000 },
    );
    const project = join(root, "project");
    await mkdir(join(project, ".opencode/prompts"), { recursive: true });
    await writeFile(
      join(project, ".opencode/prompts/rules.md"),
      "Packed rules",
    );
    await writeFile(
      join(root, "consumer.mjs"),
      `import assert from 'node:assert/strict';
import plugin from '@lunchbox-labs/opencode-prompt-composer';
import tui from '@lunchbox-labs/opencode-prompt-composer/tui';
import schema from '@lunchbox-labs/opencode-prompt-composer/schema.json' with { type: 'json' };
assert.equal(tui.id, 'prompt-composer');
assert.equal(schema.additionalProperties, false);
const hooks = await plugin.server({ directory: process.argv[2], worktree: process.argv[2] });
const config = { agent: { review: { prompt: '{{include:rules.md}}' } } };
await hooks.config(config);
assert.equal(config.agent.review.prompt, 'Packed rules');
`,
    );
    await execute(process.execPath, [join(root, "consumer.mjs"), project], {
      cwd: root,
    });
    await writeFile(
      join(root, "consumer.mts"),
      `import plugin from '@lunchbox-labs/opencode-prompt-composer';
import { expandIncludes } from '@lunchbox-labs/opencode-prompt-composer/includes';
const id: string = plugin.id;
await expandIncludes('body', new Map());
// @ts-expect-error -- A discovered-file registry cannot be replaced by a string.
await expandIncludes('body', 'bad');
console.log(id);
`,
    );
    await execute(
      process.execPath,
      [
        resolve("node_modules/typescript/bin/tsc"),
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "--module",
        "NodeNext",
        "--target",
        "ES2023",
        join(root, "consumer.mts"),
      ],
      { cwd: root },
    );
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          "node_modules/@lunchbox-labs/opencode-prompt-composer/package.json",
        ),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    assert.equal(
      manifest.dependencies["@lunchbox-labs/opencode-config-composer"],
      undefined,
    );
  },
);
