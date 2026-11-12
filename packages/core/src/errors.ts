export class SettingsError extends Error {
  override name = "PromptComposerError";
}

// JSON quoting keeps identifiers on one diagnostic line; cap untrusted names.
export function diagnosticName(value: string): string {
  return JSON.stringify(
    value.length > 160 ? `${value.slice(0, 157)}...` : value,
  );
}

export function sourcePosition(text: string, offset: number): string {
  const lines = text.slice(0, offset).split(/\r\n|\r|\n/);
  return `${lines.length}:${(lines.at(-1)?.length ?? 0) + 1}`;
}
