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
  await mkdir(join(root, ".opencode"));
  const path = join(root, ".opencode/prompt-composer.jsonc");
  await writeFile(path, '// Keep comment\n{"agents":{}}');
  const authored: Config = {
    plugin: [packageName],
    agent: { review: { prompt: "Review" } },
  };
  const hooks = await server.server({
    directory: root,
    worktree: root,
  } as PluginInput);
  let config = structuredClone(authored);
  await hooks.config!(config);
  const commands = new Map<string, () => void>();
  let current: View | undefined;
  const render = (view: View) => {
    current = view;
  };
  const api = {
    state: { path: { directory: root, worktree: root } },
    lifecycle: { signal: new AbortController().signal, onDispose() {} },
    route: { current: { name: "home" } },
    keymap: {
      registerLayer(layer: { commands: { name: string; run: () => void }[] }) {
        for (const command of layer.commands) {
          commands.set(command.name, command.run);
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
          config = structuredClone(authored);
          await hooks.config!(config);
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
        replace(next: () => void) {
          next();
        },
        clear() {
          current = undefined;
        },
        get open() {
          return current !== undefined;
        },
      },
    },
  } as unknown as TuiPluginApi;
  await tui.tui(api, undefined, {} as TuiPluginMeta);
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
  const preview = await view("Save prompt changes?");
  assert.match(preview.message ?? "", /Review\n\nAfter/);
  assert.doesNotMatch(await readFile(path, "utf8"), /After/);
  preview.onConfirm?.();
  await view("Prompt settings saved");
  assert.match(await readFile(path, "utf8"), /^\/\/ Keep comment/);
  assert.match(await readFile(path, "utf8"), /After/);
  assert.equal(config.agent!.review!.prompt, "Review");
  commands.get("prompt-composer.apply")!();
  await view("Prompt settings applied");
  assert.equal(config.agent!.review!.prompt, "Review\n\nAfter");
});
