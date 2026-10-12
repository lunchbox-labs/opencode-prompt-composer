import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { dialogNavigation } from "./navigation.ts";
import { verifySharedFilesystem } from "./connection.ts";
import { SettingsError } from "./errors.ts";
import { type EditPlan, editSetting, planEdits, savePlan } from "./editor.ts";
import { compose } from "./runtime.ts";
import { fingerprint, readState } from "./runtime-state.ts";
import { loadSettings } from "./settings.ts";
import { projectDiscoveryEnabled } from "./discovery.ts";

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
      api.state.path.directory,
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
    const inputs = Object.fromEntries(
      [...settings.documents, ...current.reads].map((file) => [
        file.path,
        fingerprint(file.text),
      ]),
    );
    if (
      Object.keys(inputs).length !== Object.keys(state.inputs).length ||
      Object.entries(inputs).some(([path, hash]) => state.inputs[path] !== hash)
    ) {
      throw new SettingsError(
        "Prompt files changed since the server loaded them. Apply saved settings, then reopen the editor.",
      );
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
  let readingFiles = false;
  const readFiles = (show: (snapshot: Snapshot) => void) => {
    if (readingFiles) {
      return;
    }
    readingFiles = true;
    const check = navigation.checkpoint();
    const directory = api.state.path.directory;
    const project = root();
    run(async () => {
      try {
        const snapshot = await load();
        if (!check()) {
          return;
        }
        if (directory !== api.state.path.directory || project !== root()) {
          throw new SettingsError(
            "The OpenCode connection or project changed. Reopen the prompt editor.",
          );
        }
        assertCurrent(snapshot);
        show(snapshot);
      } catch (error) {
        if (check()) {
          throw error;
        }
      } finally {
        readingFiles = false;
      }
    });
  };
  const promptFiles = (snapshot: Snapshot) => {
    const inventory = snapshot.settings.inventory;
    if (inventory.files.size === 0) {
      navigation.alert({
        title: "Prompt files",
        message: `No prompt files discovered. Add a .md or .txt file under prompts in an enabled discovery directory:\n\n${inventory.directories.join("\n")}`,
      });
      return;
    }
    navigation.menu({
      title: "Prompt files",
      options: [...inventory.files.keys()].map((name) => ({
        title: name,
        value: name,
      })),
      onSelect: (selected) => {
        readFiles((latest) => {
          const name = selected.value;
          const source = latest.settings.inventory.files.get(name);
          const shadowed =
            latest.settings.inventory.candidates.get(name)?.slice(0, -1) ?? [];
          navigation.alert({
            title: "Prompt file source",
            message:
              source === undefined
                ? `The prompt file ${name} is no longer discovered. Reopen Prompt files to refresh the list.`
                : `Filename: ${name}\n\nInclude marker:\n{{include:${name}}}\n\nWinning path:\n${source.path}\n\nShadowed paths (discovery order):\n${shadowed.length === 0 ? "(none)" : shadowed.join("\n")}`,
          });
        });
      },
    });
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
        if (!check()) {
          return;
        }
        check = () => false;
        run(async () => {
          assertCurrent(snapshot);
          await verifySharedFilesystem(
            api,
            snapshot.directory,
            snapshot.directory,
          );
          assertCurrent(snapshot);
          const latest = await load();
          assertCurrent(snapshot);
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
  const sources = (snapshot: Snapshot, apply: () => Promise<void>) => {
    navigation.menu({
      title: "Prompt settings source",
      options: [
        ...snapshot.settings.documents.map((doc) => ({
          title: doc.path,
          value: doc.path,
        })),
        ...(snapshot.settings.documents.length === 0 &&
        projectDiscoveryEnabled()
          ? [{ title: "Create project prompt settings", value: "create" }]
          : []),
      ],
      onSelect: (selected) => {
        if (selected.value === "create") {
          run(async () => {
            assertCurrent(snapshot);
            if (!projectDiscoveryEnabled()) {
              throw new SettingsError(
                "Project prompt discovery is disabled. Use an enabled global or custom settings source.",
              );
            }
            const path = join(
              snapshot.project,
              ".opencode/prompt-composer.jsonc",
            );
            await mkdir(dirname(path), { recursive: true });
            assertCurrent(snapshot);
            await writeFile(path, '{\n  "agents": {}\n}\n', {
              flag: "wx",
              mode: 0o600,
            });
            assertCurrent(snapshot);
            await apply();
          });
          return;
        }
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
            navigation.prompt({
              title: field.title,
              value:
                key === "document"
                  ? doc.text
                  : JSON.stringify(Reflect.get(doc.value, key) ?? {}, null, 2),
              onConfirm: (value) => {
                const check = navigation.checkpoint();
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
                  const plan = await planEdits(
                    snapshot.settings,
                    snapshot.native,
                    [{ path: doc.path, text }],
                  );
                  if (check()) {
                    review(snapshot, plan);
                  }
                });
              },
            });
          },
        });
      },
    });
  };
  const applySaved = async () => {
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
    const project = root();
    const assertCurrent = () => {
      if (
        client !== api.client ||
        directory !== api.state.path.directory ||
        project !== root() ||
        api.lifecycle.signal.aborted
      ) {
        throw new SettingsError("The current OpenCode instance changed.");
      }
    };
    const before = await client.config.get({ directory });
    assertCurrent();
    if (before.error !== undefined) {
      throw new SettingsError("Could not read the current prompt runtime.");
    }
    const previous = readState(before.data, project);
    const disposed = await client.instance.dispose({ directory });
    if (disposed.error !== undefined || !disposed.data) {
      throw new SettingsError(
        "Could not apply settings. Saved files remain available for a restart.",
      );
    }
    // OpenCode acknowledges disposal before teardown finishes. During that
    // interval /config may expose old or partially reset data.
    const deadline = Date.now() + 15_000;
    let failure: unknown;
    let fresh = false;
    do {
      assertCurrent();
      const refreshed = await client.config.get(
        { directory },
        {
          signal: AbortSignal.any([
            api.lifecycle.signal,
            AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          ]),
        },
      );
      assertCurrent();
      try {
        if (refreshed.error !== undefined) {
          throw new SettingsError(
            "The instance could not reload. Inspect the server log.",
          );
        }
        const current = readState(refreshed.data, project);
        if (current.id !== previous.id) {
          fresh = true;
          break;
        }
      } catch (error) {
        failure = error;
      }
      await setTimeout(50, undefined, { signal: api.lifecycle.signal });
    } while (Date.now() < deadline);
    if (!fresh) {
      throw new SettingsError(
        `The instance did not confirm a fresh prompt runtime. Saved files remain available for a restart.${failure instanceof Error ? ` ${failure.message}` : ""}`,
      );
    }
    navigation.alert({
      title: "Prompt settings applied",
      message:
        "The current OpenCode instance has reloaded its prompt settings.",
    });
  };
  let applying = false;
  const apply = async () => {
    if (applying) {
      return;
    }
    applying = true;
    try {
      await applySaved();
    } finally {
      applying = false;
    }
  };
  const open = () => {
    navigation.menu(
      {
        title: "Compose prompts",
        options: [
          { title: "Edit prompt settings…", value: "edit" },
          { title: "Browse prompt files", value: "files" },
          { title: "Preview effective prompts and notices", value: "preview" },
          { title: "Apply saved prompt settings", value: "apply" },
        ],
        onSelect: (selected) => {
          if (selected.value === "files") {
            readFiles(promptFiles);
            return;
          }
          run(async () => {
            if (selected.value === "apply") {
              await apply();
              return;
            }
            const snapshot = await load();
            assertCurrent(snapshot);
            switch (selected.value) {
              case "edit":
                sources(snapshot, apply);
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
    ],
  });
  api.lifecycle.onDispose(unregister);
  return Promise.resolve();
};

export default {
  id: "prompt-composer",
  tui: PromptComposerTui,
} satisfies TuiPluginModule;
