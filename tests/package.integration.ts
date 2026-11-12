import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { corePackage, hosts } from "./hosts.ts";

const execute = promisify(execFile);
const npm = process.env.npm_execpath;
assert.ok(npm !== undefined, "Run package tests through npm");
const manifestOf = async (workspace: string) =>
  JSON.parse(
    await readFile(
      new URL(`../${workspace}/package.json`, import.meta.url),
      "utf8",
    ),
  ) as {
    version: string;
    devDependencies: Record<string, string>;
  };
const { devDependencies } = await manifestOf(".");
const core = await manifestOf(corePackage.workspace);

for (const host of Object.values(hosts)) {
  const { packageName, projectDirectory } = host;
  const pluginVersion = (await manifestOf(host.workspace)).devDependencies[
    host.pluginPackage
  ];
  test(
    `packed ${host.profile.name} plugin installs independently and exposes working include-only runtime and declarations`,
    { timeout: 180_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "prompt-package-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      // npm packs workspaces in their declared order, core first.
      const packed = await execute(
        process.execPath,
        [
          npm,
          "pack",
          "--workspace",
          corePackage.workspace,
          "--workspace",
          host.workspace,
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          root,
        ],
        { cwd: resolve("."), timeout: 60_000, signal: t.signal },
      );
      const [corePack, { filename, files }] = JSON.parse(packed.stdout) as {
        name: string;
        filename: string;
        files: { path: string }[];
      }[];
      assert.equal(corePack.name, corePackage.packageName);
      for (const path of [
        "dist/host.d.ts",
        "dist/server.js",
        "dist/tui.js",
        "dist/includes.d.ts",
        "README.md",
        "LICENSE",
      ]) {
        assert.ok(
          corePack.files.some((file) => file.path === path),
          `Missing core ${path}`,
        );
      }
      assert.ok(
        !corePack.files.some(
          (file) =>
            file.path.startsWith("tests/") ||
            file.path.startsWith("src/") ||
            file.path.startsWith("docs/"),
        ),
      );
      assert.ok(files.some((file) => file.path === "dist/server.d.ts"));
      assert.ok(files.some((file) => file.path === "LICENSE"));
      for (const removed of [
        "settings",
        "editor",
        "connection",
        "filesystem",
        "runtime-state",
        "registration",
        "saved-preview",
        "reload",
      ]) {
        assert.ok(
          ![...files, ...corePack.files].some((file) =>
            file.path.startsWith(`dist/${removed}.`),
          ),
          `Removed module is still packed: ${removed}`,
        );
      }

      for (const path of [
        "README.md",
        "docs/examples/review/README.md",
        `docs/examples/review/${projectDirectory}/agents/review.md`,
        `docs/examples/review/${projectDirectory}/commands/check.md`,
        `docs/examples/review/${projectDirectory}/prompts/review/context.md`,
        `docs/examples/review/${projectDirectory}/prompts/review/findings.md`,
        "docs/examples/skill-guidance/README.md",
        `docs/examples/skill-guidance/${projectDirectory}/skills/verification/SKILL.md`,
        `docs/examples/skill-guidance/${projectDirectory}/prompts/verification.md`,
      ]) {
        assert.ok(
          files.some((file) => file.path === path),
          `Missing ${path}`,
        );
      }
      assert.ok(!files.some((file) => file.path.startsWith("tests/")));
      assert.ok(
        !files.some(
          (file) =>
            file.path.endsWith("schema.json") ||
            file.path.endsWith("prompt-composer.jsonc"),
        ),
      );
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
          join(root, corePack.filename),
          join(root, filename),
          `${host.pluginPackage}@${pluginVersion}`,
          `@types/node@${devDependencies["@types/node"]}`,
        ],
        { timeout: 120_000, signal: t.signal },
      );
      const project = join(root, "project");
      await mkdir(join(project, projectDirectory, "prompts"), {
        recursive: true,
      });
      await writeFile(
        join(project, projectDirectory, "prompts/rules.md"),
        "Packed rules",
      );
      await writeFile(
        join(root, "consumer.mjs"),
        `import assert from 'node:assert/strict';
import { dialogView, fixedMenuApi } from ${JSON.stringify(pathToFileURL(resolve("packages/core/tests/fixed-menu-harness.ts")).href)};
import plugin from '${packageName}';
import tui from '${packageName}/tui';
assert.equal(tui.id, 'prompt-composer');
for (const name of ['editor', 'settings', 'schema.json']) {
  await assert.rejects(import('${packageName}/' + name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
}
const hooks = await plugin.server({ directory: process.argv[2], worktree: process.argv[2] });
const config = { agent: { review: { prompt: '{{include:rules.md}}' } }, command: { check: { template: '{{include:rules.md}} $ARGUMENTS $1 !touch', subtask: true } } };
await hooks.config(config);
assert.equal(config.agent.review.prompt, 'Packed rules');
assert.equal(config.command.check.template, 'Packed rules $ARGUMENTS $1 !touch');
assert.equal(config.command.check.subtask, true);
const before = structuredClone(config);
let current;
let open;
let reads = 0;
const commands = [];
const render = (view) => { current = view; };
await tui.tui({
  ...fixedMenuApi,
  event: { on() { return () => {}; } },
  state: { path: { directory: '/remote/project', worktree: '/remote/project' } },
  route: { current: { name: 'home' } },
  lifecycle: { signal: new AbortController().signal, onDispose() {} },
  keymap: { registerLayer(layer) { if (layer.commands) { commands.push(...layer.commands); open = layer.commands[0].run; } return () => {}; } },
  client: { app: { async agents() { return { data: [] }; } }, config: { async get(input) { assert.equal(input.directory, '/remote/project'); reads++; return { data: config }; } } },
  ui: { DialogSelect: render, DialogAlert: render, dialog: { replace(next) { const view = dialogView(next()); if (view) current = view; }, setSize() {}, get open() { return current !== undefined; } } },
}, undefined, {});
assert.deepEqual(commands.map(({ name, slashName }) => ({ name, slashName })), [{ name: 'prompt-composer.view-prompts', slashName: 'view-prompts' }]);
const choose = (value) => { const item = current.options.find((item) => item.value === value); assert.ok(item); current.onSelect(item); };
for (const [category, value, expected] of [
  ['agents', 'agent:review', config.agent.review.prompt],
  ['commands', 'command:check', config.command.check.template],
]) {
  await open();
  assert.equal(current.title, 'View prompts');
  assert.deepEqual(current.options.map((item) => item.value), ['agents', 'commands']);
  choose(category);
  choose(value);
  assert.equal(current.message, expected);
}
assert.equal(reads, 2);
assert.deepEqual(config, before);
`,
      );
      await execute(process.execPath, [join(root, "consumer.mjs"), project], {
        cwd: root,
        timeout: 60_000,
        signal: t.signal,
      });
      await writeFile(
        join(root, "consumer.mts"),
        `import plugin from '${packageName}';
import { expandIncludes } from '${packageName}/includes';
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
        { cwd: root, timeout: 60_000, signal: t.signal },
      );
      const manifest = JSON.parse(
        await readFile(
          join(root, "node_modules", packageName, "package.json"),
          "utf8",
        ),
      ) as Record<string, Record<string, string> | undefined>;
      // The adapter's only runtime dependency is core at its own version.
      assert.deepEqual(manifest.dependencies, {
        [corePackage.packageName]: core.version,
      });
      assert.equal(Object.hasOwn(manifest.engines ?? {}, host.id), false);
      assert.equal(manifest.engines?.node, ">=22.18.0");
      assert.ok(!files.some((file) => file.path.startsWith("tests/")));
      // Core has no runtime dependency on any host package.
      const installedCore = JSON.parse(
        await readFile(
          join(root, "node_modules", corePackage.packageName, "package.json"),
          "utf8",
        ),
      ) as Record<string, Record<string, string> | undefined>;
      assert.deepEqual(installedCore.dependencies ?? {}, {});
      assert.deepEqual(installedCore.peerDependencies ?? {}, {});
      assert.equal(installedCore.engines?.node, ">=22.18.0");
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
      ]) {
        assert.equal(
          manifest[field]?.["@lunchbox-labs/opencode-config-composer"],
          undefined,
        );
      }
    },
  );
}
