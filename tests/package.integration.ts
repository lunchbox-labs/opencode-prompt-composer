import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { corePackage, hosts } from "./hosts.ts";

const dependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

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

/** Every file under a directory, as paths relative to it. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

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
      // Core is private and bundled into the package, so only the package
      // itself is packed and installed.
      const packed = await execute(
        process.execPath,
        [
          npm,
          "pack",
          "--workspace",
          host.workspace,
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          root,
        ],
        { cwd: resolve("."), timeout: 60_000, signal: t.signal },
      );
      const packs = JSON.parse(packed.stdout) as {
        name: string;
        filename: string;
        files: { path: string }[];
      }[];
      assert.deepEqual(
        packs.map(({ name }) => name),
        [packageName],
      );
      const [{ filename, files }] = packs;
      for (const entry of ["server", "includes", "tui"]) {
        for (const extension of ["js", "d.ts"]) {
          const path = `dist/${entry}.${extension}`;
          assert.ok(
            files.some((file) => file.path === path),
            `Missing ${path}`,
          );
        }
      }
      assert.ok(
        !files.some(
          (file) => file.path.startsWith("src/") || file.path.endsWith(".map"),
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
          !files.some((file) => file.path.startsWith(`dist/${removed}.`)),
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
import server from '${packageName}/server';
import * as includes from '${packageName}/includes';
import tui from '${packageName}/tui';
assert.equal(server, plugin);
assert.equal(plugin.id, 'prompt-composer');
assert.equal(tui.id, 'prompt-composer');
assert.deepEqual(Object.keys(includes).sort(), ['MAX_INCLUDES', 'MAX_INCLUDE_DEPTH', 'MAX_PROMPT_BYTES', 'MAX_SNIPPET_BYTES', 'expandIncludes']);
assert.equal(await includes.expandIncludes('Use {{include:rules.md}}.', new Map([['rules.md', { path: process.argv[2] + '/${projectDirectory}/prompts/rules.md', root: process.argv[2] + '/${projectDirectory}/prompts', relativePath: 'rules.md' }]])), 'Use Packed rules.');
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
import server from '${packageName}/server';
import tui from '${packageName}/tui';
import {
  MAX_INCLUDES,
  type PromptDependency,
  type PromptRead,
  expandIncludes,
} from '${packageName}/includes';
const id: string = plugin.id;
const same: typeof plugin = server;
const tuiId: string = tui.id;
const limit: number = MAX_INCLUDES;
const onRead: PromptRead = (dependency: PromptDependency) => {
  const text: string = dependency.text;
  console.log(text);
};
await expandIncludes('body', new Map(), onRead);
// @ts-expect-error -- A discovered-file registry cannot be replaced by a string.
await expandIncludes('body', 'bad');
console.log(id, same.id, tuiId, limit);
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
      // Core is bundled, so the package has no runtime dependency, names
      // core in no dependency field, and installs without it.
      assert.deepEqual(manifest.dependencies ?? {}, {});
      for (const field of dependencyFields) {
        assert.equal(
          manifest[field]?.[corePackage.packageName],
          undefined,
          field,
        );
      }
      assert.equal(Object.hasOwn(manifest.engines ?? {}, host.id), false);
      assert.equal(manifest.engines?.node, ">=22.18.0");
      assert.ok(!files.some((file) => file.path.startsWith("tests/")));
      await assert.rejects(
        readFile(
          join(root, "node_modules", corePackage.packageName, "package.json"),
        ),
        { code: "ENOENT" },
      );
      // No installed file refers to core, and the build inlined only core's
      // and the package's own sources: no file comes from node_modules, and
      // each core module is inlined once, so modules the entries share, such
      // as the startup snippet cache, have one instance.
      const installed = join(root, "node_modules", packageName);
      const inlined = new Map<string, string[]>();
      for (const file of await filesUnder(installed)) {
        const text = await readFile(file, "utf8");
        assert.ok(!text.includes(corePackage.packageName), file);
        if (!file.endsWith(".js")) {
          continue;
        }
        assert.ok(!text.includes("node_modules"), file);
        // Rolldown starts each inlined module with a comment naming it.
        for (const [, path] of text.matchAll(/^\/\/ (\S+\.ts)\r?$/gm)) {
          const source = path.replaceAll("\\", "/");
          assert.match(source, /^(?:\.\.\/core\/)?src\/[\w-]+\.ts$/, file);
          inlined.set(source, [...(inlined.get(source) ?? []), file]);
        }
      }
      assert.ok(inlined.has("../core/src/startup-snippets.ts"));
      for (const [source, copies] of inlined) {
        assert.equal(
          copies.length,
          1,
          `${source} is inlined in ${copies.join(", ")}`,
        );
      }
      for (const field of dependencyFields) {
        assert.equal(
          manifest[field]?.["@lunchbox-labs/opencode-config-composer"],
          undefined,
        );
      }
    },
  );
}
