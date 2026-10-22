import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Config } from "@opencode-ai/plugin";
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import tui from "../src/tui.ts";

interface View {
  title: string;
  options?: { title: string; value: string }[];
  onSelect?: (item: { title: string; value: string }) => void;
  message?: string;
}

async function harness(config: Config = {}) {
  let current: View | undefined;
  let closed: (() => void) | undefined;
  let open = () => {};
  const commands: { name: string; slashName: string }[] = [];
  const reads: { directory: string; signal?: AbortSignal }[] = [];
  let read: () => Promise<{ data: Config; error?: unknown }> = () =>
    Promise.resolve({ data: config });
  const controller = new AbortController();
  const render = (view: View) => {
    current = view;
  };
  const api = {
    // This server path need not exist on the TUI machine.
    state: {
      path: {
        directory: "/remote/project/nested",
        worktree: "/remote/project",
      },
    },
    lifecycle: { signal: controller.signal, onDispose() {} },
    route: { current: { name: "home" } },
    keymap: {
      registerLayer(layer: {
        commands: { name: string; slashName: string; run: () => void }[];
      }) {
        commands.push(...layer.commands);
        open = layer.commands[0].run;
        return () => {};
      },
    },
    client: new Proxy(
      {
        config: {
          async get(
            input: { directory: string },
            options?: { signal?: AbortSignal },
          ) {
            reads.push({ ...input, signal: options?.signal });
            return read();
          },
        },
      },
      {
        get(target, property) {
          assert.equal(
            property,
            "config",
            `Unexpected client API: ${String(property)}`,
          );
          return target.config;
        },
      },
    ),
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
    // Allow deferred native command dispatch before checking a restored title.
    await setImmediate();
    for (let n = 0; n < 20 && current?.title !== title; n++) {
      await setImmediate();
    }
    assert.equal(current?.title, title, current?.message);
    return current;
  }
  function choose(value: string) {
    const option = current?.options?.find((item) => item.value === value);
    assert.ok(
      option !== undefined,
      `Missing ${value} in ${JSON.stringify(current)}`,
    );
    current?.onSelect?.(option);
  }
  return {
    api,
    controller,
    commands,
    reads,
    view,
    choose,
    open: () => open(),
    get current() {
      return current;
    },
    set read(fn: typeof read) {
      read = fn;
    },
    async escape() {
      api.ui.dialog.clear();
      await setImmediate();
    },
  };
}

test("viewer registers only view-prompts and preserves loaded text without executing syntax", async () => {
  const text =
    "Loaded {{include:unavailable.md}} $ARGUMENTS $1 !`touch never`\\\n";
  const config = {
    agent: { check: { prompt: text } },
    command: {
      check: { template: "Command $ARGUMENTS $1 !`touch never`\n" },
    },
  };
  const before = structuredClone(config);
  const h = await harness(config);
  assert.deepEqual(
    h.commands.map(({ name, slashName }) => ({ name, slashName })),
    [{ name: "prompt-composer.view-prompts", slashName: "view-prompts" }],
  );
  h.open();
  const categories = await h.view("View prompts");
  assert.deepEqual(categories.options, [
    { title: "Agents", value: "agents" },
    { title: "Commands", value: "commands" },
  ]);
  h.choose("agents");
  const menu = await h.view("Loaded agent prompts");
  assert.deepEqual(
    menu.options?.filter((item) => item.value !== "\u0000back"),
    [{ title: "Agent: check", value: "agent:check" }],
  );
  assert.equal(h.reads.length, 1);
  assert.equal(h.reads[0].directory, "/remote/project/nested");
  assert.equal(h.reads[0].signal, h.controller.signal);
  h.choose("agent:check");
  await h.view("Agent: check — pages");
  h.choose("0");
  assert.equal((await h.view("Agent: check — page 1/1")).message, text);
  await h.escape();
  await h.view("Agent: check — pages");
  h.choose("\u0000back");
  await h.view("Loaded agent prompts");
  await h.escape();
  await h.view("View prompts");
  h.choose("commands");
  const commands = await h.view("Loaded command templates");
  assert.deepEqual(
    commands.options?.filter((item) => item.value !== "\u0000back"),
    [{ title: "Command: check", value: "command:check" }],
  );
  h.choose("command:check");
  await h.view("Command: check — pages");
  h.choose("0");
  assert.equal(
    (await h.view("Command: check — page 1/1")).message,
    config.command.check.template,
  );
  await h.escape();
  h.choose("\u0000back");
  await h.escape();
  await h.escape();
  assert.equal(h.current, undefined);
  assert.equal(h.reads.length, 1);
  assert.deepEqual(config, before);
});

