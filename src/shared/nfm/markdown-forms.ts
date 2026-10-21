/**
 * The Markdown forms Nested Markdown reads besides its canonical ones, and the escapes that keep
 * a paragraph from being read as one of them. The Rust parser in `nodex-core` implements the same
 * rules; `crates/nodex-core/tests/fixtures/nfm/markdown-input.json` holds both to them.
 */

/** A list item: `-`, `*` or `+` bullets, and `1.` or `1)` numbers, each followed by a space. */
const LIST_ITEM = /^(?:[-*+] |\d+[.)]\s)/;

const leadingTabs = (line: string): number => line.length - line.replace(/^\t+/, "").length;

/**
 * Lines inside code and equation fences are literal, so list indentation never applies there.
 * Returns the index of the line that closes a fence opened at `index`, or -1.
 */
function fenceEnd(lines: readonly string[], index: number): number {
  const tabs = leadingTabs(lines[index]!);
  const content = lines[index]!.slice(tabs);
  const code = /^(`{3,}|~{3,})/.exec(content);
  if (code) {
    const marker = code[1]!;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const closing = lines[cursor]!.slice(tabs).trimEnd();
      if (closing.length >= marker.length && closing.replaceAll(marker[0]!, "") === "")
        return cursor;
    }
    return lines.length - 1;
  }
  const math = content.trimEnd();
  if (math.length >= 2 && /^\$+$/.test(math)) {
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor]!.slice(tabs).trimEnd() === math) return cursor;
    }
  }
  return -1;
}

/**
 * Nests lines indented with spaces under list items, as Markdown does: a list item indented more
 * than the list item before it becomes that item's child, one indented the same is its sibling,
 * and any other line indented under a list item continues that item as its child Block. A list
 * item with no list item before it stays at its tab depth, and any other line without one keeps
 * its leading spaces as text. Tabs keep their canonical meaning. Lines are rewritten one for one.
 */
export function nestSpaceIndentedListItems(lines: readonly string[]): string[] {
  const output = [...lines];
  let open: { column: number; depth: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const end = fenceEnd(lines, index);
    if (end !== -1) {
      open = [];
      index = end;
      continue;
    }
    const line = lines[index]!;
    const tabs = leadingTabs(line);
    const rest = line.slice(tabs);
    const body = rest.trimStart();
    if (body === "") continue;
    const spaces = rest.length - body.length;
    const column = tabs * 4 + spaces;
    if (!LIST_ITEM.test(body)) {
      if (spaces === 0) {
        if (tabs === 0) open = [];
        continue;
      }
      while (open.length > 0 && open[open.length - 1]!.column >= column) open.pop();
      const item = open[open.length - 1];
      if (item) output[index] = "\t".repeat(item.depth + 1) + body;
      continue;
    }
    while (open.length > 0 && open[open.length - 1]!.column > column) open.pop();
    const top = open[open.length - 1];
    const depth =
      spaces === 0 || top === undefined ? tabs : top.column === column ? top.depth : top.depth + 1;
    if (top?.column === column) open.pop();
    open.push({ column, depth });
    if (spaces > 0) output[index] = "\t".repeat(depth) + body;
  }
  return output;
}

/**
 * Escapes the start of a paragraph line that would otherwise be read as a Block marker or as
 * indentation, so the text stays a paragraph as written: `\- not a list`, `1\. not a list`,
 * `\# not a heading`, `\---`, and `\  indented text`. Characters that are escaped everywhere,
 * such as `*`, `>` and `|`, need nothing more.
 */
export function protectParagraphStart(text: string): string {
  if (/^[ \t]/.test(text)) return `\\${text}`;
  if (text.trim() === "---") return text.replace("-", "\\-");
  const number = /^(\d+)([.)])(?=\s|$)/.exec(text);
  if (number) return `${number[1]}\\${text.slice(number[1]!.length)}`;
  if (/^(?:[-+](?= |$)|#{1,4}[ \t]|[▶▼])/.test(text)) return `\\${text}`;
  return text;
}

/** Reads a paragraph line's start escape back: `\- x` is the text `- x`. */
export function unprotectParagraphStart(text: string): string {
  return text.replace(/^( *)\\([ \t\-+#▶▼])/, "$1$2").replace(/^( *\d+)\\([.)])/, "$1$2");
}
