import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import type { Config } from "@opencode-ai/plugin";
import type {
  TuiPluginApi,
  TuiPluginMeta,
  TuiToast,
} from "@opencode-ai/plugin/tui";
import tui from "../src/tui.ts";

interface View {
  title: string;
  message?: string;
  options?: { title: string; value: string }[];
  onSelect?: (item: { title: string; value: string }) => void;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function harness() {
  let current: View | undefined;
  let closed: (() => void) | undefined;
  const calls: { method: string; directory?: string; signal?: AbortSignal }[] =
    [];
  const toasts: TuiToast[] = [];
  const commands = new Map<string, () => void>();
  const listeners = new Set<
    (event: { properties: { directory: string } }) => void
  >();
  const controller = new AbortController();
  let status: () => Promise<{
    data?: Record<string, { type: string }>;
    error?: unknown;
  }> = () => Promise.resolve({ data: {} });
  let dispose: () => Promise<{ data?: unknown; error?: unknown }> = () =>
    Promise.resolve({ data: true });
  let read: () => Promise<{ data?: Config; error?: unknown }> = () =>
    Promise.resolve({ data: {} });
  const render = (view: View) => {
    current = view;
  };
  const api = {
    state: {
      path: { directory: "/remote/project", worktree: "/remote/project" },
    },
    lifecycle: { signal: controller.signal, onDispose() {} },
    route: { current: { name: "home" } },
    event: {
      on(
        type: string,
        listener: (event: { properties: { directory: string } }) => void,
      ) {
        assert.equal(type, "server.instance.disposed");
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    keymap: {
      registerLayer(layer: {
        commands: { slashName: string; run: () => void }[];
      }) {
        for (const command of layer.commands) {
          commands.set(command.slashName, command.run);
        }
        return () => {};
      },
    },
    client: {
      session: {
        async status(
          input: { directory: string },
          options: { signal: AbortSignal },
        ) {
          calls.push({ method: "status", ...input, ...options });
          return status();
        },
      },
      instance: {
        async dispose(
          input: { directory: string },
          options: { signal: AbortSignal },
        ) {
          calls.push({ method: "dispose", ...input, ...options });
          assert.equal(
            listeners.size,
            2,
            "Wait for teardown before sending disposal",
          );
          return dispose();
        },
      },
      config: {
        async get(
          input: { directory: string },
          options: { signal: AbortSignal },
        ) {
          calls.push({ method: "config", ...input, ...options });
          return read();
        },
      },
    },
    ui: {
      toast(input: TuiToast) {
        toasts.push(input);
      },
      DialogAlert: render,
      DialogSelect: render,
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
  return {
    api,
    controller,
    calls,
    toasts,
    commands,
    listeners,
    get current() {
      return current;
    },
    set status(fn: typeof status) {
      status = fn;
    },
    set dispose(fn: typeof dispose) {
      dispose = fn;
    },
    set read(fn: typeof read) {
      read = fn;
    },
    run(name = "reload-prompts") {
      const run = commands.get(name);
      assert.ok(run !== undefined, `Missing /${name}`);
      run();
      // Native command dispatch clears the command picker synchronously.
      api.ui.dialog.clear();
    },
    choose(value: string) {
      const option = current?.options?.find((item) => item.value === value);
      assert.ok(
        option !== undefined,
        `Missing ${value} in ${JSON.stringify(current)}`,
      );
      current?.onSelect?.(option);
    },
    disposed(directory = "/remote/project") {
      for (const listener of listeners) {
        listener({ properties: { directory } });
      }
    },
    async view(title: string) {
      for (let i = 0; i < 20; i++) {
        await setImmediate();
        if (current?.title === title) {
          return current;
        }
      }
      assert.fail(`Expected ${title}, got ${JSON.stringify(current)}`);
    },
  };
}

test("slash reload requires idle sessions, observes teardown and reads the refreshed instance", async () => {
  const h = await harness();
  h.run();
  await h.view("Reloading prompts");
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ["status", "dispose"],
  );
  h.disposed("/other");
  await setImmediate();
  assert.equal(
    h.calls.length,
    2,
    "HTTP acknowledgement and unrelated events cannot complete reload",
  );
  h.disposed();
  const result = await h.view("Prompt reload");
  assert.match(result.message!, /Instance reloaded/);
  assert.match(result.message!, /composition errors/i);
  assert.match(result.message!, /JSON.*restart/i);
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ["status", "dispose", "config"],
  );
  assert.ok(
    h.calls.every(
      (call) =>
        call.directory === "/remote/project" && call.signal !== undefined,
    ),
  );
  assert.equal(h.listeners.size, 1);
});

test("root menu reload remains available after a failed preview read", async () => {
  const h = await harness();
  h.read = () => Promise.reject(new Error("Unavailable"));
  h.run("view-prompts");
  await h.view("View prompts");
  h.choose("reload");
  await h.view("Reloading prompts");
  h.read = () => Promise.resolve({ data: {}, error: undefined });
  h.disposed();
  await h.view("Prompt reload");
  assert.equal(h.calls.filter((call) => call.method === "dispose").length, 1);
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].variant, "warning");
});

test("global JSON restart warning waits for exact acknowledgement, teardown and refreshed config", async () => {
  for (const first of ["acknowledgement", "teardown"] as const) {
    const h = await harness();
    const acknowledgement = deferred<{ data: boolean }>();
    const refreshed = deferred<{ data: Config }>();
    h.dispose = () => acknowledgement.promise;
    h.read = () => refreshed.promise;
    h.run();
    await h.view("Reloading prompts");
    assert.deepEqual(h.toasts, []);
    if (first === "acknowledgement") {
      acknowledgement.resolve({ data: true });
    } else {
      h.disposed();
    }
    await setImmediate();
    assert.deepEqual(h.toasts, []);
    assert.equal(h.calls.at(-1)?.method, "dispose");
    if (first === "acknowledgement") {
      h.disposed();
    } else {
      acknowledgement.resolve({ data: true });
    }
    await setImmediate();
    assert.equal(h.calls.at(-1)?.method, "config");
    assert.deepEqual(h.toasts, []);
    refreshed.resolve({ data: {} });
    const result = await h.view("Prompt reload");
    assert.match(result.message!, /Instance reloaded/);
    assert.match(result.message!, /composition errors/);
    assert.deepEqual(h.toasts, [
      {
        variant: "warning",
        message:
          "Global JSON configuration is not reloaded. Restart OpenCode to apply those changes.",
      },
    ]);
  }
});

for (const type of ["busy", "retry", "unknown"]) {
  test(`${type} session prevents instance disposal`, async () => {
    const h = await harness();
    h.status = () => Promise.resolve({ data: { session: { type } } });
    h.run();
    const result = await h.view("Prompt reload");
    assert.match(result.message!, /idle/i);
    assert.doesNotMatch(result.message!, /restart|Global JSON/i);
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(
      h.calls.map((call) => call.method),
      ["status"],
    );
  });
}

test("unavailable session activity prevents disposal", async () => {
  const h = await harness();
  h.status = () => Promise.reject(new Error("Activity unavailable"));
  h.run();
  const result = await h.view("Prompt reload");
  assert.match(result.message!, /Activity unavailable/);
  assert.doesNotMatch(result.message!, /restart|Global JSON/i);
  assert.deepEqual(h.toasts, []);
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ["status"],
  );
});

