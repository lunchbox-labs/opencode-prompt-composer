/** Code points rendered by one scrollable view. */
export const VIEW_CHARACTERS = 65_536;
/** OpenTUI wraps each line as a whole: long lines wrap slowly and stop near 65,535 columns. */
export const VIEW_LINE_CHARACTERS = 4096;

/**
 * Split text into bounded views that end at line breaks unless one line is too long.
 * Joining the views preserves every composed character.
 */
export function previewParts(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let lineStart = 0;
  let end = 0;
  let characters = 0;
  let line = 0;
  for (const character of text) {
    // Start a new view only when this code point would exceed a limit.
    if (character !== "\n" && line === VIEW_LINE_CHARACTERS) {
      parts.push(text.slice(start, end));
      start = lineStart = end;
      characters = line = 0;
    } else if (characters === VIEW_CHARACTERS) {
      // Lines are shorter than views, so this view contains a line break.
      parts.push(text.slice(start, lineStart));
      start = lineStart;
      characters = line;
    }
    end += character.length;
    characters++;
    if (character === "\n") {
      lineStart = end;
      line = 0;
    } else {
      line++;
    }
  }
  parts.push(text.slice(start));
  return parts;
}