test("agent pages retain full Unicode text and label disabled and native fallback entries", async () => {
  const text = `${"🙂 long instruction\r\n\n".repeat(200)}{{include:literal.md}}\n`;
  const h = await harness({
    agent: {
      review: { prompt: text },
      off: { disable: true, prompt: "Inactive" },
      build: {},
      blank: { prompt: " \n\t" },
      empty: { prompt: "" },
    },
  });
  h.open();
  await h.view("View prompts");
  h.choose("agents");
  const menu = await h.view("Loaded agent prompts");
  assert.equal(
    menu.options!.find((item) => item.value === "agent:off")?.title,
    "Agent: off (disabled)",
  );
  for (const name of ["build", "blank", "empty"]) {
    const title = `Agent: ${name} (native fallback)`;
    assert.equal(
      menu.options!.find((item) => item.value === `agent:${name}`)?.title,
      title,
    );
    h.choose(`agent:${name}`);
    await h.view(`${title} — pages`);
    h.choose("0");
    assert.equal(
      (await h.view(`${title} — page 1/1`)).message,
      "(native fallback — no configured prompt text)",
    );
    await h.escape();
    h.choose("\u0000back");
  }
  h.choose("agent:review");
  const pages = (await h.view("Agent: review — pages")).options!.filter(
    (item) => item.value !== "\u0000back",
  );
  const parts: string[] = [];
  for (const [index, page] of pages.entries()) {
    h.choose(page.value);
    const body = (
      await h.view(`Agent: review — page ${index + 1}/${pages.length}`)
    ).message!;
    assert.ok(Array.from(body).length <= 240);
    assert.ok(body.split("\n").length <= 7);
    assert.ok(body.isWellFormed());
    parts.push(body);
    await h.escape();
  }
  assert.equal(parts.join(""), text);
});

test("empty categories retain both choices and show truthful empty states", async () => {
  for (const config of [
    {},
    { command: { check: { template: "Command only" } } },
    { agent: { check: { prompt: "Agent only" } } },
  ]) {
    const h = await harness(config);
    h.open();
    for (const [category, title, empty, entries] of [
      [
        "agents",
        "Loaded agent prompts",
        "No configured agent prompts",
        config.agent,
      ],
      [
        "commands",
        "Loaded command templates",
        "No configured command templates",
        config.command,
      ],
    ] as const) {
      await h.view("View prompts");
      h.choose(category);
      const menu = await h.view(title);
      if (entries === undefined) {
        assert.deepEqual(
          menu.options?.filter((item) => item.value !== "\u0000back"),
          [{ title: empty, value: "empty" }],
        );
        h.choose("empty");
        assert.equal(h.current, menu);
      }
      h.choose("\u0000back");
    }
    assert.equal(h.reads.length, 1);
  }
});

test("command pages preserve whitespace, Unicode, literal syntax and metadata", async () => {
  const text = `  $ARGUMENTS $1 !\`touch never\` {{include:literal.md}}\r\n${"🙂 instruction\n".repeat(200)} \t`;
  const config = {
    command: {
      review: {
        template: text,
        description: "Review changes",
        agent: "review",
        model: "fixture/model",
        subtask: true,
      },
      blank: { template: " \n\t" },
      empty: { template: "" },
    },
  };
  const before = structuredClone(config);
  const h = await harness(config);
  h.open();
  await h.view("View prompts");
  h.choose("commands");
  await h.view("Loaded command templates");
  for (const [name, command] of Object.entries(config.command)) {
    h.choose(`command:${name}`);
    const pages = (await h.view(`Command: ${name} — pages`)).options!.filter(
      (item) => item.value !== "\u0000back",
    );
    const parts: string[] = [];
    for (const [index, page] of pages.entries()) {
      h.choose(page.value);
      const body = (
        await h.view(`Command: ${name} — page ${index + 1}/${pages.length}`)
      ).message!;
      assert.ok(Array.from(body).length <= 240);
      assert.ok(body.split("\n").length <= 7);
      assert.ok(body.isWellFormed());
      parts.push(body);
      await h.escape();
    }
    assert.equal(
      parts.join(""),
      command.template === "" ? "(empty text)" : command.template,
    );
    h.choose("\u0000back");
    await h.view("Loaded command templates");
  }
  assert.deepEqual(config, before);
  assert.equal(h.reads.length, 1);
});

