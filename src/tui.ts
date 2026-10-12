import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { dialogNavigation } from "./navigation.ts";
import { verifySharedFilesystem } from "./connection.ts";
import { SettingsError } from "./errors.ts";
import { type EditPlan, editSetting, planEdits, savePlan } from "./editor.ts";
import { compose } from "./runtime.ts";
import { fingerprint, readState } from "./runtime-state.ts";
import { loadSettings } from "./settings.ts";

const PromptComposerTui: TuiPlugin = (api) => {
  const navigation = dialogNavigation(api);
  const run = (action: () => void | Promise<void>): void => {
    Promise.resolve()
      .then(action)
      .catch((error: unknown) => {
        navigation.alert({
          title: "Prompt Composer",
          message:
            error instanceof Error
              ? error.message
              : "The prompt operation failed.",
        });
      });
  };
  const root = () =>
    api.state.path.worktree !== "" && api.state.path.worktree !== "/"
      ? api.state.path.worktree
      : api.state.path.directory;
  const load = async () => {
    const project = root();
    const client = await verifySharedFilesystem(
      api,
      project,
      api.state.path.directory,
    );
    const response = await client.config.get({
      directory: api.state.path.directory,
    });
    if (response.error !== undefined) {
      throw new SettingsError("Could not read native prompt settings.");
    }
    const state = readState(response.data, project);
    const settings = await loadSettings(state.context);
    const current = await compose(state.native, settings);
    for (const file of [...settings.documents, ...current.reads]) {
      if (state.inputs[file.path] !== fingerprint(file.text)) {
        throw new SettingsError(
          "Prompt files changed since the server loaded them. Apply saved settings, then reopen the editor.",
        );
      }
    }
    return {
      settings,
      native: state.native,
      current,
      client,
      project,
      directory: api.state.path.directory,
    };
  };
  type Snapshot = Awaited<ReturnType<typeof load>>;
  const assertCurrent = (snapshot: Snapshot) => {
    if (
      snapshot.project !== root() ||
      snapshot.directory !== api.state.path.directory ||
      snapshot.client !== api.client ||
      api.lifecycle.signal.aborted
    ) {
      throw new SettingsError(
        "The OpenCode connection or project changed. Reopen the prompt editor.",
      );
    }
  };
  const review = (snapshot: Snapshot, plan: EditPlan) => {
    let check = () => false;
    const prompts = Object.entries(plan.preview.config.agent ?? {})
      .map(
        ([name, agent]) =>
          `${name}:\n${agent?.prompt?.slice(0, 1600) ?? "(native fallback)"}`,
      )
      .join("\n\n");
    navigation.confirm({
      title: "Save prompt changes?",
      message: `${plan.edits.map((edit) => edit.path).join("\n")}\n\n${prompts}\n\n${plan.preview.diagnostics.map((item) => item.message).join("\n")}\n\nSaving does not apply to the running instance.`,
      onConfirm: () => {
        run(async () => {
          if (!check()) {
            return;
          }
          assertCurrent(snapshot);
          await verifySharedFilesystem(
            api,
            snapshot.project,
            snapshot.directory,
          );
          assertCurrent(snapshot);
          const latest = await load();
          if (
            JSON.stringify(latest.native) !== JSON.stringify(snapshot.native)
          ) {
            throw new SettingsError(
              "Native prompt state changed. Reopen the editor.",
            );
          }
          await savePlan(plan);
          navigation.alert({
            title: "Prompt settings saved",
            message:
              "Use Apply saved prompt settings when agents are idle, or restart OpenCode.",
          });
        });
      },
    });
    check = navigation.checkpoint();
  };
  const sources = (snapshot: Snapshot) => {
    navigation.menu({
      title: "Prompt settings source",
      options: snapshot.settings.documents.map((doc) => ({
        title: doc.path,
        value: doc.path,
      })),
      onSelect: (selected) => {
        const doc = snapshot.settings.documents.find(
          (item) => item.path === selected.value,
        );
        if (doc === undefined) {
          return;
        }
        navigation.menu({
          title: "Edit prompt settings",
          options: [
            {
              title: "Agent fragments and default inheritance",
              value: "agents",
            },
            { title: "Default fragments", value: "defaults" },
            { title: "Complete JSONC document", value: "document" },
          ],
          onSelect: (field) => {
            const key = field.value;
            let check = () => false;
            navigation.prompt({
              title: field.title,
              value:
                key === "document"
                  ? doc.text
                  : JSON.stringify(Reflect.get(doc.value, key) ?? {}, null, 2),
              onConfirm: (value) => {
                run(async () => {
                  if (!check()) {
                    return;
                  }
                  assertCurrent(snapshot);
                  const parsed: unknown =
                    key === "document" ? undefined : JSON.parse(value);
                  const text =
                    key === "document"
                      ? value
                      : editSetting(doc.text, [key], parsed);
                  review(
                    snapshot,
                    await planEdits(snapshot.settings, snapshot.native, [
                      { path: doc.path, text },
                    ]),
                  );
                });
              },
            });
            check = navigation.checkpoint();
          },
        });
      },
    });
  };
  const apply = async () => {
    const directory = api.state.path.directory;
    const client = api.client;
    const status = await client.session.status({ directory });
    if (
      status.error !== undefined ||
      Object.values(status.data).some((item) => item.type !== "idle")
    ) {
      throw new SettingsError(
        "Wait for active agents to finish before applying saved prompt settings.",
      );
    }
    if (client !== api.client || directory !== api.state.path.directory) {
      throw new SettingsError("The current OpenCode instance changed.");
    }
    const disposed = await client.instance.dispose({ directory });
    if (disposed.error !== undefined || !disposed.data) {
      throw new SettingsError(
        "Could not apply settings. Saved files remain available for a restart.",
      );
    }
    const refreshed = await client.config.get({ directory });
    if (refreshed.error !== undefined) {
      throw new SettingsError(
        "The instance could not reload. Inspect the server log.",
      );
    }
    readState(refreshed.data, root());
    navigation.alert({
      title: "Prompt settings applied",
      message:
        "The current OpenCode instance has reloaded its prompt settings.",
    });
  };
  const open = async () => {
    const snapshot = await load();
    navigation.menu(
      {
        title: "Compose prompts",
        options: [
          { title: "Edit prompt settings…", value: "edit" },
          { title: "Preview effective prompts and notices", value: "preview" },
          { title: "Apply saved prompt settings", value: "apply" },
          ...(snapshot.settings.documents.length === 0
            ? [{ title: "Create project prompt settings", value: "create" }]
            : []),
        ],
        onSelect: (selected) => {
          run(async () => {
            assertCurrent(snapshot);
            switch (selected.value) {
              case "edit":
                sources(snapshot);
                break;
              case "preview":
                navigation.alert({
                  title: "Effective prompts",
                  message: [
                    ...Object.entries(snapshot.current.config.agent ?? {}).map(
                      ([name, agent]) =>
                        `${name}:\n${agent?.prompt?.slice(0, 2400) ?? "(native fallback)"}`,
                    ),
                    ...snapshot.current.diagnostics.map((item) => item.message),
                  ].join("\n\n"),
                });
                break;
              case "apply":
                await apply();
                break;
              case "create": {
                const path = join(
                  snapshot.project,
                  ".opencode/prompt-composer.jsonc",
                );
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, '{\n  "agents": {}\n}\n', {
                  flag: "wx",
                  mode: 0o600,
                });
                await apply();
                break;
              }
            }
          });
        },
      },
      true,
    );
  };
  const unregister = api.keymap.registerLayer({
    commands: [
      {
        name: "prompt-composer.compose",
        title: "Compose prompts",
        namespace: "palette",
        category: "Prompts",
        slashName: "compose-prompts",
        run: () => run(open),
      },
      {
        name: "prompt-composer.apply",
        title: "Apply saved prompt settings",
        namespace: "palette",
        category: "Prompts",
        slashName: "prompt-reload",
        run: () => run(apply),
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
