import assert from "node:assert/strict";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { type TestContext, test } from "node:test";
import type { Config, PluginInput } from "@opencode-ai/plugin";
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import server from "../src/server.ts";
import tui from "../src/tui.ts";
import { packageName } from "../src/registration.ts";

interface View {
  title: string;
  message?: string;
  options?: { title: string; value: string; description?: string }[];
  onSelect?: (item: { title: string; value: string }) => void;
}

async function harness(t: TestContext, native: Config) {
  const root = await mkdtemp(join(tmpdir(), "prompt-preview-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".opencode/prompts"), { recursive: true });
  const fragment = join(root, ".opencode/prompts/end.md");
  await writeFile(fragment, "Final checklist.");
  const hooks = await server.server({
    directory: root,
    worktree: root,
  } as PluginInput);
  const config = { ...structuredClone(native), plugin: [packageName] };
  await hooks.config!(config);
  let current: View | undefined;
  let closed: (() => void) | undefined;
  let open = () => {};
  let beforeRead = async () => {};
  const controller = new AbortController();
  const render = (view: View) => {
    current = view;
  };
  const api = {
    state: { path: { directory: root, worktree: root } },
    lifecycle: { signal: controller.signal, onDispose() {} },
    route: { current: { name: "home" } },
    keymap: {
      registerLayer(layer: { commands: { run: () => void }[] }) {
        open = layer.commands[0].run;
        return () => {};
      },
    },
    client: {
      file: {
        async read(input: { directory: string; path: string }) {
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
          await beforeRead();
          return { data: structuredClone(config) };
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
    for (let n = 0; n < 100 && current?.title !== title; n++) {
      await setTimeout(5);
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
    config,
    root,
    fragment,
    controller,
    view,
    choose,
    get current() {
      return current;
    },
    set beforeRead(fn: () => Promise<void>) {
      beforeRead = fn;
    },
    async open() {
      open();
      await view("Compose prompts");
    },
    async escape() {
      api.ui.dialog.clear();
      await Promise.resolve();
    },
  };
}

test("command-only Preview exposes complete literal composed templates without invoking them", async (t) => {
  const h = await harness(t, {
    command: {
      check: {
        template:
          "{{include:end.md}} $ARGUMENTS $1 !`touch never` \\{{include:literal.md}}",
      },
    },
  });
  await h.open();
  h.choose("preview");
  const chooser = await h.view("Effective prompts");
  assert.ok(
    chooser.options?.some((item) => item.title === "Command: check") === true,
  );
  h.choose("command:check");
  await h.view("Command: check — pages");
  h.choose("0");
  assert.equal(
    (await h.view("Command: check — page 1/1")).message,
    "Final checklist. $ARGUMENTS $1 !`touch never` {{include:literal.md}}",
  );
  await h.escape();
  await h.view("Command: check — pages");
  h.choose("\u0000back");
  await h.view("Effective prompts");
  h.choose("\u0000back");
  await h.view("Compose prompts");
  await h.escape();
  assert.equal(h.current, undefined);
  await h.open();
  h.choose("preview");
  await h.view("Effective prompts");
});

test("agent pages cover long, multiline and Unicode text exactly and label inactive/native entries", async (t) => {
  const prompt = `${"🙂 long instruction\n\n".repeat(200)}{{include:end.md}}`;
  const h = await harness(t, {
    agent: {
      review: { prompt },
      off: { disable: true, prompt: "Inactive" },
      build: {},
      blank: { prompt: "   " },
    },
  });
  await h.open();
  h.choose("preview");
  const chooser = await h.view("Effective prompts");
  assert.match(
    chooser.options!.find((item) => item.value === "agent:off")!.title,
    /disabled/,
  );
  for (const name of ["build", "blank"]) {
    assert.match(
      chooser.options!.find((item) => item.value === `agent:${name}`)!.title,
      /native fallback/,
    );
  }
  h.choose("agent:review");
  const menu = await h.view("Agent: review — pages");
  const pages = menu.options!.filter((item) => item.value !== "\u0000back");
  assert.ok(pages.length > 1);
  const text: string[] = [];
  for (const [index, page] of pages.entries()) {
    h.choose(page.value);
    const body = (
      await h.view(`Agent: review — page ${index + 1}/${pages.length}`)
    ).message!;
    assert.ok(Array.from(body).length <= 240);
    assert.ok(body.split("\n").length <= 7);
    assert.equal(body.isWellFormed(), true);
    text.push(body);
    await h.escape();
    await h.view("Agent: review — pages");
  }
  assert.equal(
    text.join(""),
    prompt.replace("{{include:end.md}}", "Final checklist."),
  );
});

test("Preview rejects stale inputs and connection changes, and does not reopen after cancellation", async (t) => {
  const h = await harness(t, {
    command: { check: { template: "{{include:end.md}}" } },
  });
  await h.open();
  let release = () => {};
  let started = () => {};
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.beforeRead = () => {
    started();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  h.choose("preview");
  await reading;
  await h.escape();
  release();
  await setTimeout(30);
  assert.equal(h.current, undefined);
  h.beforeRead = async () => {};
  await h.open();
  h.choose("preview");
  await h.view("Effective prompts");
  Object.assign(h.api.state.path, {
    directory: `${h.api.state.path.directory}/other`,
  });
  h.choose("command:check");
  assert.match(
    (await h.view("Prompt Composer")).message!,
    /connection or project changed/,
  );
  Object.assign(h.api.state.path, { directory: h.api.state.path.worktree });
  await writeFile(h.fragment, "Changed");
  await h.open();
  h.choose("preview");
  assert.match(
    (await h.view("Prompt Composer")).message!,
    /Prompt files changed/,
  );
});

test("repeated Preview actions and retired chooser callbacks cannot stack or reopen dialogs", async (t) => {
  const h = await harness(t, { command: { check: { template: "Text" } } });
  await h.open();
  h.choose("preview");
  h.choose("preview");
  const chooser = await h.view("Effective prompts");
  const command = chooser.options!.find(
    (item) => item.value === "command:check",
  )!;
  h.choose("command:check");
  await h.view("Command: check — pages");
  // A callback retained by a retired view must not push a second page list.
  chooser.onSelect?.(command);
  h.choose("0");
  await h.view("Command: check — page 1/1");
  await h.escape();
  await h.view("Command: check — pages");
  await h.escape();
  await h.view("Effective prompts");
  await h.escape();
  await h.view("Compose prompts");
  await h.escape();
  chooser.onSelect?.(command);
  await setTimeout(30);
  assert.equal(h.current, undefined);
});

test("a changed client or disposed plugin prevents browsing an old preview", async (t) => {
  for (const change of ["client", "dispose"] as const) {
    const h = await harness(t, { command: { check: { template: "Text" } } });
    await h.open();
    h.choose("preview");
    await h.view("Effective prompts");
    if (change === "client") {
      Object.assign(h.api, { client: {} });
    } else {
      h.controller.abort();
    }
    h.choose("command:check");
    await setTimeout(30);
    assert.equal(h.current?.title, "Effective prompts");
    await h.escape();
    assert.equal(h.current, undefined);
  }
});

test("a failed load after Preview is cancelled does not resurrect an error dialog", async (t) => {
  const h = await harness(t, {});
  await h.open();
  let reject = (_error: Error) => {};
  let started = () => {};
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  h.beforeRead = () => {
    started();
    return new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
  };
  h.choose("preview");
  await reading;
  await h.escape();
  reject(new Error("Disconnected"));
  await setTimeout(30);
  assert.equal(h.current, undefined);
});

test("page boundaries retain empty text, long lines, CRLF and trailing newlines", async () => {
  const { previewPages } = await import("../src/preview.ts");
  for (const text of [
    "",
    "x".repeat(240),
    "x".repeat(241),
    "\r\n".repeat(60),
    `${"🙂".repeat(239)}$ARGUMENTS\\{{include:literal.md}}\n`,
  ]) {
    const pages = previewPages(text);
    assert.ok(pages.length >= 1);
    assert.equal(pages.join(""), text);
    for (const page of pages) {
      assert.ok(Array.from(page).length <= 240);
      assert.ok(page.split("\n").length <= 7);
      assert.equal(page.isWellFormed(), true);
    }
  }
});

test("saved preview composes changed settings and snippets without applying or writing", async (t) => {
  const h = await harness(t, {
    agent: { review: { prompt: "{{include:end.md}}" } },
    command: { check: { template: "{{include:end.md}} $ARGUMENTS" } },
  });
  const running = structuredClone(h.config);
  await writeFile(h.fragment, "Saved checklist.");
  const settings = join(h.root, ".opencode/prompt-composer.jsonc");
  const text =
    '{"agents":{"review":{"append":["Saved rule."]},"missing":{"append":["Notice"]}}}';
  await writeFile(settings, text);
  const writes: string[] = [];
  const watcher = watch(h.root, (_event, filename) =>
    writes.push(String(filename)),
  );
  t.after(() => watcher.close());
  await h.open();
  h.choose("saved-preview");
  h.choose("saved-preview");
  await h.view("Saved prompt changes — not applied");
  for (const [value, title, expected] of [
    ["agent:review", "Agent: review", "Saved checklist.\n\nSaved rule."],
    ["command:check", "Command: check", "Saved checklist. $ARGUMENTS"],
  ]) {
    h.choose(value);
    await h.view(`${title} — not applied — pages`);
    h.choose("0");
    assert.equal(
      (await h.view(`${title} — not applied — page 1/1`)).message,
      expected,
    );
    await h.escape();
    await h.view(`${title} — not applied — pages`);
    h.choose("\u0000back");
    await h.view("Saved prompt changes — not applied");
  }
  h.choose("notices");
  await h.view("Composition notices — not applied — pages");
  h.choose("0");
  assert.match(
    (await h.view("Composition notices — not applied — page 1/1")).message!,
    /missing/,
  );
  assert.deepEqual(h.config, running);
  assert.equal(await readFile(settings, "utf8"), text);
  assert.equal(await readFile(h.fragment, "utf8"), "Saved checklist.");
  assert.deepEqual(writes, []);
  watcher.close();
  await h.open();
  h.choose("edit");
  assert.match(
    (await h.view("Prompt Composer")).message!,
    /Prompt files changed/,
  );
});

test("saved preview cancellation suppresses late success and errors", async (t) => {
  for (const fail of [false, true]) {
    const h = await harness(t, {});
    let finish = () => {};
    let started = () => {};
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    h.beforeRead = () => {
      started();
      return new Promise<void>((resolve, reject) => {
        finish = () => (fail ? reject(new Error("Disconnected")) : resolve());
      });
    };
    await h.open();
    h.choose("saved-preview");
    await reading;
    await h.escape();
    h.beforeRead = async () => {};
    finish();
    await setTimeout(30);
    assert.equal(h.current, undefined);
  }
});

test("saved preview refuses mismatched server source text", async (t) => {
  const h = await harness(t, {
    command: { check: { template: "{{include:end.md}}" } },
  });
  Object.assign(h.api.client.file, {
    read: async () => ({ data: { type: "text", content: "Other server" } }),
  });
  await h.open();
  h.choose("saved-preview");
  assert.match(
    (await h.view("Prompt Composer")).message!,
    /do not match this OpenCode server/,
  );
});

test("saved preview rejects malformed inputs, raced reads, inventory and baseline changes", async (t) => {
  for (const failure of [
    "malformed",
    "read",
    "inventory",
    "baseline",
    "connection",
  ] as const) {
    const h = await harness(t, {
      command: { check: { template: "{{include:end.md}}" } },
    });
    const running = structuredClone(h.config);
    if (failure === "malformed") {
      await writeFile(join(h.root, ".opencode/prompt-composer.jsonc"), "{");
    } else {
      let reads = 0;
      h.beforeRead = async () => {
        if (++reads !== 2) {
          return;
        }
        if (failure === "read") {
          await writeFile(h.fragment, "Raced");
        }
        if (failure === "inventory") {
          await writeFile(join(h.root, ".opencode/prompts/new.md"), "New");
        }
        if (failure === "baseline") {
          h.config.command!.check.template = "Changed native state";
        }
        if (failure === "connection") {
          Object.assign(h.api.state.path, { directory: `${h.root}/other` });
        }
      };
    }
    await h.open();
    h.choose("saved-preview");
    const error = await h.view("Prompt Composer");
    assert.match(
      error.message!,
      /Invalid prompt settings|input changed|discovery changed|Native prompt state changed|connection or project changed/,
    );
    if (failure !== "baseline") {
      assert.deepEqual(h.config, running);
    }
  }
});
