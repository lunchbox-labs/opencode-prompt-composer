import type { PluginInput } from "@opencode-ai/plugin";

type NoticeClient = Partial<Pick<PluginInput["client"], "tui" | "app">>;
export type NoticeVariant = "warning" | "error";

/**
 * The host ignores hook failures and fallbacks, so a toast is the only
 * visible signal. The server log keeps `details`, which may be longer than a
 * toast can show.
 */
export function notify(
  input: PluginInput,
  message: string,
  variant: NoticeVariant = "warning",
  details: string = message,
): void {
  // Unit tests and headless hosts may supply no client.
  const client = input.client as NoticeClient | undefined;
  try {
    const logged = client?.app?.log({
      body: {
        service: "prompt-composer",
        level: variant === "error" ? "error" : "warn",
        message: details,
      },
    });
    logged?.catch(() => undefined);
  } catch {
    // Logging is best-effort, like notifications.
  }
  const tui = client?.tui;
  if (tui === undefined) {
    return;
  }
  try {
    const shown = tui.showToast({
      body: {
        title: "Prompt Composer",
        message: message.length > 600 ? `${message.slice(0, 599)}…` : message,
        variant,
      },
    });
    shown.catch(() => undefined);
  } catch {
    // Notifications are best-effort, including hosts that throw before returning.
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first problem in full, then how many more the server log lists. */
export function firstProblem(
  problems: readonly string[],
  product: string,
): string {
  const remaining = problems.length - 1;
  return remaining === 0
    ? (problems[0] ?? "")
    : `${problems[0]} See the ${product} log for ${remaining} more.`;
}
