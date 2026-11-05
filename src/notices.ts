import type { PluginInput } from "@opencode-ai/plugin";

type ToastClient = Partial<Pick<PluginInput["client"], "tui">>;
export type NoticeVariant = "warning" | "error";

/** The host ignores hook failures and fallbacks; a toast is the only user-visible signal. */
export function notify(
  input: PluginInput,
  message: string,
  variant: NoticeVariant = "warning",
): void {
  // Unit tests and headless hosts may supply no client.
  const client = input.client as ToastClient | undefined;
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

/** The first problem in full, then how many more there were. */
export function firstProblem(problems: readonly string[]): string {
  const remaining = problems.length - 1;
  return remaining === 0
    ? (problems[0] ?? "")
    : `${problems[0]} ${remaining} more ${remaining === 1 ? "problem" : "problems"} not shown.`;
}
