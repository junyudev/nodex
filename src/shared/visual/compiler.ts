import type { JSXElement, Node, parseSync } from "oxc-parser";
import type { transformSync } from "oxc-transform";
import { characterEntities } from "character-entities";
import {
  VISUAL_LIMITS,
  VISUAL_MODULES,
  visualRowKey,
  type VisualDiagnostic,
  type VisualFigure,
  type VisualRewrite,
  type VisualSpan,
  type VisualTextLiteral,
} from "./contract";
import { visualLocations } from "./locations";
import { applyVisualEdits, literalMembers, unwrapAttribute, type VisualEdit } from "./literals";
import { extractFigure, textByteLength, type FigureSyntax } from "./metadata";

export const VISUAL_FILENAME = "visual.jsx";

type Report = (code: string, message: string, node: VisualSpan) => void;
type Oxc = {
  parseSync: typeof parseSync;
  transformSync: typeof transformSync;
  visitorKeys: Record<string, string[]>;
};

export interface VisualProgram {
  figures: VisualFigure[];
  textLiterals: VisualTextLiteral[];
  datumSpans: VisualSpan[];
}

export type VisualCompilation =
  | { ok: false; diagnostics: VisualDiagnostic[] }
  | {
      ok: true;
      diagnostics: VisualDiagnostic[];
      program: VisualProgram;
      code: string;
      locate: (line: number, column: number) => VisualSpan | undefined;
    };

export type VisualRewriteResult =
  | { ok: false; diagnostics: VisualDiagnostic[] }
  | { ok: true; source: string };

function span({ start, end }: VisualSpan): VisualSpan {
  return { start, end };
}

function fromOxc(
  error: { severity: string; message: string; labels: VisualSpan[] },
  code: string,
): VisualDiagnostic {
  return {
    severity: error.severity === "Error" ? "error" : "warning",
    code,
    message: error.message,
    span: error.labels[0] && span(error.labels[0]),
  };
}

function jsxName(node: JSXElement) {
  const name = node.openingElement.name;
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression" && name.object.type === "JSXIdentifier")
    return `${name.object.name}.${name.property.name}`;
  return "";
}

function elementChildren(node: JSXElement) {
  return node.children.filter(
    (child) =>
      !(child.type === "JSXText" && !child.value.trim()) &&
      !(child.type === "JSXExpressionContainer" && child.expression.type === "JSXEmptyExpression"),
  );
}

function walk(root: Node, visitorKeys: Oxc["visitorKeys"], visit: (node: Node) => void) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    const fields = node as unknown as Record<string, Node | Node[] | undefined>;
    for (const key of visitorKeys[node.type] ?? []) {
      const children = fields[key];
      if (Array.isArray(children)) {
        for (const child of children) if (child) stack.push(child);
      } else if (children) stack.push(children);
    }
  }
}

const networkNames = new Set([
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebTransport",
  "EventSource",
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "RTCIceTransport",
  "RTCPeerConnectionIceEvent",
  "sendBeacon",
  "Worker",
  "SharedWorker",
  "serviceWorker",
  "importScripts",
]);
const colorAttributes = new Set([
  "fill",
  "stroke",
  "color",
  "stopColor",
  "floodColor",
  "lightingColor",
]);
const literalColors =
  /^(?:#[\da-f]{3,8}|(?:rgba?|hsla?|hwb|oklch|oklab|lab|lch|color)\(|[a-z]+$)/iu;
const neutralPaint = /^(?:none|transparent|currentcolor|inherit|context-fill|context-stroke)$/iu;
const externalUrl = /(?:https?:|wss?:|ftp:|file:|^[\s]*\/\/)/iu;
const allowedImports = new Set<string>(VISUAL_MODULES);

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/giu, (full, reference: string) => {
    if (!reference.startsWith("#")) {
      return Object.hasOwn(characterEntities, reference) ? characterEntities[reference] : full;
    }
    const hex = reference[1]?.toLowerCase() === "x";
    const value = Number.parseInt(reference.slice(hex ? 2 : 1), hex ? 16 : 10);
    return value <= 0x10ffff ? String.fromCodePoint(value) : full;
  });
}

