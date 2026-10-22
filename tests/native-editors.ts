import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type {
  TuiPluginApi,
  TuiPluginMeta,
  TuiPluginModule,
} from "@opencode-ai/plugin/tui";

export type Request = (path: string, body?: unknown) => Promise<unknown>;
interface View {
  title: string;
  options?: { title: string; value: string }[];
  onSelect?: (item: { title: string; value: string }) => void;
  message?: string;
}

/** Installed viewer and native HTTP client; only terminal rendering is replaced. */
export async function exercisePromptViewer(
  plugin: string,
  request: Request,
  settingsPath: string,
) {
  const { default: tui } = (await import(
    pathToFileURL(join(plugin, "dist/tui.js")).href
  )) as { default: TuiPluginModule };
  const path = await request("/path");
  const config = (await request("/config")) as {
    agent: Record<string, { prompt?: string; disable?: boolean }>;
    command: Record<string, { template: string }>;
  };
  const saved = await readFile(settingsPath, "utf8");
  let open = () => {};
  let current: View | undefined;
  let closed: (() => void) | undefined;
  let reads = 0;
  const render = (view: View) => {
    current = view;
  };
  const api = {
    state: { path },
    lifecycle: { signal: new AbortController().signal, onDispose() {} },
    route: { current: { name: "home" } },
    keymap: {
      registerLayer(layer: { commands: { run: () => void }[] }) {
        open = layer.commands[0].run;
        return () => {};
      },
    },
    client: {
      config: {
        async get() {
          reads++;
          return { data: await request("/config") };
        },
      },
    },
    ui: {
      DialogSelect: render,
      DialogAlert: render,
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
  async function view(title: string) {
    for (
      let n = 0;
      n < 600 &&
      current?.title !== title &&
      current?.title !== "Prompt Composer";
      n++
    ) {
      await setTimeout(10);
    }
    assert.equal(
      current?.title,
      title,
      `${current?.message ?? ""} Host path: ${JSON.stringify(path)}`,
    );
    return current;
  }
  function choose(value: string) {
    const item = current?.options?.find((item) => item.value === value);
    assert.ok(
      item !== undefined,
      `Missing ${value} in ${JSON.stringify(current)}`,
    );
    current?.onSelect?.(item);
  }
  open();
  const menu = await view("Loaded prompts");
  assert.ok(
    menu.options!.every(
      (item) =>
        item.value.startsWith("agent:") || item.value.startsWith("command:"),
    ),
  );
  if (config.agent.helper.disable === true) {
    assert.equal(
      menu.options!.find((item) => item.value === "agent:helper")?.title,
      "Agent: helper (disabled)",
    );
  }
  for (const [value, title, expected] of [
    ["agent:review", "Agent: review", config.agent.review.prompt],
    ["command:check", "Command: check", config.command.check.template],
  ]) {
    choose(value!);
    const pages = (await view(`${title} — pages`)).options!.filter(
      (item) => item.value !== "\u0000back",
    );
    const text: string[] = [];
    for (const [index, page] of pages.entries()) {
      choose(page.value);
      text.push(
        (await view(`${title} — page ${index + 1}/${pages.length}`)).message!,
      );
      api.ui.dialog.clear();
      await view(`${title} — pages`);
    }
    assert.equal(text.join(""), expected);
    choose("\u0000back");
    await view("Loaded prompts");
  }
  api.ui.dialog.clear();
  await Promise.resolve();
  assert.equal(current, undefined);
  assert.equal(reads, 1);
  assert.deepEqual(await request("/config"), config);
  assert.equal(await readFile(settingsPath, "utf8"), saved);
}

/** Exercise the same full snapshot loader and revision-checked apply path as Config Composer's TUI. */
export async function exerciseConfigEditor(
  plugin: string,
  configRoot: string,
  request: Request,
) {
  const load = (name: string): Promise<unknown> =>
    import(pathToFileURL(join(plugin, "dist/config-composer", name)).href);
  const storage = (await load("storage.js")) as {
    loadSnapshot: (...args: unknown[]) => Promise<unknown>;
  };
  const baseline = (await load("composition/runtime-baseline.js")) as {
    readRuntimeBaseline: (...args: unknown[]) => unknown;
    readRuntimeRevision: (...args: unknown[]) => unknown;
  };
  const apply = (await load("composition/apply.js")) as {
    applySavedComposition: (
      snapshot: unknown,
      previous: unknown,
      port: {
        assertCurrent(): void;
        activity(): Promise<unknown>;
        dispose(): Promise<void>;
        refresh(): Promise<unknown>;
      },
    ) => Promise<unknown>;
  };
  const path = (await request("/path")) as {
    directory: string;
    worktree: string;
  };
  const location = {
    root:
      path.worktree === "/" || path.worktree === ""
        ? path.directory
        : path.worktree,
    directory: path.directory,
  };
  const config = await request("/config");
  const native = baseline.readRuntimeBaseline(config, location, configRoot);
  const snapshot = await storage.loadSnapshot(
    configRoot,
    location.root,
    native,
    path.directory,
    path.worktree,
  );
  await apply.applySavedComposition(
    snapshot,
    baseline.readRuntimeRevision(config, location, configRoot),
    {
      assertCurrent() {},
      activity: () => request("/session/status"),
      async dispose() {
        assert.equal(await request("/instance/dispose", {}), true);
      },
      async refresh() {
        const current = await request("/config");
        await Promise.all([request("/config/providers"), request("/agent")]);
        return baseline.readRuntimeRevision(current, location, configRoot);
      },
    },
  );
}
