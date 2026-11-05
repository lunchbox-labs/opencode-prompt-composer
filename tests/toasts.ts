import type { PluginInput } from "@opencode-ai/plugin";

export interface Toast {
  body: { title: string; message: string; variant: string };
}

/** Plugin input whose TUI client records every toast it is asked to show. */
export function recordingToasts(context: {
  directory: string;
  worktree: string;
}) {
  const toasts: Toast[] = [];
  const input = {
    ...context,
    client: {
      tui: {
        showToast: async (toast: Toast) => {
          toasts.push(toast);
        },
      },
    },
  } as unknown as PluginInput;
  return { input, toasts };
}
