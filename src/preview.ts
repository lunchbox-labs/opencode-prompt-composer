/** Small native alert pages; joining them preserves every composed character. */
export function previewPages(text: string): string[] {
  const pages: string[] = [];
  let page = "";
  let characters = 0;
  let newlines = 0;
  for (const character of text) {
    page += character;
    characters++;
    if (character === "\n") {
      newlines++;
    }
    if (characters === 240 || newlines === 6) {
      pages.push(page);
      page = "";
      characters = 0;
      newlines = 0;
    }
  }
  if (page !== "" || pages.length === 0) {
    pages.push(page);
  }
  return pages;
}
