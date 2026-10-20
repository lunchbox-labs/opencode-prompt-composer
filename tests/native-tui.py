"""Exercise npm TUI registration and preview in a real Linux terminal."""

import errno
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time


def terminate(signum, _frame):
    # execFile timeout and test cancellation both send SIGTERM. Unwind through
    # finally so the independently sessioned PTY child cannot outlive this driver.
    raise SystemExit(128 + signum)


signal.signal(signal.SIGTERM, terminate)
overall_deadline = time.monotonic() + 120
binary, project = sys.argv[1:]
pid, terminal = pty.fork()
if pid == 0:
    os.chdir(project)
    os.execvpe(binary, [binary, "--port", "0"], os.environ)

fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 180, 0, 0))
transcript = bytearray()
escape = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))")


def screen():
    return escape.sub("", transcript.decode("utf-8", errors="replace"))


def wait_for(*labels):
    # Each checkpoint must appear in new terminal output, not a prior menu's text.
    start = len(transcript)
    deadline = min(time.monotonic() + 40, overall_deadline)
    while time.monotonic() < deadline:
        ready, _, _ = select.select([terminal], [], [], 0.1)
        if not ready:
            continue
        try:
            data = os.read(terminal, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                raise AssertionError("OpenCode exited before the terminal checkpoint") from error
            raise
        if not data:
            raise AssertionError("OpenCode closed the terminal before the checkpoint")
        transcript.extend(data)
        for query, response in [
            (b"\x1b[6n", b"\x1b[1;1R"),
            (b"\x1b[c", b"\x1b[?1;2c"),
            (b"\x1b[>c", b"\x1b[>0;95;0c"),
            (b"\x1b[?u", b"\x1b[?0u"),
        ]:
            if query in data:
                os.write(terminal, response)
        current = escape.sub("", transcript[start:].decode("utf-8", errors="replace"))
        if all(label in current for label in labels):
            return
    raise AssertionError(f"Terminal did not render {labels}")


def command(name, label):
    os.write(terminal, name.encode())
    wait_for(name, label)
    os.write(terminal, b"\r")


try:
    wait_for("Ask anything")
    command("/compose-prompts", "Compose prompts")
    wait_for("Compose prompts", "Edit prompt settings", "Preview effective prompts")
    os.write(terminal, b"\x1b[B\r")
    wait_for("Effective prompts", "Project updated")
    print("native npm TUI rendered Prompt Composer and composed preview")
except BaseException:
    print(" ".join(screen().split())[-6000:], file=sys.stderr)
    raise
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        finished, _ = os.waitpid(pid, os.WNOHANG)
        if finished:
            break
        time.sleep(0.05)
    else:
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(terminal)