test("missing activity data and SDK activity errors prevent disposal", async () => {
  for (const response of [
    {},
    { data: {}, error: { message: "Unavailable" } },
  ]) {
    const h = await harness();
    h.status = () => Promise.resolve(response);
    h.run();
    const result = await h.view("Prompt reload");
    assert.match(result.message!, /Could not check.*idle/i);
    assert.doesNotMatch(result.message!, /restart|Global JSON/i);
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(
      h.calls.map((call) => call.method),
      ["status"],
    );
  }
});

test("missing refreshed config data and SDK config errors cannot confirm reload", async () => {
  for (const response of [
    {},
    { data: {}, error: { message: "Unavailable" } },
  ]) {
    const h = await harness();
    h.read = () => Promise.resolve(response);
    h.run();
    await h.view("Reloading prompts");
    h.disposed();
    const result = await h.view("Prompt reload");
    assert.match(result.message!, /could not confirm/i);
    assert.match(result.message!, /Could not read.*configuration/i);
    assert.doesNotMatch(result.message!, /Instance reloaded/);
    assert.doesNotMatch(result.message!, /Global JSON/i);
    assert.deepEqual(h.toasts, []);
  }
});

test("reloads are serialized until disposal and refresh finish", async () => {
  const h = await harness();
  const activity = deferred<{ data: Record<string, { type: string }> }>();
  h.status = () => activity.promise;
  h.run();
  await h.view("Reloading prompts");
  h.commands.get("reload-prompts")!();
  activity.resolve({ data: {} });
  await setImmediate();
  h.disposed();
  await h.view("Prompt reload");
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ["status", "dispose", "config"],
  );
  h.run();
  await h.view("Reloading prompts");
  h.disposed();
  await h.view("Prompt reload");
  assert.equal(h.calls.filter((call) => call.method === "dispose").length, 2);
});

