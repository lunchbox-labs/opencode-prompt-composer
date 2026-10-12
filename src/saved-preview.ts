import { relative } from "node:path";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { verifyInventory, verifyReads } from "./editor.ts";
import { SettingsError } from "./errors.ts";
import { compose } from "./runtime.ts";
import { readState } from "./runtime-state.ts";
import { loadSettings } from "./settings.ts";

/** Compose a verified saved snapshot without writing a filesystem probe. */
export async function loadSavedPreview(api: TuiPluginApi, root: () => string) {
  const project = root();
  const directory = api.state.path.directory;
  const client = api.client;
  const assertCurrent = () => {
    if (
      project !== root() ||
      directory !== api.state.path.directory ||
      client !== api.client ||
      api.lifecycle.signal.aborted
    ) {
      throw new SettingsError(
        "The OpenCode connection or project changed. Reopen the saved preview.",
      );
    }
  };
  const options = {
    signal: AbortSignal.any([api.lifecycle.signal, AbortSignal.timeout(5000)]),
  };
  const baseline = async () => {
    const response = await client.config.get({ directory }, options);
    assertCurrent();
    if (response.error !== undefined) {
      throw new SettingsError("Could not read native prompt settings.");
    }
    return readState(response.data, project);
  };
  const state = await baseline();
  const settings = await loadSettings(state.context);
  const current = await compose(state.native, settings);
  const files = [...settings.documents, ...current.reads];
  for (const file of files) {
    const response = await client.file.read(
      { directory, path: relative(directory, file.path) },
      options,
    );
    assertCurrent();
    if (
      response.error !== undefined ||
      response.data.type !== "text" ||
      response.data.content !== file.text
    ) {
      throw new SettingsError(
        "Saved prompt sources do not match this OpenCode server. Reopen the preview on the server machine.",
      );
    }
  }
  if (JSON.stringify(await baseline()) !== JSON.stringify(state)) {
    throw new SettingsError(
      "Prompt runtime changed. Reopen the saved preview.",
    );
  }
  await verifyInventory(settings);
  await verifyReads(files, settings.missing);
  assertCurrent();
  return {
    settings,
    native: state.native,
    current,
    client,
    project,
    directory,
  };
}
