export const MAX_CODE_POINTS_PER_VIEW = 65_536;
/** OpenTUI wraps each line as a whole: long lines wrap slowly and stop near 65,535 columns. */
export const MAX_CODE_POINTS_PER_VIEW_LINE = 4096;

/**
 * Split text into bounded views that end at line breaks unless one line is too long.
 * Joining the views preserves every composed character.
 */
export function previewParts(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let lineStart = 0;
  let end = 0;
  let viewCodePoints = 0;
  let lineCodePoints = 0;
  for (const character of text) {
    const characterOverflowsLine =
      character !== "\n" && lineCodePoints === MAX_CODE_POINTS_PER_VIEW_LINE;
    const characterOverflowsView = viewCodePoints === MAX_CODE_POINTS_PER_VIEW;
    if (characterOverflowsLine) {
      parts.push(text.slice(start, end));
      start = lineStart = end;
      viewCodePoints = lineCodePoints = 0;
    } else if (characterOverflowsView) {
      // Lines are shorter than views, so this view contains a line break.
      parts.push(text.slice(start, lineStart));
      start = lineStart;
      viewCodePoints = lineCodePoints;
    }
    end += character.length;
    viewCodePoints++;
    if (character === "\n") {
      lineStart = end;
      lineCodePoints = 0;
    } else {
      lineCodePoints++;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