function jsxTextValue(raw: string): string {
  const lines = raw.split(/\r\n|\r|\n/u);
  const nonempty = lines.findLastIndex((line) => line.trim());
  return decodeEntities(
    lines
      .map((line, index) => {
        let normalized = line.replaceAll("\t", " ");
        if (index > 0) normalized = normalized.trimStart();
        if (index < lines.length - 1) normalized = normalized.trimEnd();
        return normalized && index < nonempty ? normalized + " " : normalized;
      })
      .join(""),
  );
}

function recordElement(
  node: JSXElement,
  textLiterals: VisualTextLiteral[],
  datumSpans: VisualSpan[],
  edits: VisualEdit[],
  error: Report,
  warn: Report,
) {
  const name = jsxName(node);
  const attributes = node.openingElement.attributes;
  const named = new Map(
    attributes.flatMap((attribute) =>
      attribute.type === "JSXAttribute" && attribute.name.type === "JSXIdentifier"
        ? [[attribute.name.name, unwrapAttribute(attribute.value)] as const]
        : [],
    ),
  );
  const role = named.get("role");
  const label = named.get("aria-label");
  if (
    name === "svg" &&
    (!role ||
      !label ||
      (role.type === "Literal" && role.value !== "img") ||
      (label.type === "Literal" && !String(label.value ?? "").trim()))
  )
    warn("accessible-name", 'Give each SVG role="img" and an aria-label', node.openingElement);
  if (
    ["script", "iframe", "object", "embed", "link", "foreignObject", "form", "meta"].includes(name)
  )
    error("offline", `<${name}> cannot be used in an offline Visual`, node.openingElement);
  for (const [property, value] of literalMembers(named.get("style")) ?? []) {
    if (
      value.type === "Literal" &&
      typeof value.value === "string" &&
      colorAttributes.has(property) &&
      literalColors.test(value.value) &&
      !neutralPaint.test(value.value)
    )
      warn("hard-coded-color", "Use a theme color", value);
  }
  for (const attribute of attributes) {
    if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier") continue;
    const value =
      attribute.value?.type === "JSXExpressionContainer"
        ? attribute.value.expression
        : attribute.value;
    if (value?.type !== "Literal" || typeof value.value !== "string") continue;
    if (
      ["href", "xlinkHref", "src", "srcSet"].includes(attribute.name.name) &&
      externalUrl.test(value.value)
    )
      error("offline", "Visuals cannot load external resources", value);
    if (
      colorAttributes.has(attribute.name.name) &&
      literalColors.test(value.value) &&
      !neutralPaint.test(value.value)
    )
      warn("hard-coded-color", "Use a theme color", value);
  }
  const bind = attributes.find(
    (attribute) =>
      attribute.type === "JSXSpreadAttribute" &&
      attribute.argument.type === "CallExpression" &&
      attribute.argument.callee.type === "Identifier" &&
      attribute.argument.callee.name === "datum",
  );
  if (bind) {
    datumSpans.push(span(node.openingElement));
    edits.push({
      start: bind.end,
      end: bind.end,
      text: ` data-nodex-datum-span="${node.openingElement.start}:${node.openingElement.end}"`,
    });
  }
  if (!["text", "tspan", "textPath"].includes(name)) return;
  for (const child of node.children) {
    const expression = child.type === "JSXExpressionContainer" ? child.expression : undefined;
    const literal =
      child.type === "JSXText"
        ? { ...span(child), kind: "jsx-text" as const, value: jsxTextValue(child.value) }
        : expression?.type === "Literal" && typeof expression.value === "string"
          ? { ...span(expression), kind: "string" as const, value: expression.value }
          : undefined;
    if (!literal?.value.trim()) continue;
    textLiterals.push(literal);
    edits.push({
      ...span(child),
      text: `<tspan data-nodex-text-span="${literal.start}:${literal.end}">{${JSON.stringify(literal.value)}}</tspan>`,
    });
  }
}

