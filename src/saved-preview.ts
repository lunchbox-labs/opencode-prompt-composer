import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import { verifyInventory, verifyReads } from "./editor.ts";
import { SettingsError } from "./errors.ts";
import { compose } from "./runtime.ts";
import { readState } from "./runtime-state.ts";
import { loadSettings } from "./settings.ts";
import { verifyFilesystem } from "./filesystem.ts";

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
  await verifyFilesystem(state.context, state.filesystem);
  const settings = await loadSettings(state.context);
  const current = await compose(state.native, settings);
  const files = [...settings.documents, ...current.reads];
  if (JSON.stringify(await baseline()) !== JSON.stringify(state)) {
    throw new SettingsError(
      "Prompt runtime changed. Reopen the saved preview.",
    );
  }
  await verifyInventory(settings);
  await verifyReads(files, settings.missing);
  await verifyFilesystem(state.context, state.filesystem);
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
