/**
 * Content pages are plain text, never HTML, so editors cannot inject markup (XSS-safe by construction).
 * Format: blank line separates paragraphs; a line starting with "## " is a heading; lines starting with
 * "- " form a bullet list. Pure function, unit-tested.
 */
export type ContentBlock =
  { type: 'h2'; text: string } | { type: 'p'; text: string } | { type: 'ul'; items: string[] };

export function parseContent(body: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const chunk of body.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
    const lines = chunk
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    let paragraph: string[] = [];
    let list: string[] = [];
    const flush = () => {
      if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join(' ') });
      if (list.length) blocks.push({ type: 'ul', items: list });
      paragraph = [];
      list = [];
    };
    for (const line of lines) {
      if (line.startsWith('## ')) {
        flush();
        blocks.push({ type: 'h2', text: line.slice(3).trim() });
      } else if (line.startsWith('- ')) {
        if (paragraph.length) flush();
        list.push(line.slice(2).trim());
      } else {
        if (list.length) flush();
        paragraph.push(line);
      }
    }
    flush();
  }
  return blocks;
}
