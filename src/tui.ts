import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { dialogNavigation } from "./navigation.ts";
import { previewPages } from "./preview.ts";
import { promptReload } from "./reload.ts";

const PromptComposerTui: TuiPlugin = (api) => {
  const navigation = dialogNavigation(api);
  const reload = promptReload(api, navigation);
  const stopWatching = api.event.on("server.instance.disposed", (event) => {
    if (
      event.properties.directory === api.state.path.directory &&
      !reload.active &&
      navigation.active
    ) {
      navigation.close();
    }
  });
  api.lifecycle.onDispose(stopWatching);
  const open = async () => {
    const client = api.client;
    const { directory, worktree } = api.state.path;
    const sameProject = () =>
      directory === api.state.path.directory &&
      worktree === api.state.path.worktree;
    navigation.show(
      () =>
        api.ui.DialogAlert({
          title: "Loading prompts",
          message: "Reading loaded agent prompts and command templates…",
        }),
      true,
    );
    const check = navigation.checkpoint();
    const current = () => check() && sameProject();
    try {
      const response = await client.config.get(
        { directory },
        { signal: api.lifecycle.signal },
      );
      if (!current()) {
        return;
      }
      if (response.error !== undefined) {
        throw new Error("Could not read loaded prompts from OpenCode.");
      }
      const agents = Object.entries(response.data.agent ?? {}).map(
        ([name, agent]) => {
          const fallback =
            agent?.prompt === undefined || agent.prompt.trim() === "";
          const labels = [
            agent?.disable === true ? "disabled" : "",
            fallback ? "native fallback" : "",
          ].filter(Boolean);
          return {
            title: `Agent: ${name}${labels.length > 0 ? ` (${labels.join(", ")})` : ""}`,
            value: `agent:${name}`,
            text: fallback
              ? "(native fallback — no configured prompt text)"
              : (agent.prompt ?? ""),
          };
        },
      );
      // Rebind callbacks when Back restores a view; retired callbacks stay inert.
      const menu = (
        title: string,
        options: { title: string; value: string }[],
        select: (value: string) => void,
        root = false,
      ) => {
        let active = () => false;
        const render = navigation.select({
          title,
          options,
          onSelect: (selected) => {
            if (active() && sameProject()) {
              select(selected.value);
            }
          },
        });
        navigation.show(() => {
          active = navigation.checkpoint();
          return render();
        }, root);
      };
      const commands = Object.entries(response.data.command ?? {}).map(
        ([name, command]) => ({
          title: `Command: ${name}`,
          value: `command:${name}`,
          text: command.template,
        }),
      );
      const components = (
        title: string,
        entries: { title: string; value: string; text: string }[],
        empty: string,
      ) =>
        menu(
          title,
          entries.length > 0
            ? entries.map(({ title, value }) => ({ title, value }))
            : [{ title: empty, value: "empty" }],
          (value) => {
            const entry = entries.find((item) => item.value === value);
            if (entry === undefined) {
              return;
            }
            const pages = previewPages(entry.text);
            menu(
              `${entry.title} — pages`,
              pages.map((_, index) => ({
                title: `Page ${index + 1} of ${pages.length}`,
                value: String(index),
              })),
              (value) => {
                const index = Number(value);
                navigation.alert({
                  title: `${entry.title} — page ${index + 1}/${pages.length}`,
                  message: pages[index] === "" ? "(empty text)" : pages[index],
                });
              },
            );
          },
        );
      menu(
        "View prompts",
        [
          { title: "Agents", value: "agents" },
          { title: "Commands", value: "commands" },
          { title: "Reload prompts", value: "reload" },
        ],
        (value) => {
          if (value === "agents") {
            components(
              "Loaded agent prompts",
              agents,
              "No configured agent prompts",
            );
          } else if (value === "commands") {
            components(
              "Loaded command templates",
              commands,
              "No configured command templates",
            );
          } else if (value === "reload") {
            reload.run().catch(console.error);
          }
        },
        true,
      );
    } catch (error) {
      if (current()) {
        navigation.show(
          () =>
            navigation.select({
              title: "View prompts",
              options: [
                {
                  title: "Retry viewing prompts",
                  value: "retry",
                  description:
                    error instanceof Error
                      ? error.message
                      : "Could not read loaded prompts.",
                },
                { title: "Reload prompts", value: "reload" },
              ],
              onSelect: (selected) => {
                if (selected.value === "reload") {
                  reload.run().catch(console.error);
                } else {
                  open().catch(console.error);
                }
              },
            })(),
          true,
        );
      }
    }
  };
  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: "prompt-composer.view-prompts",
        title: "View prompts",
        namespace: "palette",
        category: "Prompts",
        slashName: "view-prompts",
        // Native command dispatch clears its picker after invoking the handler.
        run: () => Promise.resolve().then(open),
      },
      {
        name: "prompt-composer.reload-prompts",
        title: "Reload prompts",
        namespace: "palette",
        category: "Prompts",
        slashName: "reload-prompts",
        run: () => Promise.resolve().then(reload.run),
      },
    ],
  });
  api.lifecycle.onDispose(unregister);
  return Promise.resolve();
};

export default {
  id: "prompt-composer",
  tui: PromptComposerTui,
} satisfies TuiPluginModule;
