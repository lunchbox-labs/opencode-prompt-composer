import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  destroyFixedMenu,
  fixedMenuApi,
  fixedMenuView,
} from "./fixed-menu-harness.ts";
import { createFixedMenu } from "../src/fixed-menu.ts";
import { SelectRenderable } from "./fixed-menu-runtime.ts";

test("fixed menus preserve the current choice and deliver moves and selection", async () => {
  const controller = new AbortController();
  const api = {
    ...fixedMenuApi,
    lifecycle: { signal: controller.signal },
  } as unknown as TuiPluginApi;
  const render = await createFixedMenu(api);
  const moves: string[] = [];
  const choices: string[] = [];
  const element = render({
    title: "View prompts",
    current: "commands",
    options: [
      { title: "Agents", value: "agents" },
      { title: "Commands", value: "commands" },
    ],
    onMove: (item) => moves.push(item.value),
    onSelect: (item) => choices.push(item.value),
  });
  const view = fixedMenuView(element)!;
  assert.equal(view.title, "View prompts");
  assert.equal(view.current, "commands");
  assert.equal(view.renderFilter, false);
  view.onMove!(view.options[0]);
  assert.deepEqual(moves, ["agents"]);
  view.onSelect!(view.options[1]);
  assert.deepEqual(choices, ["commands"]);
  destroyFixedMenu(element);
  view.onSelect!(view.options[0]);
  assert.deepEqual(choices, ["commands"]);
});

test("aborting the plugin disposes a fixed menu's event handlers", async () => {
  const controller = new AbortController();
  const api = {
    ...fixedMenuApi,
    lifecycle: { signal: controller.signal },
  } as unknown as TuiPluginApi;
  const render = await createFixedMenu(api);
  let calls = 0;
  const element = render({
    title: "View prompts",
    options: [
      {
        title: "Retry viewing prompts",
        value: "retry",
        description: "Unable to connect",
      },
    ],
    onSelect: () => calls++,
  });
  const view = fixedMenuView(element)!;
  assert.equal(view.options[0].description, "Unable to connect");
  controller.abort();
  view.onSelect!(view.options[0]);
  assert.equal(calls, 0);
});

test("restored fixed menus focus after the host restores its previous input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let focused = "previous dialog";
  t.mock.method(SelectRenderable.prototype, "focus", () => {
    focused = "fixed menu";
  });
  const api = {
    ...fixedMenuApi,
    lifecycle: { signal: new AbortController().signal },
  } as unknown as TuiPluginApi;
  const render = await createFixedMenu(api);
  // The host schedules this before navigation restores its parent in a microtask.
  setTimeout(() => {
    focused = "main prompt";
  }, 1);
  const element = render({
    title: "View prompts",
    options: [{ title: "Agents", value: "agents" }],
  });
  t.mock.timers.tick(1);
  assert.equal(focused, "fixed menu");
  destroyFixedMenu(element);
});

test("a fixed menu disposed before its focus timer cannot steal focus", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const focus = t.mock.method(SelectRenderable.prototype, "focus");
  const controller = new AbortController();
  const api = {
    ...fixedMenuApi,
    lifecycle: { signal: controller.signal },
  } as unknown as TuiPluginApi;
  const render = await createFixedMenu(api);
  for (const dispose of [destroyFixedMenu, () => controller.abort()]) {
    const element = render({
      title: "View prompts",
      options: [{ title: "Agents", value: "agents" }],
    });
    dispose(element);
    t.mock.timers.tick(1);
  }
  assert.equal(focus.mock.callCount(), 0);
});
