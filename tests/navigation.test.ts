import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  TuiDialogAlertProps,
  TuiDialogSelectProps,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui";
import { dialogNavigation } from "../src/navigation.ts";

type Dialog = TuiDialogSelectProps<string> | TuiDialogAlertProps;

function harness() {
  let current: Dialog | undefined;
  let closed: (() => void) | undefined;
  const controller = new AbortController();
  const render = (props: Dialog) => {
    current = props;
  };
  const api = {
    state: { path: { directory: "/project/nested", worktree: "/project" } },
    lifecycle: { signal: controller.signal },
    client: {},
    route: { current: { name: "session", params: { sessionID: "first" } } },
    ui: {
      DialogSelect: render,
      DialogAlert: render,
      dialog: {
        get open() {
          return current !== undefined;
        },
        replace: (next: () => void, onClose?: () => void) => {
          closed?.();
          closed = onClose;
          next();
        },
        // V1 invokes onClose before removing the current dialog.
        clear: () => {
          closed?.();
          closed = undefined;
          current = undefined;
        },
      },
    },
  } as unknown as TuiPluginApi;
  return {
    api,
    navigation: dialogNavigation(api),
    controller,
    get current() {
      return current;
    },
    async escape() {
      api.ui.dialog.clear();
      await Promise.resolve();
    },
  };
}

test("closing navigation clears every frame without restoring a parent", async () => {
  const view = harness();
  const nav = view.navigation;
  nav.menu({ title: "Workflow", options: [] }, true);
  nav.menu({ title: "Assignment", options: [] });
  nav.alert({ title: "Prompt", message: "Original assignment" });
  assert.equal(nav.canGoBack, true);
  nav.close();
  await Promise.resolve();
  assert.equal(view.current, undefined);
  assert.equal(nav.canGoBack, false);
  nav.menu({ title: "Workflow reopened", options: [] }, true);
  await view.escape();
  assert.equal(view.current, undefined);
});

test("nested menus offer Back and restore the parent's selection and live options", async () => {
  const view = harness();
  const nav = view.navigation;
  let title = "Before";
  nav.menu(
    {
      title: "Root",
      get options() {
        return [{ title, value: "item" }];
      },
      onSelect: () => nav.menu({ title: "Child", options: [] }),
    },
    true,
  );
  const root = view.current as TuiDialogSelectProps<string>;
  assert.equal(root.options.length, 1);
  root.onSelect!(root.options[0]);
  const child = view.current as TuiDialogSelectProps<string>;
  assert.equal(child.options.at(-1)?.title, "← Back");
  title = "After";
  child.onSelect!(child.options.at(-1)!);
  assert.equal(view.current?.title, "Root");
  assert.equal((view.current as TuiDialogSelectProps<string>).current, "item");
  assert.equal(
    (view.current as TuiDialogSelectProps<string>).options[0].title,
    "After",
  );
  await view.escape();
  assert.equal(view.current, undefined);
  assert.equal(nav.canGoBack, false);
});

test("closing a panel never resurrects parents after another dialog, route, client, or lifecycle takes over", async () => {
  for (const change of [
    "dialog",
    "route",
    "client",
    "directory",
    "worktree",
    "abort",
    "close",
  ] as const) {
    const view = harness();
    const nav = view.navigation;
    nav.menu({ title: "Root", options: [] }, true);
    nav.alert({ title: "Child", message: "Details" });
    view.api.ui.dialog.clear();
    if (change === "dialog") {
      view.api.ui.dialog.replace(() =>
        view.api.ui.DialogAlert({ title: "Other", message: "" }),
      );
    }
    if (change === "route" && view.api.route.current.name === "session") {
      view.api.route.current.params!.sessionID = "second";
    }
    if (change === "client") {
      Object.assign(view.api, { client: {} });
    }
    if (change === "directory" || change === "worktree") {
      view.api.state.path[change] = "/other";
    }
    if (change === "abort") {
      view.controller.abort();
    }
    if (change === "close") {
      nav.close();
    }
    await Promise.resolve();
    assert.equal(
      view.current?.title,
      change === "dialog" ? "Other" : undefined,
      change,
    );
    assert.equal(nav.canGoBack, false, change);
  }
});

test("retired picker callbacks cannot act after Back, Escape or connection replacement", async () => {
  const view = harness();
  const nav = view.navigation;
  let selected = 0;
  let moved = 0;
  nav.menu({ title: "Root", options: [] }, true);
  nav.menu({
    title: "Files",
    options: [{ title: "File", value: "file" }],
    onMove: () => moved++,
    onSelect: () => {
      selected++;
      nav.alert({ title: "Details", message: "File" });
    },
  });
  const retired = view.current as TuiDialogSelectProps<string>;
  retired.onSelect!(retired.options[0]);
  await view.escape();
  const restored = view.current as TuiDialogSelectProps<string>;
  retired.onMove!(retired.options[0]);
  retired.onSelect!(retired.options[0]);
  retired.onSelect!(retired.options.at(-1)!);
  assert.equal(selected, 1);
  assert.equal(moved, 0);
  assert.equal(view.current, restored);
  restored.onSelect!(restored.options[0]);
  assert.equal(selected, 2);
  await view.escape();
  const cancelled = view.current;
  await view.escape();
  await view.escape();
  cancelled.onSelect!(cancelled.options[0]);
  assert.equal(view.current, undefined);
  assert.equal(selected, 2);
  nav.menu(
    {
      title: "Connection",
      options: [{ title: "File", value: "file" }],
      onSelect: () => selected++,
    },
    true,
  );
  const disconnected = view.current as TuiDialogSelectProps<string>;
  Object.assign(view.api, { client: {} });
  disconnected.onSelect!(disconnected.options[0]);
  assert.equal(selected, 2);
});