function figuresIn(root: JSXElement): JSXElement[] | undefined {
  if (jsxName(root) === "nodex.Visualize") return [root];
  if (jsxName(root) !== "div") return undefined;
  const children = elementChildren(root);
  return children.length &&
    children.every(
      (child): child is JSXElement =>
        child.type === "JSXElement" && jsxName(child) === "nodex.Visualize",
    )
    ? children
    : undefined;
}

function renderCallback(figure: JSXElement) {
  const children = elementChildren(figure);
  if (children.length !== 1 || children[0].type !== "JSXExpressionContainer") return undefined;
  const expression = children[0].expression;
  if (
    (expression.type !== "ArrowFunctionExpression" && expression.type !== "FunctionExpression") ||
    expression.async ||
    expression.generator ||
    !expression.body
  )
    return undefined;
  return expression;
}

export function createVisualCompiler(oxc: Oxc) {
  function analyze(source: string) {
    const diagnostics: VisualDiagnostic[] = [];
    const error: Report = (code, message, at) => {
      diagnostics.push({ code, message, severity: "error", span: span(at) });
    };
    const warn: Report = (code, message, at) => {
      diagnostics.push({ code, message, severity: "warning", span: span(at) });
    };
    const whole = { start: 0, end: source.length };
    if (
      source.length > VISUAL_LIMITS.textBytes ||
      textByteLength(source) > VISUAL_LIMITS.textBytes
    ) {
      error("limits", "Visual source text is limited to 1 MiB", whole);
      return { diagnostics };
    }
    const parsed = oxc.parseSync(VISUAL_FILENAME, source, {
      sourceType: "module",
      showSemanticErrors: true,
    });
    diagnostics.push(...parsed.errors.map((e) => fromOxc(e, "syntax")));
    if (diagnostics.some((entry) => entry.severity === "error")) return { diagnostics };
    const body = parsed.program.body;
    const last = body.at(-1);
    const root =
      last?.type === "ExpressionStatement" && last.expression.type === "JSXElement"
        ? last.expression
        : undefined;
    const figures = root && figuresIn(root);
    if (
      !figures ||
      !root ||
      body.slice(0, -1).some((stmt) => stmt.type !== "ImportDeclaration") ||
      parsed.program.hashbang !== null
    ) {
      error(
        "root",
        "Use one <nodex.Visualize> or a <div> containing Visuals after any imports",
        last ?? whole,
      );
      return { diagnostics };
    }
    for (const entry of parsed.module.staticImports) {
      if (!allowedImports.has(entry.moduleRequest.value))
        error(
          "import",
          `Module ${entry.moduleRequest.value} is unavailable in Visuals`,
          entry.moduleRequest,
        );
    }
    for (const entry of parsed.module.dynamicImports)
      error("import", "Use static imports from the built-in Visual modules", entry);
    for (const comment of parsed.comments) {
      if (/@jsx(?:Runtime|ImportSource|Frag)?\b/u.test(comment.value))
        error("import", "Visuals use the built-in JSX runtime", comment);
    }

    const edits: VisualEdit[] = [
      { start: root.start, end: root.start, text: "export default (nodex) => (" },
      { start: root.end, end: root.end, text: ");" },
    ];
    const syntax: FigureSyntax[] = [];
    const textLiterals: VisualTextLiteral[] = [];
    const datumSpans: VisualSpan[] = [];
    for (const [index, figure] of figures.entries()) {
      const metadata = extractFigure(figure, error);
      const callback = renderCallback(figure);
      if (!callback) error("render", "Pass one synchronous render function as the child", figure);
      if (!metadata || !callback) continue;
      syntax.push(metadata);
      for (const attr of metadata.attributes) edits.push({ ...span(attr), text: "" });
      const nameEnd = figure.openingElement.name.end;
      edits.push({ start: nameEnd, end: nameEnd, text: ` figure={${index}}` });
      const beforeDatum = datumSpans.length;
      walk(callback.body!, oxc.visitorKeys, (node) => {
        if (
          (node.type === "Identifier" && networkNames.has(node.name)) ||
          (node.type === "Literal" &&
            typeof node.value === "string" &&
            networkNames.has(node.value))
        )
          error("offline", "Network and worker APIs are unavailable in Visuals", node);
        if (node.type === "JSXElement")
          recordElement(node, textLiterals, datumSpans, edits, error, warn);
      });
      if (datumSpans.length === beforeDatum)
        warn("missing-datum", "Bind a mark with datum(row, field)", callback);
    }
    if (diagnostics.some((entry) => entry.severity === "error")) return { diagnostics };
    return {
      diagnostics,
      syntax,
      edits,
      program: {
        figures: syntax.map(({ figure }) => figure),
        textLiterals: textLiterals.sort((a, b) => a.start - b.start),
        datumSpans: datumSpans.sort((a, b) => a.start - b.start),
      },
    };
  }

  function compileVisual(source: string): VisualCompilation {
    const { program, diagnostics, edits } = analyze(source);
    if (!program || !edits) return { ok: false, diagnostics };
    const transformed = applyVisualEdits(source, edits);
    const result = oxc.transformSync(VISUAL_FILENAME, transformed, {
      sourcemap: true,
      jsx: { runtime: "automatic", importSource: "react" },
      sourceType: "module",
    });
    const locations = visualLocations(transformed, edits, result.map);
    diagnostics.push(
      ...result.errors.map((e) => {
        const diagnostic = fromOxc(e, "transform");
        if (diagnostic.span) diagnostic.span = locations.instrumented(diagnostic.span);
        return diagnostic;
      }),
    );
    if (diagnostics.some((entry) => entry.severity === "error")) return { ok: false, diagnostics };
    return { ok: true, diagnostics, program, code: result.code, locate: locations.runtime };
  }

  function rewriteVisual(source: string, change: VisualRewrite): VisualRewriteResult {
    const { program, diagnostics, syntax } = analyze(source);
    if (!program || !syntax) return { ok: false, diagnostics };
    const replacements = replacementEdits(program, syntax, change);
    if (!replacements.length)
      return {
        ok: false,
        diagnostics: [
          { severity: "error", code: "rewrite", message: "The Visual literal is unavailable" },
        ],
      };
    const rewritten = applyVisualEdits(source, replacements);
    const validation = analyze(rewritten);
    return validation.program
      ? { ok: true, source: rewritten }
      : { ok: false, diagnostics: validation.diagnostics };
  }

  return { compileVisual, rewriteVisual };
}

