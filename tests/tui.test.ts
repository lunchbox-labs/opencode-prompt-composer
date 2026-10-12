import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import server from "../src/server.ts";
import tui from "../src/tui.ts";
import { packageName } from "../src/registration.ts";

interface View {
  title: string;
  options?: { title: string; value: string }[];
  onSelect?: (item: { title: string; value: string }) => void;
  onConfirm?: (text?: string) => void;
  message?: string;
}

test("TUI previews, saves JSONC, and applies rules through a matching server baseline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "prompt-tui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "nested");
  await mkdir(directory);
  await mkdir(join(root, ".opencode"));
  const path = join(root, ".opencode/prompt-composer.jsonc");
  await writeFile(path, '// Keep comment\n{"agents":{}}');
  const authored: Config = {
    plugin: [packageName],
    agent: { review: { prompt: "Review" } },
  };
  const hooks = await server.server({
    directory,
    worktree: root,
  } as PluginInput);
  let config = structuredClone(authored);
  await hooks.config!(config);
  let pendingReload = false;
  let disposalCount = 0;
  let changeDuring: "baseline" | "refresh" | undefined;
  let reloadReads = 0;
  const commands = new Map<string, () => void>();
  const slashNames: string[] = [];
  let current: View | undefined;
  let closed: (() => void) | undefined;
  const alerts: string[] = [];
  const render = (view: View) => {
    current = view;
    if (view.title === "Prompt Composer") {
      alerts.push(view.message ?? "");
    }
  };
  const api = {
    state: { path: { directory, worktree: root } },
    lifecycle: { signal: new AbortController().signal, onDispose() {} },
    route: { current: { name: "home" } },
    keymap: {
      registerLayer(layer: {
        commands: { name: string; slashName: string; run: () => void }[];
      }) {
        for (const command of layer.commands) {
          commands.set(command.name, command.run);
          slashNames.push(command.slashName);
        }
        return () => {};
      },
    },
    client: {
      file: {
        async read(input: { path: string; directory: string }) {
          return {
            data: {
              type: "text",
              content: await readFile(
                join(input.directory, input.path),
                "utf8",
              ),
            },
          };
        },
      },
      config: {
        async get() {
          if (changeDuring === "baseline") {
            Object.assign(api.state.path, { directory: root });
          }
          if (pendingReload) {
            reloadReads++;
            if (reloadReads === 1) {
              return { data: structuredClone(config) };
            }
            if (reloadReads === 2) {
              return { data: structuredClone(authored) };
            }
            config = structuredClone(authored);
            await hooks.config!(config);
            pendingReload = false;
            if (changeDuring === "refresh") {
              Object.assign(api.state.path, { directory: root });
            }
          }
          return { data: structuredClone(config) };
        },
      },
      session: {
        async status() {
          return { data: {} };
        },
      },
      instance: {
        async dispose() {
          disposalCount++;
          pendingReload = true;
          return { data: true };
        },
      },
    },
    ui: {
      DialogSelect: render,
      DialogAlert: render,
      DialogConfirm: render,
      DialogPrompt: render,
      dialog: {
        replace(next: () => void, onClose?: () => void) {
          closed?.();
          closed = onClose;
          next();
        },
        clear() {
          closed?.();
          closed = undefined;
          current = undefined;
        },
        get open() {
          return current !== undefined;
        },
      },
    },
  } as unknown as TuiPluginApi;
  await tui.tui(api, undefined, {} as TuiPluginMeta);
  assert.deepEqual(slashNames, ["compose-prompts"]);
  async function view(title: string) {
    for (let n = 0; n < 200 && current?.title !== title; n++) {
      await setTimeout(5);
    }
    assert.equal(current?.title, title, current?.message);
    return current;
  }
  function choose(value: string) {
    const item = current?.options?.find((item) => item.value === value);
    assert.ok(item !== undefined);
    current?.onSelect?.(item);
  }
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("edit");
  await view("Prompt settings source");
  choose(path);
  await view("Edit prompt settings");
  choose("agents");
  (await view("Agent fragments and default inheritance")).onConfirm?.(
    '{"review":{"append":["After"]}}',
  );
  let preview = await view("Save prompt changes?");
  assert.match(preview.message ?? "", /Review\n\nAfter/);
  assert.doesNotMatch(await readFile(path, "utf8"), /After/);
  api.ui.dialog.clear();
  preview.onConfirm?.();
  const input = await view("Agent fragments and default inheritance");
  assert.doesNotMatch(await readFile(path, "utf8"), /After/);
  input.onConfirm?.('{"review":{"append":["After"]}}');
  preview = await view("Save prompt changes?");
  changeDuring = "baseline";
  preview.onConfirm?.();
  api.ui.dialog.clear();
  assert.match(
    (await view("Prompt Composer")).message ?? "",
    /connection or project changed/,
  );
  assert.doesNotMatch(await readFile(path, "utf8"), /After/);
  changeDuring = undefined;
  Object.assign(api.state.path, { directory });
  alerts.length = 0;
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("edit");
  await view("Prompt settings source");
  choose(path);
  await view("Edit prompt settings");
  choose("agents");
  (await view("Agent fragments and default inheritance")).onConfirm?.(
    '{"review":{"append":["After"]}}',
  );
  preview = await view("Save prompt changes?");
  preview.onConfirm?.();
  preview.onConfirm?.();
  api.ui.dialog.clear();
  await view("Prompt settings saved");
  assert.deepEqual(alerts, []);
  assert.match(await readFile(path, "utf8"), /^\/\/ Keep comment/);
  assert.match(await readFile(path, "utf8"), /After/);
  assert.equal(config.agent!.review!.prompt, "Review");
  current = undefined;
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("apply");
  await view("Prompt settings applied");
  assert.equal(reloadReads, 3);
  assert.equal(config.agent!.review!.prompt, "Review\n\nAfter");
  // A connection change while reading the old baseline must not dispose it.
  changeDuring = "baseline";
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("apply");
  assert.match(
    (await view("Prompt Composer")).message ?? "",
    /instance changed/,
  );
  assert.equal(disposalCount, 1);
  Object.assign(api.state.path, { directory });
  current = undefined;

  // A connection change while receiving the new baseline must not report success.
  changeDuring = "refresh";
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("apply");
  assert.match(
    (await view("Prompt Composer")).message ?? "",
    /instance changed/,
  );
  assert.equal(disposalCount, 2);
  Object.assign(api.state.path, { directory });
  changeDuring = undefined;
  current = undefined;
  await rm(path);
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("preview");
  const stale = await view("Prompt Composer");
  assert.match(stale.message ?? "", /Prompt files changed/);
  assert.equal(config.agent!.review!.prompt, "Review\n\nAfter");
  const previousDisable = process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  t.after(() => {
    if (previousDisable === undefined) {
      delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
    } else {
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previousDisable;
    }
  });
  for (const value of ["1", "true"]) {
    await t.test(
      `project creation is unavailable when discovery is disabled by ${value}`,
      async () => {
        process.env.OPENCODE_DISABLE_PROJECT_CONFIG = value;
        config = structuredClone(authored);
        await hooks.config!(config);
        current = undefined;
        commands.get("prompt-composer.compose")!();
        await view("Compose prompts");
        choose("edit");
        const menu = await view("Prompt settings source");
        assert.equal(
          menu.options?.some((option) => option.value === "create"),
          false,
        );
        menu.onSelect?.({
          title: "Create project prompt settings",
          value: "create",
        });
        assert.match(
          (await view("Prompt Composer")).message ?? "",
          /discovery is disabled/,
        );
        await assert.rejects(readFile(path), { code: "ENOENT" });
      },
    );
  }
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  config = structuredClone(authored);
  await hooks.config!(config);
  current = undefined;
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("edit");
  assert.equal(
    (await view("Prompt settings source")).options?.some(
      (option) => option.value === "create",
    ),
    true,
  );
});
