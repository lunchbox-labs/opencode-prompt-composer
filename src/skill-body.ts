import { diagnosticName } from "./errors.ts";
import { type SkippedInclude, hasIncludeMarker } from "./include-core.ts";
import { errorMessage, firstProblem } from "./notices.ts";

const END = "\n</skill_files>\n</skill_content>";
const UNKNOWN_FRAMING =
  "The skill output has unknown or incomplete framing. Its includes were not expanded.";

/** `details` repeats the reason with every problem, for the server log. */
export type SkillNotice = (reason: string, details?: string) => void;

// OpenCode's V1 skill tool (1.19.0 and 1.19.3) supplies name/dir metadata,
// but no structured body. Match its complete framing without rereading a
// possibly changed, cached, or built-in SKILL.md. Output that cannot be
// composed keeps its native text and reports why, so the skill still loads.
export async function expandSkillBody(
  output: string,
  metadata: unknown,
  expand: (
    body: string,
    consumer: string,
    skip: SkippedInclude,
  ) => Promise<string>,
  notify?: SkillNotice,
): Promise<string> {
  if (!hasIncludeMarker(output)) {
    return output;
  }
  const unchanged = (reason: string): string => {
    notify?.(reason);
    return output;
  };
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "truncated" in metadata &&
    metadata.truncated === true
  ) {
    const skill =
      "name" in metadata && typeof metadata.name === "string"
        ? `Skill ${diagnosticName(metadata.name)}`
        : "The skill";
    return unchanged(
      `${skill} output was truncated, so its includes were not expanded. Reduce the skill's size to compose it.`,
    );
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
    return unchanged(
      "The skill output is missing valid native name/dir metadata. Its includes were not expanded.",
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
    return unchanged(UNKNOWN_FRAMING);
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
      return unchanged(
        "The skill output has ambiguous body framing. Its includes were not expanded.",
      );
    }
    boundary = candidate;
  }
  if (boundary === undefined) {
    return unchanged(UNKNOWN_FRAMING);
  }
  const body = output.slice(prefix.length, boundary);
  if (!hasIncludeMarker(body)) {
    return output;
  }
  const consumer = `skill ${diagnosticName(metadata.name)}`;
  const skill = `Skill ${diagnosticName(metadata.name)}`;
  const problems: string[] = [];
  let expanded: string;
  try {
    expanded = await expand(body, consumer, (problem) =>
      problems.push(problem),
    );
  } catch (error) {
    return unchanged(
      `${skill} includes were not expanded. ${errorMessage(error)}`,
    );
  }
  // A skill left with no text would load as an empty instruction.
  const emptied = problems.length > 0 && expanded.trim() === "";
  if (emptied) {
    problems.push("Nothing else was left, so its native text was kept.");
  }
  if (problems.length > 0) {
    const reason = `${skill} has includes that were not expanded.`;
    notify?.(
      `${reason} ${firstProblem(problems)}`,
      [reason, ...problems].join("\n- "),
    );
  }
  if (emptied) {
    return output;
  }
  return output.slice(0, prefix.length) + expanded + output.slice(boundary);
}
