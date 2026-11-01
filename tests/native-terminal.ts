import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import * as pty from "node-pty";
import headless from "@xterm/headless";

const outline = [
  "Read the whole outline before reviewing any individual step, then confirm each step with evidence.",
  ...Array.from(
    { length: 150 },
    (_, index) =>
      `Outline step ${String(index + 1).padStart(3, "0")}: check the change and record evidence.`,
  ),
  "End of outline.",
];
const archive = Array.from(
  { length: 1100 },
  (_, index) =>
    `Archive entry ${String(index + 1).padStart(4, "0")}: retained reference text for bounded viewing.`,
);
/** Command files whose loaded text needs scrolling, or bounded parts when oversized. */
export const viewerCommands = {
  "outline.md": `---\ndescription: Long outline\n---\n${outline.join("\n")}`,
  "archive.md": `---\ndescription: Oversized archive\n---\n${archive.join("\n")}`,
};

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
    text,
    wait,
    waitFor,
    focused,
    echoed,
    selected,
    promptFocused,
    write: (data: string) => child.write(data),
    resize(cols: number, rows: number) {
      screen.resize(cols, rows);
      child.resize(cols, rows);
    },
    stop,
  };
}

export async function exerciseNativeTerminal(options: {
  binary: string;
  url: string;
  sessionID: string;
  builtin: string;
  project: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
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
    const rootMenu = async () => {
      await terminal.wait("View prompts", "Agents", "Commands");
      assert.doesNotMatch(
        terminal.text(),
        /Search(?: fields)?…?/,
        "The fixed category menu must not render a search input",
      );
      assert.equal(terminal.focused(), false);
    };
    const open = async () => {
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
      await rootMenu();
    };
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
    const hiddenBuiltins = async () => {
      await terminal.wait(
        "Loaded agent prompts",
        "Show built-in agents",
        "Agent: review",
        "Agent: helper",
        "Agent: build",
      );
      await terminal.waitFor(terminal.focused, "focused agent search");
      assert.doesNotMatch(terminal.text(), /Agent: [^\n]*\(built-in/);
      assert.ok(
        !terminal.text().includes(`Agent: ${options.builtin}`),
        "Unconfigured native agent must be hidden by default",
      );
      assert.doesNotMatch(terminal.text(), /Agent: build \(/);
    };
    const showBuiltins = async () => {
      await select("Show built-in agents", "Loaded agent prompts");
      await terminal.wait(
        "Hide built-in agents",
        `Agent: ${options.builtin} (built-in)`,
      );
    };
    const viewerHint = "↑/↓ scroll · pgup/pgdn page · home/end · esc back";
    const back = async (...parent: string[]) => {
      terminal.write("\x1b");
      await terminal.waitFor(
        () => !terminal.text().includes("↑/↓ scroll"),
        "closed viewer",
      );
      await terminal.wait(...parent);
    };
    const steps = () =>
      Array.from(terminal.text().matchAll(/Outline step (\d{3}):/g), (match) =>
        Number(match[1]),
      );
    const scrolled = async (
      key: string,
      ready: (shown: number[]) => boolean,
    ) => {
      terminal.write(key);
      await terminal.waitFor(
        () => ready(steps()),
        `outline after ${JSON.stringify(key)}`,
      );
    };
    const outlineViewer = async () => {
      await select("Command: outline", viewerHint);
      await terminal.wait("Command: outline", "Outline step 001:");
      // The extra-large dialog keeps this sentence on a single row.
      assert.ok(
        terminal
          .text()
          .split("\n")
          .some((row) => row.includes(outline[0])),
        terminal.text(),
      );
      assert.ok(!steps().includes(150), "Long text must scroll");
    };
    await open();
    terminal.write("\x1b[B\r");
    await terminal.wait("Loaded command templates");
    await select("Command: check", viewerHint);
    await terminal.wait(
      "Command: check",
      "Check Project updated $ARGUMENTS {{include:literal.md}}",
    );
    await back("Loaded command templates");
    await outlineViewer();
    const top = steps().length;
    await scrolled("\x1b[B", (shown) => shown.length > 0 && shown[0] > 1);
    const down = steps()[0];
    await scrolled("\x1b[6~", (shown) => shown.length > 0 && shown[0] > down);
    await scrolled("\x1b[F", (shown) => shown.includes(150));
    await terminal.wait("End of outline.");
    await scrolled("\x1b[5~", (shown) => !shown.includes(150));
    await scrolled("\x1b[H", (shown) => shown[0] === 1);
    // The viewer refits below the dialog's top offset as the terminal shrinks and grows.
    terminal.resize(120, 30);
    await terminal.waitFor(() => {
      const rows = terminal.text().split("\n");
      const hint = rows.findIndex((row) => row.includes(viewerHint));
      const shown = steps();
      return (
        hint > 0 &&
        hint < rows.length - 1 &&
        shown.length > 0 &&
        shown.length < top &&
        shown[0] === 1
      );
    }, "viewer fitted to a smaller terminal");
    await scrolled("\x1b[F", (shown) => shown.includes(150));
    terminal.resize(180, 55);
    await terminal.waitFor(
      () => steps().length === top && steps().includes(150),
      "viewer fitted to a larger terminal",
    );
    await back("Loaded command templates");
    // Each opening starts from the top with a fresh viewer.
    for (let opened = 0; opened < 2; opened++) {
      await outlineViewer();
      await scrolled("\x1b[F", (shown) => shown.includes(150));
      await back("Loaded command templates");
    }
    await select("Command: archive", "Command: archive — parts");
    await terminal.wait("Part 1 of 2", "Part 2 of 2");
    await select("Part 2 of 2", viewerHint);
    await terminal.wait("Command: archive — part 2/2");
    terminal.write("\x1b[F");
    await terminal.wait("Archive entry 1100:");
    await back("Command: archive — parts");
    await select("Part 1 of 2", viewerHint);
    await terminal.wait("Command: archive — part 1/2", "Archive entry 0001:");
    await back("Command: archive — parts");
    terminal.write("\x1b");
    await terminal.wait("Loaded command templates");
    terminal.write("\x1b");
    await rootMenu();
    terminal.write("\x1b[A\r");
    await hiddenBuiltins();
    await showBuiltins();
    await select("Hide built-in agents", "Loaded agent prompts");
    await hiddenBuiltins();
    await select("Agent: build", viewerHint);
    await terminal.wait("Build override Project updated");
    await back("Loaded agent prompts");
    await hiddenBuiltins();
    await select("Agent: review", viewerHint);
    await terminal.wait("Review Project updated", "State uncertainty.");
    await back("Loaded agent prompts");
    await hiddenBuiltins();
    await showBuiltins();
    terminal.write("\x1b");
    await rootMenu();
    terminal.write("\x1b");
    await terminal.waitFor(terminal.promptFocused, "main input after preview");
    await open();
    terminal.write("\r");
    // The visibility choice persists in the host key-value store across opens.
    await terminal.wait(
      "Loaded agent prompts",
      "Hide built-in agents",
      `Agent: ${options.builtin} (built-in)`,
    );
    await select("Hide built-in agents", "Loaded agent prompts");
    await hiddenBuiltins();
    terminal.write("\x1b");
    await rootMenu();
    terminal.write("\x1b");
    await terminal.waitFor(terminal.promptFocused, "main input after reopen");
  } finally {
    await terminal.stop();
  }
}
