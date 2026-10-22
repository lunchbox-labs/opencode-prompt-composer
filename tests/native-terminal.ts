import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import * as pty from "node-pty";
import headless from "@xterm/headless";

/** Real Unix PTY / Windows ConPTY with an actual reconstructed terminal screen. */
export function nativeTerminal(options: {
  binary: string;
  args: string[];
  project: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}) {
  const screen = new headless.Terminal({
    cols: 180,
    rows: 55,
    scrollback: 0,
    allowProposedApi: true,
  });
  const child = pty.spawn(options.binary, options.args, {
    name: "xterm-256color",
    cols: 180,
    rows: 55,
    cwd: options.project,
    env: { ...options.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
  });
  let transcript = "";
  let exited = false;
  let visible = false;
  for (const [final, value] of [
    ["h", true],
    ["l", false],
  ] as const) {
    screen.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
      if (params.includes(25)) {
        visible = value;
      }
      return false;
    });
  }
  const closed = new Promise<void>((resolve) =>
    child.onExit(() => {
      exited = true;
      resolve();
    }),
  );
  screen.onData((data) => child.write(data));
  child.onData((data) => {
    transcript = (transcript + data).slice(-65_536);
    screen.write(data);
  });
  const text = () =>
    Array.from(
      { length: screen.rows },
      (_, row) => screen.buffer.active.getLine(row)?.translateToString() ?? "",
    ).join("\n");
  let stopping: Promise<void> | undefined;
  let abort = () => {};
  const stop = () => {
    stopping ??= (async () => {
      options.signal.removeEventListener("abort", abort);
      try {
        if (process.platform === "win32") {
          await promisify(execFile)(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            { timeout: 5000 },
          ).catch((error: unknown) => {
            if (!exited) {
              throw error;
            }
          });
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (!(
              error instanceof Error &&
              "code" in error &&
              error.code === "ESRCH"
            )) {
              throw error;
            }
          }
        }
      } finally {
        try {
          child.kill();
        } finally {
          screen.dispose();
        }
      }
      await Promise.race([
        closed,
        setTimeout(5000).then(() => {
          assert.ok(exited, "Native PTY process survived cleanup");
        }),
      ]);
    })();
    return stopping;
  };
  abort = () => {
    void stop().catch(() => {
      /* The caller's finally awaits and reports cleanup failures. */
    });
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) {
    abort();
  }
  const waitFor = async (ready: () => boolean, description: string) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      options.signal.throwIfAborted();
      assert.equal(
        exited,
        false,
        `Native terminal exited:\n${text()}\n${transcript.slice(-4000)}`,
      );
      if (ready()) {
        return;
      }
      await setTimeout(50);
    }
    assert.fail(
      `Native terminal did not render ${description}:\n${text()}\n${transcript.slice(-4000)}`,
    );
  };
  const wait = (...labels: string[]) =>
    waitFor(
      () =>
        labels.every((label) => text().replace(/\s+/g, " ").includes(label)),
      JSON.stringify(labels),
    );
  const focused = () => {
    const buffer = screen.buffer.active;
    return (
      visible &&
      /^Search(?: fields)?…?(?:\s|$)/.test(
        buffer
          .getLine(buffer.cursorY)
          ?.translateToString(false, buffer.cursorX) ?? "",
      )
    );
  };
  const echoed = (value: string) => {
    const buffer = screen.buffer.active;
    return (
      visible &&
      buffer.cursorX >= value.length &&
      buffer
        .getLine(buffer.cursorY)
        ?.translateToString(
          false,
          buffer.cursorX - value.length,
          buffer.cursorX,
        ) === value
    );
  };
  const promptFocused = () => {
    const buffer = screen.buffer.active;
    return (
      visible &&
      buffer.cursorX === 5 &&
      buffer.cursorY >= screen.rows - 9 &&
      buffer.getLine(buffer.cursorY)?.translateToString(false, 0, 5) === "  ┃  "
    );
  };
  const selected = (label: string, query: string) => {
    if (!echoed(query)) {
      return false;
    }
    const buffer = screen.buffer.active;
    const column = buffer.cursorX - query.length;
    const input = buffer.getLine(buffer.cursorY)?.getCell(column);
    if (input === undefined) {
      return false;
    }
    for (let row = buffer.cursorY + 1; row < screen.rows; row++) {
      const line = buffer.getLine(row);
      const first = line?.getCell(column);
      const last = line?.getCell(column + label.length - 1);
      if (
        line?.translateToString(false, column, column + label.length) !==
          label ||
        first === undefined ||
        last === undefined
      ) {
        continue;
      }
      if (
        first.getBgColorMode() !== 0 &&
        first.getBgColorMode() === last.getBgColorMode() &&
        first.getBgColor() === last.getBgColor() &&
        (first.getBgColorMode() !== input.getBgColorMode() ||
          first.getBgColor() !== input.getBgColor())
      ) {
        return true;
      }
    }
    return false;
  };
  return {
    pid: child.pid,
    wait,
    waitFor,
    focused,
    echoed,
    selected,
    promptFocused,
    write: (data: string) => child.write(data),
    stop,
  };
}

