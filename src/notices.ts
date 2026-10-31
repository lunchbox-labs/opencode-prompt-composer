import type { PluginInput } from "@opencode-ai/plugin";

type ToastClient = Partial<Pick<PluginInput["client"], "tui">>;

/** The host ignores hook failures; a toast is the only user-visible signal. */
export function notifyFailure(input: PluginInput, message: string): void {
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
        variant: "error",
      },
    });
    shown.catch(() => undefined);
  } catch {
    // Notifications are best-effort, including hosts that throw before returning.
  }
}
