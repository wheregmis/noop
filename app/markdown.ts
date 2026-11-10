/** A GFM table's delimiter row ("|---|:--:|", "--- | ---"): dashes with optional colons, cells split by pipes. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * The offsets of the newlines hub text must keep plain because of a GFM table: the ones ending its lines (a header
 * row and a delimiter row, both with a pipe, then the rows up to the first blank line) and the one before its header,
 * which a table interrupts the paragraph at.
 */
function tableNewlines(text: string): Set<number> {
  const keep = new Set<number>();
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let at = 0, i = 0; i < lines.length; at += lines[i].length + 1, i++) starts.push(at);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes("|") || !lines[i + 1].includes("|") || !TABLE_DELIMITER.test(lines[i + 1])) continue;
    let end = i + 1;
    while (end + 1 < lines.length && lines[end + 1].trim() !== "") end++; // body rows run to the first blank line
    if (i > 0) keep.add(starts[i] - 1);
    for (let k = i; k <= end; k++) keep.add(starts[k] + lines[k].length);
    i = end;
  }
  return keep;
}

/** Hub text keeps its line breaks: single newlines become hard breaks, outside code fences and tables. */
export function hubMarkdown(text: string): string {
  return text
    .split(/(^```[\s\S]*?^```)/m)
    .map((part, i) => {
      if (i % 2) return part;
      // A "\\" ending a table row becomes part of its last cell, and on the delimiter row it ends the table.
      const table = tableNewlines(part);
      return part
        // single newlines are hard breaks, except around list items (a "\\" there shows up literally)
        .replace(/([^\n])\n(?!\n|\s*(?:[-*+]|\d+[.)])\s)/g, (m0, c, off, all) => table.has(off + 1) || /^\s*(?:[-*+]|\d+[.)])\s/.test(all.slice(all.lastIndexOf("\n", off) + 1, off + 1)) ? `${c}\n` : `${c}\\\n`)
        // Bare URLs stop at CJK / full-width punctuation and spaces ("pull/1：让" links pull/1 only).
        .replace(/(?<![(<\[`])\bhttps?:\/\/[^\s<>()\[\]`\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]+[^\s<>()\[\]`.,;:!?'"\u3000-\u303f\uff00-\uffef\u2018-\u201f\u4e00-\u9fff]/g, "<$&>");
    })
    .join("");
}
