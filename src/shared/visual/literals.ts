import type { Expression, JSXAttributeValue, Node, Span } from "oxc-parser";
import { isVisualScalar, type VisualValue } from "./contract";

export function literalMembers(node: Node | null | undefined) {
  if (node?.type !== "ObjectExpression") return undefined;
  const members = new Map<string, Expression>();
  for (const property of node.properties) {
    if (
      property.type !== "Property" ||
      property.computed ||
      property.kind !== "init" ||
      property.method ||
      property.shorthand
    )
      return undefined;
    const key =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" && typeof property.key.value === "string"
          ? property.key.value
          : undefined;
    if (key === undefined || key === "__proto__" || members.has(key)) return undefined;
    members.set(key, property.value);
  }
  return members;
}

/** Only JSON-shaped literals are evaluated here. No source executes in the host. */
export function readLiteral(node: Node | null | undefined, depth = 0): VisualValue | undefined {
  if (!node || depth > 32) return undefined;
  if (node.type === "Literal" && isVisualScalar(node.value)) return node.value;
  if (
    node.type === "UnaryExpression" &&
    node.operator === "-" &&
    node.argument.type === "Literal" &&
    typeof node.argument.value === "number" &&
    Number.isFinite(node.argument.value)
  )
    return -node.argument.value;
  if (node.type === "ArrayExpression") {
    const values = node.elements.map((element) => readLiteral(element, depth + 1));
    return values.every((value) => value !== undefined) ? values : undefined;
  }
  const members = literalMembers(node);
  if (!members) return undefined;
  const entries = [...members].map(([key, value]) => [key, readLiteral(value, depth + 1)] as const);
  if (entries.some((entry) => entry[1] === undefined)) return undefined;
  return Object.fromEntries(entries) as Record<string, VisualValue>;
}

export function unwrapAttribute(value: JSXAttributeValue | null) {
  return value?.type === "JSXExpressionContainer" ? value.expression : value;
}

export interface VisualEdit extends Span {
  text: string;
}

export function applyVisualEdits(source: string, edits: readonly VisualEdit[]): string {
  const chunks: string[] = [];
  let offset = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (edit.start < offset || edit.end < edit.start || edit.end > source.length)
      throw new Error("Invalid Visual edit span");
    chunks.push(source.slice(offset, edit.start), edit.text);
    offset = edit.end;
  }
  chunks.push(source.slice(offset));
  return chunks.join("");
}
