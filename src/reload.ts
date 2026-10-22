import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { dialogNavigation } from "./navigation.ts";

/** Reload only the connected instance; the HTTP response alone is an acknowledgement. */
export function promptReload(
  api: TuiPluginApi,
  navigation: ReturnType<typeof dialogNavigation>,
) {
  let running = false;
  let current = () => false;
  const run = async () => {
    if (running || api.lifecycle.signal.aborted) {
      return;
    }
    running = true;
    const client = api.client;
    const { directory } = api.state.path;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      api.lifecycle.signal,
      controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    let requested = false;
    const show = (title: string, message: string) =>
      navigation.show(() => api.ui.DialogAlert({ title, message }), true);
    show("Reloading prompts", "Checking that OpenCode sessions are idle…");
    current = navigation.checkpoint();
    try {
      const activity = await client.session.status({ directory }, { signal });
      if (!current()) {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Reject missing runtime response data despite the SDK success type.
      if (activity.error !== undefined || activity.data === undefined) {
        throw new Error("Could not check whether OpenCode sessions are idle.");
      }
      if (
        Object.values(activity.data).some((status) => status.type !== "idle")
      ) {
        throw new Error(
          "Wait until all OpenCode sessions are idle, then reload prompts.",
        );
      }
      // Subscribe first: teardown can finish before the disposal response arrives.
      signal.throwIfAborted();
      const disposed = new Promise<void>((resolve, reject) => {
        const subscription: { off?: () => void } = {};
        const abort = () => {
          subscription.off?.();
          reject(
            new Error(
              "Timed out or disconnected while waiting for OpenCode teardown.",
            ),
          );
        };
        subscription.off = api.event.on("server.instance.disposed", (event) => {
          if (event.properties.directory !== directory) {
            return;
          }
          subscription.off?.();
          signal.removeEventListener("abort", abort);
          resolve();
        });
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          abort();
        }
      });
      requested = true;
      await Promise.all([
        client.instance.dispose({ directory }, { signal }).then((response) => {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- Only the exact native true acknowledgement confirms acceptance.
          if (response.error !== undefined || response.data !== true) {
            throw new Error("OpenCode did not acknowledge instance disposal.");
          }
        }),
        disposed,
      ]);
      if (!current()) {
        return;
      }
      // Native worker/SSE delivery occurs after the disposed instance is removed.
      // This request awaits the replacement instance's bootstrap and config hooks.
      const response = await client.config.get({ directory }, { signal });
      if (!current()) {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Reject missing runtime response data despite the SDK success type.
      if (response.error !== undefined || response.data === undefined) {
        throw new Error("Could not read the refreshed OpenCode configuration.");
      }
      show(
        "Prompt reload",
        "Instance reloaded. OpenCode returned its configuration. Use /view-prompts to inspect loaded text; check OpenCode logs for prompt composition errors. Global JSON edits require restarting OpenCode.",
      );
      api.ui.toast({
        variant: "warning",
        message:
          "Global JSON configuration is not reloaded. Restart OpenCode to apply those changes.",
      });
    } catch (error) {
      if (current()) {
        const message =
          error instanceof Error ? error.message : "OpenCode reload failed.";
        show(
          "Prompt reload",
          requested
            ? `Reload requested, but could not confirm the refreshed instance. ${message} Retry or restart OpenCode.`
            : message,
        );
      }
    } finally {
      controller.abort();
      running = false;
    }
  };
  return {
    run,
    get active() {
      return running && current();
    },
  };
}