export async function exerciseNativeTerminal(options: {
  binary: string;
  url: string;
  sessionID: string;
  project: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  editPrompts: (stage: "slash" | "menu" | "broken") => Promise<void>;
  verifyReload: (stage: "slash" | "menu" | "broken") => Promise<void>;
}) {
  // Attach to the already exercised/warmed server rather than starting a second
  // cold backend. TUI npm loading, compatibility and command registration remain native.
  const terminal = nativeTerminal({
    ...options,
    args: [
      "attach",
      options.url,
      "--dir",
      options.project,
      "--session",
      options.sessionID,
    ],
  });
  try {
    await terminal.waitFor(
      terminal.promptFocused,
      "main conversation input focus",
    );
    terminal.write("/view-prompts");
    await terminal.waitFor(
      () => terminal.echoed("/view-prompts"),
      "slash command input echo",
    );
    await terminal.wait("View prompts");
    terminal.write("\r");
    await terminal.wait("View prompts", "Agents", "Commands");
    const select = async (label: string, title: string) => {
      await terminal.waitFor(
        terminal.focused,
        "focused preview chooser search",
      );
      terminal.write(`\x15${label}`);
      await terminal.waitFor(
        () => terminal.selected(label, label),
        `highlighted ${label} option`,
      );
      terminal.write("\r");
      await terminal.wait(title);
    };
    await select("Agents", "Loaded agent prompts");
    await select("Agent: review", "Agent: review — pages");
    await select("Page 1 of 1", "Agent: review — page 1/1");
    await terminal.wait("Review Project updated", "State uncertainty.");
    terminal.write("\x1b");
    await terminal.wait("Agent: review — pages");
    terminal.write("\x1b");
    await terminal.wait("Loaded agent prompts");
    terminal.write("\x1b");
    await terminal.wait("View prompts", "Agents", "Commands");
    await select("Commands", "Loaded command templates");
    await select("Command: check", "Command: check — pages");
    await select("Page 1 of 1", "Command: check — page 1/1");
    await terminal.wait(
      "Check Project updated $ARGUMENTS {{include:literal.md}}",
    );
    terminal.write("\x1b");
    await terminal.wait("Command: check — pages");
    terminal.write("\x1b");
    await terminal.wait("Loaded command templates");
    terminal.write("\x1b");
    await terminal.wait("View prompts");
    terminal.write("\x1b");
    await terminal.waitFor(terminal.promptFocused, "main input after preview");
    for (const stage of ["slash", "menu", "broken"] as const) {
      await options.editPrompts(stage);
      const command = stage === "menu" ? "/view-prompts" : "/reload-prompts";
      terminal.write(command);
      await terminal.waitFor(
        () => terminal.echoed(command),
        `${command} input echo`,
      );
      await terminal.wait(stage === "menu" ? "View prompts" : "Reload prompts");
      terminal.write("\r");
      if (stage === "menu") {
        await terminal.wait(
          "View prompts",
          "Agents",
          "Commands",
          "Reload prompts",
        );
        await select("Reload prompts", "Prompt reload");
      }
      await terminal.wait(
        "Prompt reload",
        "Instance reloaded",
        "composition errors",
        "Global JSON configuration is not reloaded. Restart",
        "OpenCode to apply those changes.",
      );
      await options.verifyReload(stage);
      terminal.write("\x1b");
      await terminal.waitFor(
        terminal.promptFocused,
        "main input after prompt reload",
      );
      if (stage === "broken") {
        continue;
      }
      terminal.write("/view-prompts");
      await terminal.waitFor(
        () => terminal.echoed("/view-prompts"),
        "reopened viewer input echo",
      );
      await terminal.wait("View prompts");
      terminal.write("\r");
      await terminal.wait("View prompts", "Agents", "Commands");
      await select("Agents", "Loaded agent prompts");
      await select("Agent: review", "Agent: review — pages");
      await select("Page 1 of 1", "Agent: review — page 1/1");
      await terminal.wait(
        `${stage} agent Project ${stage}`,
        "State uncertainty.",
      );
      terminal.write("\x1b");
      await terminal.wait("Agent: review — pages");
      terminal.write("\x1b");
      await terminal.wait("Loaded agent prompts");
      terminal.write("\x1b");
      await terminal.wait("View prompts");
      terminal.write("\x1b");
      await terminal.waitFor(
        terminal.promptFocused,
        "main input after refreshed viewer",
      );
    }
  } finally {
    await terminal.stop();
  }
}
