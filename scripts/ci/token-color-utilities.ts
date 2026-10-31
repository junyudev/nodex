import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { transform } from "lightningcss";
import { Visitor, type Node } from "oxc-parser";

import { parseTypeScriptSource, sourcePosition, type SourcePosition } from "../lib/oxc-source";

export interface TokenColorUsage extends SourcePosition {
  readonly candidate: string;
  readonly path: string;
}

const classNamePattern = /class(?:names?)?$|classes$|styles?$|chrome$|palette$/i;
const classHelpers = new Set(["cn", "clsx", "classNames", "cx", "cva", "twMerge", "twJoin"]);

const nodeName = (node: Node | null | undefined): string | undefined => {
  if (node?.type === "Identifier" || node?.type === "JSXIdentifier") return node.name;
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "MemberExpression") return nodeName(node.property);
  return undefined;
};

/** Only class-bearing syntax is inspected; prose, selectors and comments are not class sources. */
export function extractClassCandidates(path: string, source: string): TokenColorUsage[] {
  if (!source.includes("token-")) return [];
  const program = parseTypeScriptSource(path, source);
  const bindings = new Map<string, Node[]>();
  const roots: Node[] = [];
  const candidates = new Map<number, TokenColorUsage>();
  const visited = new Set<Node>();
  const visitedMembers = new Map<string, Set<Node>>();

  const bind = (name: string | undefined, node: Node | null | undefined): void => {
    if (!name || !node) return;
    bindings.set(name, [...(bindings.get(name) ?? []), node]);
    if (classNamePattern.test(name)) roots.push(node);
  };

  new Visitor({
    VariableDeclarator(node) {
      bind(nodeName(node.id), node.init);
    },
    FunctionDeclaration(node) {
      bind(node.id?.name, node.body);
    },
    JSXAttribute(node) {
      if (classNamePattern.test(nodeName(node.name) ?? "") && node.value) roots.push(node.value);
    },
    Property(node) {
      if (classNamePattern.test(nodeName(node.key) ?? "")) roots.push(node.value);
    },
    AssignmentExpression(node) {
      if (classNamePattern.test(nodeName(node.left) ?? "")) roots.push(node.right);
    },
    CallExpression(node) {
      const name = nodeName(node.callee);
      if (name && classHelpers.has(name)) roots.push(...node.arguments);
      if (node.callee.type !== "MemberExpression") return;
      if (nodeName(node.callee.object) === "classList") roots.push(...node.arguments);
      if (name === "setAttribute" && nodeName(node.arguments[0]) === "class") {
        roots.push(...node.arguments.slice(1));
      }
    },
  }).visit(program);

  const add = (text: string, offset: number, partialStart = false, partialEnd = false): void => {
    for (const match of text.matchAll(/\S+/gu)) {
      if (partialStart && match.index === 0) continue;
      if (partialEnd && match.index + match[0].length === text.length) continue;
      if (!match[0].includes("token-")) continue;
      const start = offset + match.index;
      candidates.set(start, { candidate: match[0], path, ...sourcePosition(source, start) });
    }
  };

  const collect = (node: Node | null | undefined): void => {
    if (!node || visited.has(node)) return;
    visited.add(node);
    switch (node.type) {
      case "Literal":
        if (typeof node.value === "string") add(node.value, node.start + 1);
        return;
      case "Identifier":
        bindings.get(node.name)?.forEach(collect);
        return;
      case "TemplateLiteral":
        node.quasis.forEach((quasi, index) => {
          add(quasi.value.raw, quasi.start, index > 0, index < node.quasis.length - 1);
        });
        node.expressions.forEach(collect);
        return;
      case "BinaryExpression":
        if (node.operator !== "+") return;
        // A concatenated edge is not a complete Tailwind candidate.
        for (const [part, left, right] of [
          [node.left, false, true],
          [node.right, true, false],
        ] as const) {
          if (part.type === "Literal" && typeof part.value === "string") {
            add(part.value, part.start + 1, left, right);
          }
        }
        return;
      case "ConditionalExpression":
        collect(node.consequent);
        collect(node.alternate);
        return;
      case "LogicalExpression":
        collect(node.left);
        collect(node.right);
        return;
      case "ArrayExpression":
        node.elements.forEach(collect);
        return;
      case "ObjectExpression":
        for (const property of node.properties) {
          if (property.type === "SpreadElement") {
            collect(property.argument);
            continue;
          }
          if (!property.computed && property.key.type === "Literal") collect(property.key);
          collect(property.value);
        }
        return;
      case "MemberExpression":
        collectMember(
          node.object,
          node.computed
            ? nodeName(node.property.type === "Literal" ? node.property : undefined)
            : nodeName(node.property),
        );
        return;
      case "CallExpression":
        if (classHelpers.has(nodeName(node.callee) ?? "")) node.arguments.forEach(collect);
        collect(node.callee);
        return;
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        collect(node.body);
        return;
      case "BlockStatement":
        node.body.forEach(collect);
        return;
      case "IfStatement":
        collect(node.consequent);
        collect(node.alternate);
        return;
      case "ReturnStatement":
      case "SpreadElement":
        collect(node.argument);
        return;
      case "JSXExpressionContainer":
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "ParenthesizedExpression":
        collect(node.expression);
        return;
    }
  };

  // Select named fields before following a table, so its labels and other
  // metadata do not become class sources merely because one field is a class.
  const collectMember = (object: Node, name: string | undefined): void => {
    if (!name) {
      collect(object);
      return;
    }
    const seen = visitedMembers.get(name) ?? new Set<Node>();
    if (seen.has(object)) return;
    seen.add(object);
    visitedMembers.set(name, seen);
    if (object.type === "Identifier") {
      bindings.get(object.name)?.forEach((value) => collectMember(value, name));
      return;
    }
    if (object.type === "TSAsExpression" || object.type === "TSSatisfiesExpression") {
      collectMember(object.expression, name);
      return;
    }
    if (object.type !== "ObjectExpression") {
      collect(object);
      return;
    }
    for (const property of object.properties) {
      if (property.type === "SpreadElement") collectMember(property.argument, name);
      else if (nodeName(property.key) === name) collect(property.value);
    }
  };

  roots.forEach(collect);
  return [...candidates.values()].sort(
    (left, right) => left.line - right.line || left.column - right.column,
  );
}

