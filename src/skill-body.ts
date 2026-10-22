import { SettingsError } from "./errors.ts";

const END = "\n</skill_files>\n</skill_content>";

function invalidFraming(): never {
  throw new SettingsError(
    "The skill output has unknown or incomplete framing. Its body cannot be composed safely.",
  );
}

// OpenCode's V1 skill tool (1.19.0 and 1.19.3) supplies name/dir metadata,
// but no structured body. Match its complete framing without rereading a
// possibly changed, cached, or built-in SKILL.md.
export async function expandSkillBody(
  output: string,
  metadata: unknown,
  expand: (body: string) => Promise<string>,
): Promise<string> {
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "truncated" in metadata &&
    metadata.truncated === true
  ) {
    throw new SettingsError(
      "The skill output was truncated before composition. Reduce its size and load it again.",
    );
  }
  if (!output.includes("{{include:")) {
    return output;
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("name" in metadata) ||
    typeof metadata.name !== "string" ||
    metadata.name.length === 0 ||
    metadata.name.includes("\0") ||
    !("dir" in metadata) ||
    typeof metadata.dir !== "string" ||
    metadata.dir.length === 0 ||
    metadata.dir.includes("\0")
  ) {
    throw new SettingsError(
      "The skill output is missing valid native name/dir metadata. Its body cannot be composed safely.",
    );
  }
  const prefix = `<skill_content name="${metadata.name}">\n# Skill: ${metadata.name}\n\n`;
  // Native built-in skills use ".". The directory is framing text, not a path
  // used for include resolution; preserve it exactly as the host emitted it.
  const footer = [
    "",
    "",
    `Base directory for this skill: ${metadata.dir}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>\n",
  ].join("\n");
  if (!output.startsWith(prefix) || !output.endsWith(END)) {
    invalidFraming();
  }
  let boundary: number | undefined;
  const filesEnd = output.length - END.length;
  for (
    let candidate = output.indexOf(footer, prefix.length);
    candidate !== -1;
    candidate = output.indexOf(footer, candidate + 1)
  ) {
    const filesStart = candidate + footer.length;
    if (filesStart > filesEnd) {
      continue;
    }
    const files = output.slice(filesStart, filesEnd);
    // Filenames are not XML-escaped and can contain tags or newlines. A
    // nonempty list may be one such filename; never choose the first footer
    // when another complete decomposition is possible.
    if (
      files !== "" &&
      !(files.startsWith("<file>") && files.endsWith("</file>"))
    ) {
      continue;
    }
    if (boundary !== undefined) {
      throw new SettingsError(
        "The skill output has ambiguous body framing. Its body cannot be composed safely.",
      );
    }
    boundary = candidate;
  }
  if (boundary === undefined) {
    invalidFraming();
  }
  const body = output.slice(prefix.length, boundary);
  if (!body.includes("{{include:")) {
    return output;
  }
  return (
    output.slice(0, prefix.length) +
    (await expand(body)) +
    output.slice(boundary)
  );
}