for (const change of [
  "client",
  "directory",
  "worktree",
  "route",
  "close",
  "abort",
] as const) {
  test(`stale ${change} before preflight returns cannot dispose`, async () => {
    const h = await harness();
    const activity = deferred<{ data: Record<string, { type: string }> }>();
    h.status = () => activity.promise;
    h.run();
    await h.view("Reloading prompts");
    if (change === "client") {
      Object.assign(h.api, { client: {} });
    }
    if (change === "directory" || change === "worktree") {
      h.api.state.path[change] = "/other";
    }
    if (change === "route") {
      Object.assign(h.api.route, { current: { name: "session" } });
    }
    if (change === "close") {
      h.api.ui.dialog.clear();
    }
    if (change === "abort") {
      h.controller.abort();
    }
    const before = h.current;
    activity.resolve({ data: {} });
    await setImmediate();
    assert.equal(h.current, before);
    assert.deepEqual(h.toasts, []);
    assert.deepEqual(
      h.calls.map((call) => call.method),
      ["status"],
    );
  });
}

test("a failed refresh reports uncertain reload rather than success or rollback", async () => {
  const h = await harness();
  h.run();
  await h.view("Reloading prompts");
  h.read = () => Promise.reject(new Error("Refresh unavailable"));
  h.disposed();
  const result = await h.view("Prompt reload");
  assert.match(result.message!, /requested.*could not confirm/i);
  assert.match(result.message!, /Refresh unavailable/);
  assert.match(result.message!, /restart/i);
  assert.doesNotMatch(result.message!, /Instance reloaded|rolled back/);
  assert.doesNotMatch(result.message!, /Global JSON/i);
  assert.deepEqual(h.toasts, []);
  assert.equal(h.listeners.size, 1);
});

test("missing teardown event times out, cleans the listener and permits a later reload", async (t) => {
  let deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const h = await harness();
  h.run();
  await h.view("Reloading prompts");
  deadline.abort();
  const result = await h.view("Prompt reload");
  assert.match(result.message!, /could not confirm/i);
  assert.doesNotMatch(result.message!, /Global JSON/i);
  assert.deepEqual(h.toasts, []);
  assert.equal(h.listeners.size, 1);
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ["status", "dispose"],
  );
  deadline = new AbortController();
  h.run();
  await h.view("Reloading prompts");
  h.disposed();
  await h.view("Prompt reload");
  assert.equal(h.calls.filter((call) => call.method === "dispose").length, 2);
});

test("disposal errors and negative acknowledgements never claim completion", async () => {
  for (const response of [
    { data: false },
    { data: "true" },
    {},
    { data: true, error: { message: "Rejected" } },
  ]) {
    const h = await harness();
    h.dispose = () => Promise.resolve(response);
    h.run();
    const result = await h.view("Prompt reload");
    assert.match(result.message!, /could not confirm/i);
    assert.doesNotMatch(result.message!, /Global JSON/i);
    assert.deepEqual(h.toasts, []);
    assert.equal(h.listeners.size, 1);
    assert.deepEqual(
      h.calls.map((call) => call.method),
      ["status", "dispose"],
    );
  }
});

test("teardown before HTTP acknowledgement still waits for the acknowledgement", async () => {
  const h = await harness();
  const acknowledgement = deferred<{ data: boolean }>();
  h.dispose = () => acknowledgement.promise;
  h.run();
  await h.view("Reloading prompts");
  h.disposed();
  await setImmediate();
  assert.equal(h.calls.length, 2);
  acknowledgement.resolve({ data: true });
  await h.view("Prompt reload");
  assert.equal(h.calls.at(-1)?.method, "config");
});

for (const stage of ["teardown", "refresh"] as const) {
  for (const change of [
    "client",
    "directory",
    "worktree",
    "route",
    "close",
    "abort",
    "reopen",
  ] as const) {
    test(`late ${stage} after ${change} cannot refresh or replace a new view`, async () => {
      const h = await harness();
      const refreshed = deferred<{ data: Config }>();
      h.run();
      await h.view("Reloading prompts");
      if (stage === "refresh") {
        h.read = () => refreshed.promise;
        h.disposed();
        await setImmediate();
        assert.equal(h.calls.at(-1)?.method, "config");
      }
      if (change === "client") {
        Object.assign(h.api, { client: {} });
      }
      if (change === "directory" || change === "worktree") {
        h.api.state.path[change] = "/other";
      }
      if (change === "route") {
        Object.assign(h.api.route, { current: { name: "session" } });
      }
      if (change === "close") {
        h.api.ui.dialog.clear();
      }
      if (change === "abort") {
        h.controller.abort();
      }
      if (change === "reopen") {
        h.read = () => Promise.resolve({ data: {} });
        h.run("view-prompts");
        await h.view("View prompts");
      }
      const before = h.current;
      const count = h.calls.length;
      h.disposed();
      refreshed.resolve({ data: {} });
      await setImmediate();
      assert.equal(
        h.current,
        ["client", "worktree", "route", "reopen"].includes(change)
          ? undefined
          : before,
      );
      assert.equal(h.calls.length, count);
      assert.deepEqual(h.toasts, []);
      assert.equal(h.listeners.size, 1);
    });
  }
}