function replacementEdits(
  program: VisualProgram,
  syntax: FigureSyntax[],
  change: VisualRewrite,
): VisualEdit[] {
  if (change.kind === "text") {
    const literal = program.textLiterals.find(
      ({ start, end }) => start === change.span.start && end === change.span.end,
    );
    if (!literal) return [];
    const text =
      literal.kind === "string"
        ? JSON.stringify(change.value)
        : `{${JSON.stringify(change.value)}}`;
    return [{ ...span(literal), text }];
  }
  const figure = syntax[change.figure];
  if (!figure) return [];
  if (change.kind === "param") {
    const value = literalMembers(figure.params.get(change.param))?.get("value");
    return value ? [{ ...span(value), text: JSON.stringify(change.value) }] : [];
  }
  const source = figure.figure.sources[change.source];
  const members = literalMembers(figure.sources.get(change.source));
  if (!source || !members || (source.kind !== "data" && source.kind !== "query")) return [];
  const data = members.get("data");
  if (data?.type !== "ArrayExpression") return [];
  if (change.kind === "query") {
    const refreshedAt = members.get("refreshedAt");
    return source.kind === "query" && refreshedAt
      ? [
          { ...span(data), text: JSON.stringify(change.data) },
          { ...span(refreshedAt), text: JSON.stringify(change.refreshedAt) },
        ]
      : [];
  }
  const index = source.data.findIndex(
    (row) => JSON.stringify(visualRowKey(row, source.key)) === JSON.stringify(change.key),
  );
  const field = literalMembers(data.elements[index])?.get(change.field);
  return field ? [{ ...span(field), text: JSON.stringify(change.value) }] : [];
}
