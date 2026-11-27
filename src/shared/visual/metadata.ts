import type { Expression, JSXAttribute, JSXElement, Node } from "oxc-parser";
import {
  isVisualRow,
  isVisualScalar,
  validateVisualKeys,
  VISUAL_LIMITS,
  type VisualFigure,
  type VisualParam,
  type VisualSource,
  type VisualValue,
} from "./contract";
import { literalMembers, readLiteral, unwrapAttribute } from "./literals";

export const textByteLength = (text: string) => new TextEncoder().encode(text).byteLength;

function isKey(value: VisualValue | undefined): value is VisualSource["key"] {
  if (typeof value === "string") return value.length > 0;
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((column) => typeof column === "string" && column.length > 0) &&
    new Set(value).size === value.length
  );
}

function isIsoTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseSource(value: VisualValue | undefined): VisualSource | string {
  if (!isVisualRow(value) || !isKey(value.key)) return "Declare a key column or columns";
  const { kind, key, data, sql, refreshedAt, file, format, block, header } = value;
  if (
    kind === "file" &&
    typeof file === "string" &&
    file &&
    (format === "csv" || format === "json")
  )
    return { kind, key, file, format };
  if (kind === "table" && typeof block === "string" && block && header === true)
    return { kind, key, block, header };
  if (kind !== "data" && kind !== "query")
    return "Declare a valid data, query, file or table source";
  if (!Array.isArray(data) || !data.every(isVisualRow)) return "Expected an array of row literals";
  if (
    data.length > VISUAL_LIMITS.inlineRows ||
    textByteLength(JSON.stringify(data)) > VISUAL_LIMITS.inlineBytes
  )
    return "Inline results are limited to 2,000 rows and 256 KiB. Use a Page File for larger data";
  const keyError = validateVisualKeys(data, key);
  if (keyError) return keyError;
  if (kind === "data") return { kind, key, data };
  if (typeof sql === "string" && sql.trim() && isIsoTime(refreshedAt))
    return { kind, key, sql, data, refreshedAt };
  return "Declare SQL and an ISO refreshedAt for the query result";
}

function parseParam(value: VisualValue | undefined): VisualParam | undefined {
  if (!isVisualRow(value)) return undefined;
  if (value.kind === "toggle" && typeof value.value === "boolean")
    return { kind: "toggle", value: value.value };
  if (
    value.kind === "select" &&
    Array.isArray(value.options) &&
    value.options.every(isVisualScalar) &&
    isVisualScalar(value.value) &&
    value.options.includes(value.value)
  )
    return { kind: "select", options: value.options, value: value.value };
  if (value.kind !== "range") return undefined;
  const { min, max, step, value: current } = value;
  if (
    typeof min !== "number" ||
    typeof max !== "number" ||
    typeof current !== "number" ||
    min > current ||
    current > max ||
    (step !== undefined && (typeof step !== "number" || step <= 0))
  )
    return undefined;
  return step === undefined
    ? { kind: "range", min, max, value: current }
    : { kind: "range", min, max, step, value: current };
}

const reservedSources = new Set(["datum", "params", "theme"]);

export interface FigureSyntax {
  figure: VisualFigure;
  attributes: JSXAttribute[];
  sources: Map<string, Expression>;
  params: Map<string, Expression>;
}

export function extractFigure(
  node: JSXElement,
  report: (code: string, message: string, node: Node) => void,
): FigureSyntax | undefined {
  const attributes: JSXAttribute[] = [];
  const byName = new Map<string, JSXAttribute>();
  for (const attr of node.openingElement.attributes) {
    if (
      attr.type !== "JSXAttribute" ||
      attr.name.type !== "JSXIdentifier" ||
      !["caption", "sources", "params"].includes(attr.name.name) ||
      byName.has(attr.name.name)
    ) {
      report("props", "Visualize takes one caption, sources and params prop", attr);
      continue;
    }
    attributes.push(attr);
    byName.set(attr.name.name, attr);
  }
  const captionAttr = byName.get("caption");
  const caption = readLiteral(unwrapAttribute(captionAttr?.value ?? null));
  if (typeof caption !== "string" || !caption.trim())
    report("caption", "Provide a caption as a nonempty string literal", captionAttr ?? node);

  const sourceAttr = byName.get("sources");
  const paramAttr = byName.get("params");
  const sources = literalMembers(unwrapAttribute(sourceAttr?.value ?? null));
  const params = literalMembers(unwrapAttribute(paramAttr?.value ?? null));
  if (!sources) report("sources", "Declare sources as an object literal", sourceAttr ?? node);
  if (!params) report("params", "Declare params as an object literal", paramAttr ?? node);
  if (!sources || !params || typeof caption !== "string") return undefined;

  const sourceEntries = [...sources].flatMap(([name, literal]): [string, VisualSource][] => {
    const parsed = parseSource(readLiteral(literal));
    if (!reservedSources.has(name) && typeof parsed !== "string") return [[name, parsed]];
    report("source", reservedSources.has(name) ? `${name} is reserved` : String(parsed), literal);
    return [];
  });
  const paramEntries = [...params].flatMap(([name, literal]): [string, VisualParam][] => {
    const parsed = parseParam(readLiteral(literal));
    if (parsed) return [[name, parsed]];
    report("param", `Provide a valid literal range, select or toggle for ${name}`, literal);
    return [];
  });
  return {
    figure: {
      caption,
      sources: Object.fromEntries(sourceEntries),
      params: Object.fromEntries(paramEntries),
    },
    attributes,
    sources,
    params,
  };
}