for (const change of [
  "close",
  "client",
  "directory",
  "worktree",
  "route",
  "dispose",
  "reopen",
] as const) {
  for (const fail of [false, true]) {
    test(`late ${fail ? "failure" : "success"} is ignored after ${change}`, async () => {
      const h = await harness();
      let finish = () => {};
      h.read = () =>
        new Promise((resolve, reject) => {
          finish = () =>
            fail
              ? reject(new Error("Disconnected"))
              : resolve({
                  data: { agent: { old: { prompt: "Old" } } },
                  error: undefined,
                });
        });
      h.open();
      await h.view("Loading prompts");
      await setImmediate();
      if (change === "close") {
        await h.escape();
      }
      if (change === "client") {
        Object.assign(h.api, { client: {} });
      }
      if (change === "directory") {
        Object.assign(h.api.state.path, { directory: "/other" });
      }
      if (change === "worktree") {
        Object.assign(h.api.state.path, { worktree: "/other" });
      }
      if (change === "route") {
        Object.assign(h.api.route, {
          current: { name: "session", params: { sessionID: "other" } },
        });
      }
      if (change === "dispose") {
        h.controller.abort();
      }
      if (change === "reopen") {
        h.read = () =>
          Promise.resolve({
            data: { agent: { new: { prompt: "New" } } },
            error: undefined,
          });
        h.open();
        await h.view("View prompts");
      }
      const before = h.current;
      finish();
      await setImmediate();
      assert.equal(h.current, before);
    });
  }
}

test("errors are displayed and reopening fetches the current loaded config", async () => {
  const h = await harness();
  h.read = () =>
    Promise.resolve({ data: {}, error: { message: "server error" } });
  h.open();
  assert.match(
    (await h.view("Prompt Composer")).message!,
    /Could not read loaded prompts/,
  );
  h.read = () =>
    Promise.resolve({
      data: { agent: { fresh: { prompt: "Fresh" } } },
      error: undefined,
    });
  h.open();
  await h.view("View prompts");
  h.choose("agents");
  assert.equal(
    (await h.view("Loaded agent prompts")).options?.[0].value,
    "agent:fresh",
  );
});

test("retired callbacks cannot reopen pages and Back rebinds active callbacks", async () => {
  const h = await harness({ agent: { check: { prompt: "Text" } } });
  h.open();
  await h.view("View prompts");
  h.choose("agents");
  const menu = await h.view("Loaded agent prompts");
  const item = menu.options![0];
  h.choose(item.value);
  const pages = await h.view("Agent: check — pages");
  menu.onSelect?.(item);
  await setImmediate();
  assert.equal(h.current, pages);
  h.choose("\u0000back");
  h.choose(item.value);
  await h.view("Agent: check — pages");
  await h.escape();
  await h.escape();
  await h.escape();
  menu.onSelect?.(item);
  await setImmediate();
  assert.equal(h.current, undefined);
});

for (const change of ["client", "directory", "worktree", "dispose"] as const) {
  test(`${change} change prevents browsing loaded text from the old context`, async () => {
    const h = await harness({ agent: { check: { prompt: "Text" } } });
    h.open();
    await h.view("View prompts");
    h.choose("agents");
    const menu = await h.view("Loaded agent prompts");
    if (change === "client") {
      Object.assign(h.api, { client: {} });
    }
    if (change === "directory") {
      Object.assign(h.api.state.path, { directory: "/other" });
    }
    if (change === "worktree") {
      Object.assign(h.api.state.path, { worktree: "/other" });
    }
    if (change === "dispose") {
      h.controller.abort();
    }
    h.choose("agent:check");
    await setImmediate();
    assert.equal(h.current, menu);
  });
}

test("native command dispatch can clear its picker before the viewer opens", async () => {
  const h = await harness({ agent: { check: { prompt: "Loaded" } } });
  h.open();
  // Native command handlers clear their picker after invoking the command.
  h.api.ui.dialog.clear();
  await h.view("View prompts");
  h.choose("agents");
  assert.equal(
    (await h.view("Loaded agent prompts")).options?.[0].value,
    "agent:check",
  );
});

test("retired category callbacks cannot switch categories and Back restores selection", async () => {
  const h = await harness({ command: { check: { template: "Text" } } });
  h.open();
  const root = await h.view("View prompts");
  h.choose("commands");
  const commands = await h.view("Loaded command templates");
  root.onSelect?.(root.options![0]);
  assert.equal(h.current, commands);
  h.choose("\u0000back");
  await h.view("View prompts");
  h.choose("agents");
  await h.view("Loaded agent prompts");
});
