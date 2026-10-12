import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  onConfirm?: (text?: string) => void;
  message?: string;
}

/** Real installed TUI actions and native HTTP client; only terminal rendering is replaced. */
export async function exercisePromptEditor(
  plugin: string,
  request: Request,
  settingsPath: string,
) {
  const { default: tui } = (await import(
    pathToFileURL(join(plugin, "dist/tui.js")).href
  )) as { default: TuiPluginModule };
  const path = await request("/path");
  const commands = new Map<string, () => void>();
  let current: View | undefined;
  let closed: (() => void) | undefined;
  const render = (view: View) => {
    current = view;
  };
  const api = {
    state: { path },
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
        async read(input: { path: string }) {
          return {
            data: await request(
              `/file/content?path=${encodeURIComponent(input.path)}`,
            ),
          };
        },
      },
      config: {
        async get() {
          return { data: await request("/config") };
        },
      },
      session: {
        async status() {
          return { data: await request("/session/status") };
        },
      },
      instance: {
        async dispose() {
          return { data: await request("/instance/dispose", {}) };
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
      `${current?.message ?? ""}\nHost path: ${JSON.stringify(path)}\nRuntime: ${current?.title === "Prompt Composer" ? JSON.stringify(await request("/config")) : ""}`,
    );
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
  choose(settingsPath);
  await view("Edit prompt settings");
  choose("agents");
  (await view("Agent fragments and default inheritance")).onConfirm?.(
    '{"review":{"append":["Editor verified."]}}',
  );
  const preview = await view("Save prompt changes?");
  assert.match(preview.message ?? "", /Editor verified/);
  preview.onConfirm?.();
  api.ui.dialog.clear();
  await view("Prompt settings saved");
  const saved = await readFile(settingsPath, "utf8");
  assert.match(saved, /Editor verified/);
  const running = await request("/config");
  const snippetPath = join(dirname(settingsPath), "prompts/review/body.md");
  const snippet = await readFile(snippetPath, "utf8");
  const changedSnippet = `  ${snippet}\nSAVED SNIPPET\n\n`;
  await writeFile(snippetPath, changedSnippet);
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("saved-preview");
  choose("saved-preview");
  await view("Saved prompt changes — not applied");
  choose("agent:review");
  const savedPages = await view("Agent: review — not applied — pages");
  const savedText: string[] = [];
  const pages = savedPages.options!.filter(
    (item) => item.value !== "\u0000back",
  );
  for (const [index, page] of pages.entries()) {
    choose(page.value);
    savedText.push(
      (
        await view(
          `Agent: review — not applied — page ${index + 1}/${pages.length}`,
        )
      ).message!,
    );
    api.ui.dialog.clear();
    await view("Agent: review — not applied — pages");
  }
  assert.match(savedText.join(""), /Editor verified/);
  assert.match(savedText.join(""), /SAVED SNIPPET\n\n/);
  choose("\u0000back");
  await view("Saved prompt changes — not applied");
  choose("\u0000back");
  await view("Compose prompts");
  api.ui.dialog.clear();
  assert.deepEqual(await request("/config"), running);
  assert.equal(await readFile(settingsPath, "utf8"), saved);
  assert.equal(await readFile(snippetPath, "utf8"), changedSnippet);
  await writeFile(snippetPath, snippet);
  current = undefined;
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("apply");
  await view("Prompt settings applied");
  const config = (await request("/config")) as {
    agent: Record<string, { prompt?: string }>;
    command: Record<string, { template: string }>;
  };
  assert.match(config.agent.review.prompt ?? "", /Editor verified/);
  commands.get("prompt-composer.compose")!();
  await view("Compose prompts");
  choose("preview");
  await view("Effective prompts");
  for (const [value, title, expected] of [
    ["agent:review", "Agent: review", config.agent.review.prompt],
    ["command:check", "Command: check", config.command.check.template],
  ]) {
    choose(value!);
    const menu = await view(`${title} — pages`);
    const pages = menu.options!.filter((item) => item.value !== "\u0000back");
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
    await view("Effective prompts");
  }
  choose("\u0000back");
  await view("Compose prompts");
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