/** Read real selectors, including escaped variants, without mistaking comments for definitions. */
export function explicitCssClasses(
  stylesheets: readonly { path: string; css: string }[],
): Set<string> {
  const classes = new Set<string>();
  for (const { path, css } of stylesheets) {
    transform({
      filename: path,
      code: Buffer.from(css),
      // Lightning CSS does not understand Tailwind's @import source(...) extension.
      errorRecovery: true,
      visitor: {
        Selector(selector) {
          for (const component of selector) {
            if (component.type === "class") classes.add(component.name);
          }
        },
      },
    });
  }
  return classes;
}

/** Keep Tailwind's unstable API isolated here and cover it with compiler-backed tests. */
export async function createTokenColorValidator(
  css: string,
  base: string,
  explicitClasses: ReadonlySet<string>,
) {
  const design = await __unstable__loadDesignSystem(css, { base });
  // Ask this installed Tailwind version which utilities accept colors, including
  // directional borders, inset rings/shadows, masks, scrollbars and future additions.
  const probe = "token-color-guard-probe";
  const colorDesign = await __unstable__loadDesignSystem(`@theme { --color-${probe}: #123456; }`, {
    base,
  });
  const colorRoots = new Set(
    colorDesign
      .getClassList()
      .map(([name]) => name)
      .filter((name) => name.endsWith(`-${probe}`))
      .map((name) => name.slice(0, -probe.length - 1)),
  );

  return (usages: readonly TokenColorUsage[]): TokenColorUsage[] => {
    const candidates = [...new Set(usages.map(({ candidate }) => candidate))].filter(
      (candidate) =>
        !explicitClasses.has(candidate) &&
        design
          .parseCandidate(candidate)
          .some(
            (parsed) =>
              parsed.kind === "functional" &&
              colorRoots.has(parsed.root) &&
              parsed.value?.kind === "named" &&
              /^token-[\w-]+$/.test(parsed.value.value),
          ),
    );
    const generated = design.candidatesToCss(candidates);
    const missing = new Set(candidates.filter((_, index) => generated[index] === null));
    return usages.filter(({ candidate }) => missing.has(candidate));
  };
}
