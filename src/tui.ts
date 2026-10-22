import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createFixedMenu } from "./fixed-menu.ts";
import { dialogNavigation } from "./navigation.ts";
import { previewPages } from "./preview.ts";

const PromptComposerTui: TuiPlugin = async (api) => {
  const fixedMenu = await createFixedMenu(api);
  const navigation = dialogNavigation(api);
  const stopWatching = api.event.on("server.instance.disposed", (event) => {
    if (
      event.properties.directory === api.state.path.directory &&
      navigation.active
    ) {
      navigation.close();
    }
  });
  api.lifecycle.onDispose(stopWatching);
  const open = async () => {
    const client = api.client;
    const { directory } = api.state.path;
    navigation.show(
      () =>
        api.ui.DialogAlert({
          title: "Loading prompts",
          message: "Reading loaded agent prompts and command templates…",
        }),
      true,
    );
    const current = navigation.checkpoint();
    try {
      const [response, agentResponse] = await Promise.all([
        client.config.get({ directory }, { signal: api.lifecycle.signal }),
        client.app.agents({ directory }, { signal: api.lifecycle.signal }),
      ]);
      if (!current()) {
        return;
      }
      if (response.error !== undefined || agentResponse.error !== undefined) {
        throw new Error("Could not read loaded prompts from OpenCode.");
      }
      const configured = response.data.agent ?? {};
      const loaded = agentResponse.data;
      const represented = new Set(
        Object.entries(configured).flatMap(([name, agent]) => [
          name,
          agent?.name ?? name,
        ]),
      );
      const agentEntries = [
        ...Object.entries(configured).map(([name, agent]) => {
          const matches = loaded.filter(
            (item) => item.name === (agent?.name ?? name),
          );
          return {
            name,
            prompt:
              agent?.prompt ??
              (agent?.disable !== true && matches.length === 1
                ? matches[0].prompt
                : undefined),
            disabled: agent?.disable === true,
            builtin: false,
          };
        }),
        ...loaded
          .filter((agent) => !represented.has(agent.name))
          .map((agent) => ({
            name: agent.name,
            prompt: agent.prompt,
            disabled: false,
            builtin: agent.native === true,
          })),
      ].map(({ name, prompt, disabled, builtin }) => {
        const fallback = prompt === undefined || prompt === "";
        const labels = [
          disabled ? "disabled" : "",
          builtin ? "built-in" : "",
          fallback ? "native fallback" : "",
        ].filter(Boolean);
        return {
          title: `Agent: ${name}${labels.length > 0 ? ` (${labels.join(", ")})` : ""}`,
          value: `agent:${name}`,
          text: fallback
            ? "(native fallback — no agent prompt text available)"
            : prompt,
          builtin,
        };
      });
      let showBuiltins = false;
      const menu = (
        title: string,
        options: { title: string; value: string }[],
        select: (value: string) => void,
        root = false,
      ) =>
        navigation.menu(
          {
            title,
            options,
            onSelect: (selected) => select(selected.value),
          },
          root,
          root ? fixedMenu : undefined,
        );
      const commands = Object.entries(response.data.command ?? {}).map(
        ([name, command]) => ({
          title: `Command: ${name}`,
          value: `command:${name}`,
          text: command.template,
        }),
      );
      const preview = (entry: { title: string; text: string }) => {
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
      };
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
            if (entry !== undefined) {
              preview(entry);
            }
          },
        );
      const agents = () =>
        navigation.menu({
          title: "Loaded agent prompts",
          get options() {
            const visible = agentEntries.filter(
              (entry) => showBuiltins || !entry.builtin,
            );
            return [
              ...(visible.length > 0
                ? visible.map(({ title, value }) => ({ title, value }))
                : [{ title: "No configured agent prompts", value: "empty" }]),
              {
                title: showBuiltins
                  ? "Hide built-in agents"
                  : "Show built-in agents",
                value: "\u0000builtins",
                category: "Visibility",
              },
            ];
          },
          onSelect: ({ value }) => {
            if (value === "\u0000builtins") {
              showBuiltins = !showBuiltins;
              navigation.refresh();
              return;
            }
            const entry = agentEntries.find((item) => item.value === value);
            if (entry !== undefined && (showBuiltins || !entry.builtin)) {
              preview(entry);
            }
          },
        });
      menu(
        "View prompts",
        [
          { title: "Agents", value: "agents" },
          { title: "Commands", value: "commands" },
        ],
        (value) => {
          if (value === "agents") {
            agents();
          } else if (value === "commands") {
            components(
              "Loaded command templates",
              commands,
              "No configured command templates",
            );
          }
        },
        true,
      );
    } catch (error) {
      if (current()) {
        navigation.menu(
          {
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
            ],
            onSelect: () => {
              open().catch(console.error);
            },
          },
          true,
          fixedMenu,
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
    ],
  });
  api.lifecycle.onDispose(unregister);
};

export default {
  id: "prompt-composer",
  tui: PromptComposerTui,
} satisfies TuiPluginModule;
