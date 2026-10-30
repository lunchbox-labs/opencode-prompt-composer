import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import tui from "../src/tui.ts";
import { fixedMenuApi, fixedMenuView } from "./fixed-menu-harness.ts";

interface View {
  title: string;
  options?: { title: string; value: string }[];
  onSelect?: (item: { title: string; value: string }) => void;
}

test("the built-in agent toggle is remembered through api.kv", async () => {
  const stored = new Map<string, unknown>();
  let current: View | undefined;
  let open = () => {};
  const render = (view: View) => {
    current = view;
  };
  const api = {
    ...fixedMenuApi,
    state: { path: { directory: "/project", worktree: "/project" } },
    event: { on: () => () => {} },
    lifecycle: { signal: new AbortController().signal, onDispose() {} },
    route: { current: { name: "home" } },
    keymap: {
      registerLayer(layer: { commands: { run: () => void }[] }) {
        open = layer.commands[0].run;
        return () => {};
      },
    },
    kv: {
      get: (key: string) => stored.get(key),
      set(key: string, value: unknown) {
        stored.set(key, value);
      },
    },
    client: {
      app: {
        agents: async () => ({
          data: [{ name: "explore", native: true, prompt: "Native" }],
        }),
      },
      config: { get: async () => ({ data: {} }) },
    },
    ui: {
      DialogSelect: render,
      DialogAlert: render,
      dialog: {
        replace(next: () => unknown) {
          const fixed = fixedMenuView(next());
          if (fixed !== undefined) {
            current = fixed;
          }
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
  const view = async (title: string) => {
    for (let n = 0; n < 20 && current?.title !== title; n++) {
      await setImmediate();
    }
    assert.equal(current?.title, title);
    return current;
  };
  const choose = (value: string) => {
    const option = current?.options?.find((item) => item.value === value);
    assert.ok(option !== undefined, value);
    current?.onSelect?.(option);
  };
  const values = async () => {
    const menu = await view("Loaded agent prompts");
    return menu?.options?.map((item) => item.value) ?? [];
  };
  open();
  await view("View prompts");
  choose("agents");
  assert.ok(!(await values()).includes("agent:explore"));
  choose("\u0000builtins");
  assert.ok((await values()).includes("agent:explore"));
  assert.equal(stored.get("prompt-composer.showBuiltins"), true);
  open();
  await view("View prompts");
  choose("agents");
  assert.ok((await values()).includes("agent:explore"));
  choose("\u0000builtins");
  assert.ok(!(await values()).includes("agent:explore"));
  assert.equal(stored.get("prompt-composer.showBuiltins"), false);
});
