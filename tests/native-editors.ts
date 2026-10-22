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
import {
  destroyFixedMenu,
  fixedMenuApi,
  fixedMenuView,
} from "./fixed-menu-harness.ts";

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
  authoredPath: string,
) {
  const { default: tui } = (await import(
    pathToFileURL(join(plugin, "dist/tui.js")).href
  )) as { default: TuiPluginModule };
  const path = await request("/path");
  const config = (await request("/config")) as {
    agent: Record<
      string,
      { name?: string; prompt?: string; disable?: boolean }
    >;
    command: Record<string, { template: string }>;
  };
  const nativeAgents = (await request("/agent")) as {
    name: string;
    native?: boolean;
    prompt?: string;
  }[];
  const configuredNames = new Set(
    Object.entries(config.agent).flatMap(([name, agent]) => [
      name,
      agent.name ?? name,
    ]),
  );
  const builtins = nativeAgents.filter(
    (agent) => agent.native === true && !configuredNames.has(agent.name),
  );
  assert.ok(builtins.length > 0, "Native host must expose built-in agents");
  assert.equal(
    nativeAgents.find((agent) => agent.name === "build")?.native,
    true,
    "Custom build fixture must override a native agent",
  );
  const saved = await readFile(authoredPath, "utf8");
  let open = () => {};
  let current: View | undefined;
  let rendered: unknown;
  let closed: (() => void) | undefined;
  let reads = 0;
  let agentReads = 0;
  const render = (view: View) => {
    current = view;
  };
  const api = {
    ...fixedMenuApi,
    state: { path },
    event: {
      on() {
        return () => {};
      },
    },
    lifecycle: { signal: new AbortController().signal, onDispose() {} },
    route: { current: { name: "home" } },
    keymap: {
      registerLayer(layer: {
        commands: { slashName: string; run: () => void }[];
      }) {
        assert.deepEqual(
          layer.commands.map((command) => command.slashName),
          ["view-prompts"],
        );
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
      app: {
        async agents() {
          agentReads++;
          return { data: await request("/agent") };
        },
      },
    },
    ui: {
      DialogSelect: render,
      DialogAlert: render,
      dialog: {
        replace(next: () => unknown, onClose?: () => void) {
          closed?.();
          closed = onClose;
          destroyFixedMenu(rendered);
          rendered = next();
          const fixed = fixedMenuView(rendered);
          if (fixed !== undefined) {
            render(fixed);
          }
        },
        clear() {
          closed?.();
          closed = undefined;
          destroyFixedMenu(rendered);
          rendered = undefined;
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
  async function preview(value: string, title: string, expected: string) {
    choose(value);
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
  }
  function hiddenBuiltins() {
    const options = current?.options;
    assert.ok(options !== undefined);
    for (const agent of builtins) {
      assert.ok(
        !options.some((item) => item.value === `agent:${agent.name}`),
        `Built-in ${agent.name} should be hidden`,
      );
    }
    assert.ok(
      options.some(
        (item) =>
          item.value === "\u0000builtins" &&
          item.title === "Show built-in agents",
      ),
    );
    assert.ok(
      options.some(
        (item) => item.value === "agent:build" && item.title === "Agent: build",
      ),
      "Configured build override stays visible without a built-in label",
    );
  }
  open();
  const categories = await view("View prompts");
  assert.deepEqual(categories.options, [
    { title: "Agents", value: "agents" },
    { title: "Commands", value: "commands" },
  ]);
  for (const [category, menuTitle, prefix, entries] of [
    [
      "agents",
      "Loaded agent prompts",
      "agent:",
      [
        ["agent:review", "Agent: review", config.agent.review.prompt],
        ["agent:build", "Agent: build", config.agent.build.prompt],
        [
          "agent:helper",
          `Agent: helper${config.agent.helper.disable === true ? " (disabled)" : ""}`,
          config.agent.helper.prompt,
        ],
      ],
    ],
    [
      "commands",
      "Loaded command templates",
      "command:",
      [["command:check", "Command: check", config.command.check.template]],
    ],
  ] as const) {
    choose(category);
    const menu = await view(menuTitle);
    assert.ok(
      menu.options!.every(
        (item) =>
          item.value === "\u0000back" ||
          (category === "agents" && item.value === "\u0000builtins") ||
          item.value.startsWith(prefix),
      ),
    );
    if (category === "agents") {
      hiddenBuiltins();
    }
    for (const [value, title, expected] of entries) {
      assert.equal(typeof expected, "string");
      await preview(value, title, expected!);
      await view(menuTitle);
    }
    if (category === "agents") {
      choose("\u0000builtins");
      const shown = await view(menuTitle);
      assert.ok(
        shown.options!.some(
          (item) =>
            item.value === "\u0000builtins" &&
            item.title === "Hide built-in agents",
        ),
      );
      for (const agent of builtins) {
        assert.ok(
          shown.options!.some((item) => item.value === `agent:${agent.name}`),
          `Built-in ${agent.name} should be visible`,
        );
      }
      const nativePrompt = builtins.find(
        (agent) => agent.prompt !== undefined && agent.prompt !== "",
      );
      assert.ok(
        nativePrompt !== undefined,
        "Native host must expose a built-in prompt",
      );
      await preview(
        `agent:${nativePrompt.name}`,
        `Agent: ${nativePrompt.name} (built-in)`,
        nativePrompt.prompt!,
      );
      await view(menuTitle);
      choose("\u0000builtins");
      await view(menuTitle);
      hiddenBuiltins();
      choose("\u0000builtins");
      await view(menuTitle);
    }
    choose("\u0000back");
    await view("View prompts");
  }
  api.ui.dialog.clear();
  await Promise.resolve();
  assert.equal(current, undefined);
  assert.equal(reads, 1);
  assert.equal(agentReads, 1);
  open();
  await view("View prompts");
  choose("agents");
  await view("Loaded agent prompts");
  hiddenBuiltins();
  choose("\u0000back");
  await view("View prompts");
  api.ui.dialog.clear();
  await Promise.resolve();
  assert.equal(current, undefined);
  assert.equal(reads, 2);
  assert.equal(agentReads, 2);
  assert.deepEqual(await request("/config"), config);
  assert.deepEqual(await request("/agent"), nativeAgents);
  assert.equal(await readFile(authoredPath, "utf8"), saved);
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
