import type { List, ListItem, Nodes, Root } from "mdast";

function itemText(item: ListItem, source: string): string {
  const text = item.position
    ? source.slice(item.position.start.offset, item.position.end.offset)
    : "";
  return text.trimEnd();
}

function repairLists(children: Root["children"] | ListItem["children"], source: string): void {
  let index = 0;
  while (index + 1 < children.length) {
    const ordered = children[index];
    const unordered = children[index + 1];
    const continuation = children[index + 2];
    if (
      ordered?.type !== "list" ||
      !ordered.ordered ||
      unordered?.type !== "list" ||
      unordered.ordered
    ) {
      index += 1;
      continue;
    }
    const last = ordered.children.at(-1);
    if (!last) {
      index += 1;
      continue;
    }
    if (continuation?.type === "list" && continuation.ordered) {
      last.children.push(unordered);
      if (last.position && unordered.position) last.position.end = unordered.position.end;
      if (ordered.position && continuation.position)
        ordered.position.end = continuation.position.end;
      ordered.children.push(...continuation.children);
      children.splice(index + 1, 2);
      continue;
    }
    if (unordered.children.length >= 2 || itemText(last, source).endsWith(":")) {
      last.children.push(unordered);
      if (last.position && unordered.position) last.position.end = unordered.position.end;
      if (ordered.position && unordered.position) ordered.position.end = unordered.position.end;
      children.splice(index + 1, 1);
      continue;
    }
    index += 1;
  }
}
function normalizeListHeadings(list: List, source: string): void {
  for (const item of list.children) {
    const first = item.children[0];
    if (first?.type !== "heading") continue;
    const raw = first.position
      ? source.slice(first.position.start.offset, first.position.end.offset)
      : "";
    const prefix = raw.match(/^#{1,6}\s+/u)?.[0];
    if (!prefix) continue;
    item.children[0] = {
      type: "paragraph",
      children: [{ type: "text", value: prefix }, ...first.children],
      position: first.position,
    };
  }
}

/** List continuation is normalized on newly parsed trees before they become immutable cache values. */
export function postprocessMarkdownSyntax(
  root: Root,
  source: string,
  normalizeLists: boolean,
): void {
  const visit = (node: Nodes): void => {
    if (
      node.type === "root" ||
      node.type === "listItem" ||
      node.type === "blockquote" ||
      node.type === "containerDirective"
    ) {
      if (normalizeLists) repairLists(node.children, source);
    }
    if (node.type === "list") normalizeListHeadings(node, source);
    if ("children" in node) node.children.forEach(visit);
  };
  visit(root);
}
