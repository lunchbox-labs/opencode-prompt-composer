import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import {
  destroyFixedMenu,
  fixedMenuApi,
  textViewerView,
} from "./fixed-menu-harness.ts";
import { createTextViewer } from "../src/text-viewer.ts";
import { BoxRenderable, ScrollBoxRenderable } from "./fixed-menu-runtime.ts";

function viewerApi(signal = new AbortController().signal) {
  const renderer = Object.assign(new EventEmitter(), { height: 40 });
  const layers = new Set<{ target?: unknown; targetMode?: string }>();
  const api = {
    ...fixedMenuApi,
    renderer,
    lifecycle: { signal },
    keymap: {
      registerLayer(layer: { target?: unknown; targetMode?: string }) {
        layers.add(layer);
        return () => layers.delete(layer);
      },
    },
  } as unknown as TuiPluginApi;
  return { api, renderer, layers };
}

function parts(element: unknown) {
  assert.ok(element instanceof BoxRenderable);
  const scroll = element
    .getChildren()
    .find((child) => child instanceof ScrollBoxRenderable);
  const body = scroll?.getChildren()[0];
  assert.ok(scroll !== undefined && body !== undefined);
  return { scroll, body };
}

test("viewers fit short text and keep long text within the resized terminal", async () => {
  const { api, renderer, layers } = viewerApi();
  const render = await createTextViewer(api);
  const element = render({ title: "Agent: review", text: "Short\ntext" });
  assert.deepEqual(textViewerView(element), {
    title: "Agent: review",
    message: "Short\ntext",
  });
  const { scroll, body } = parts(element);
  // Paging keys apply to this viewer only while its scroll box has focus.
  assert.deepEqual(
    Array.from(layers, ({ target, targetMode }) => ({ target, targetMode })),
    [{ target: scroll, targetMode: "focus" }],
  );
  // Layout reports the wrapped height of the text.
  const wrap = (rows: number) => {
    body.height = rows;
    body.onSizeChange?.();
    return scroll.height;
  };
  const resize = (rows: number) => {
    renderer.height = rows;
    renderer.emit("resize", 120, rows);
    return scroll.height;
  };
  assert.equal(wrap(3), 3);
  const tall = wrap(500);
  assert.ok(tall > 3 && tall < 30);
  const resized = resize(20);
  assert.ok(resized >= 1 && resized < tall);
  destroyFixedMenu(element);
  assert.equal(resize(60), resized);
  assert.equal(renderer.listenerCount("resize"), 0);
  assert.equal(layers.size, 0);
});

test("restored viewers take focus after the host restores its previous input", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let focused = "previous dialog";
  t.mock.method(ScrollBoxRenderable.prototype, "focus", () => {
    focused = "viewer";
  });
  const { api } = viewerApi();
  const render = await createTextViewer(api);
  // The host schedules this before navigation restores its parent in a microtask.
  setTimeout(() => {
    focused = "main prompt";
  }, 1);
  const element = render({ title: "Command: check", text: "Check" });
  t.mock.timers.tick(1);
  assert.equal(focused, "viewer");
  destroyFixedMenu(element);
});

test("disposed viewers cannot take focus, follow resizes or keep key bindings", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const focus = t.mock.method(ScrollBoxRenderable.prototype, "focus");
  const controller = new AbortController();
  const { api, renderer, layers } = viewerApi(controller.signal);
  const render = await createTextViewer(api);
  for (const dispose of [destroyFixedMenu, () => controller.abort()]) {
    const element = render({ title: "Command: check", text: "Check" });
    assert.equal(renderer.listenerCount("resize"), 1);
    assert.equal(layers.size, 1);
    dispose(element);
    t.mock.timers.tick(1);
    assert.equal(renderer.listenerCount("resize"), 0);
    assert.equal(layers.size, 0);
  }
  assert.equal(focus.mock.callCount(), 0);
});
