import path from "node:path";
import { parseSync, type ParseResult } from "oxc-parser";

interface AstNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

/** The module script the renderer document loads first. */
export function rendererHtmlEntry(html: string): string | undefined {
  return html.match(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/u)?.[1];
}

/** Parse emitted JavaScript; a parse failure must never read as a module without dependencies. */
function parseEmittedJavaScript(
  file: string,
  source: string,
  sourceType: "module" | "commonjs",
): ParseResult {
  const result = parseSync(file, source, { lang: "js", sourceType });
  const errors = result.errors.filter((error) => String(error.severity) === "Error");
  if (errors.length === 0) return result;
  throw new Error(
    [`Unable to parse ${file}:`, ...errors.map((error) => error.codeframe ?? error.message)].join(
      "\n",
    ),
  );
}

function staticEdges(result: ParseResult): readonly { start: number; specifier: string }[] {
  const { module } = result;
  return [
    ...module.staticImports.map((statement) => ({
      start: statement.start,
      specifier: statement.moduleRequest.value,
    })),
    ...module.staticExports.flatMap((statement) => {
      const request = statement.entries.find((entry) => entry.moduleRequest)?.moduleRequest;
      return request ? [{ start: statement.start, specifier: request.value }] : [];
    }),
  ].sort((left, right) => left.start - right.start);
}

export interface EmittedModuleImports {
  /** Import and re-export sources in source order, independent of formatting and minification. */
  readonly staticImports: readonly string[];
  readonly dynamicImports: readonly string[];
}

export function emittedModuleImports(file: string, source: string): EmittedModuleImports {
  const result = parseEmittedJavaScript(file, source, "module");
  return {
    staticImports: [...new Set(staticEdges(result).map((edge) => edge.specifier))],
    dynamicImports: result.module.dynamicImports.flatMap((expression) => {
      const request = source.slice(expression.moduleRequest.start, expression.moduleRequest.end);
      const specifier = /^(["'`])([^"'`$\\]+)\1$/u.exec(request)?.[2];
      return specifier ? [specifier] : [];
    }),
  };
}

/** Visit AST nodes in source order; returning false from `visit` skips that node's children. */
function visitAst(root: unknown, visit: (node: AstNode) => boolean | void): void {
  const pending = [root];
  const pushReversed = (values: readonly unknown[]) => {
    for (let index = values.length - 1; index >= 0; index -= 1) pending.push(values[index]);
  };
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pushReversed(value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const node = value as AstNode;
    if (typeof node.type === "string" && visit(node) === false) continue;
    pushReversed(Object.values(node));
  }
}

function stringValue(node: unknown): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const candidate = node as AstNode;
  if (candidate.type === "Literal" && typeof candidate.value === "string") return candidate.value;
  if (candidate.type !== "TemplateLiteral") return undefined;
  const quasis = candidate.quasis as readonly { value: { cooked: string | null } }[];
  const expressions = candidate.expressions as readonly unknown[];
  return expressions.length === 0 && quasis.length === 1
    ? (quasis[0]?.value.cooked ?? undefined)
    : undefined;
}

function isMapDepsCall(node: unknown): node is AstNode {
  if (!node || typeof node !== "object") return false;
  const candidate = node as AstNode;
  const callee = candidate.callee as AstNode | undefined;
  return (
    candidate.type === "CallExpression" &&
    callee?.type === "Identifier" &&
    callee.name === "__vite__mapDeps"
  );
}

/**
 * Read the stylesheet and module dependencies Vite preloads with each dynamic import.
 * Vite emits one `__vite__mapDeps` table per chunk and passes an index list next to each
 * `import()`; the paths are relative to the importing chunk.
 */
export function dynamicImportPreloads(
  file: string,
  source: string,
): ReadonlyMap<string, readonly string[]> {
  const { program } = parseEmittedJavaScript(file, source, "module");
  let table: readonly string[] | undefined;
  const indexLists: { readonly target: string; readonly indices: readonly number[] }[] = [];
  visitAst(program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      (node.id as AstNode).type === "Identifier" &&
      (node.id as AstNode).name === "__vite__mapDeps"
    ) {
      visitAst(node.init, (candidate) => {
        if (table || candidate.type !== "ArrayExpression") return;
        const values = (candidate.elements as unknown[]).map(stringValue);
        if (values.length > 0 && values.every((value) => value !== undefined)) table = values;
      });
      return false;
    }
    if (node.type !== "CallExpression") return;
    const mapDeps = (node.arguments as unknown[]).find(isMapDepsCall);
    if (!mapDeps) return;
    const targets: string[] = [];
    visitAst((node.arguments as unknown[])[0], (candidate) => {
      if (candidate.type !== "ImportExpression") return;
      const target = stringValue(candidate.source);
      if (target) targets.push(target);
    });
    const [indexArray] = mapDeps.arguments as AstNode[];
    const indices = (indexArray?.elements as AstNode[] | undefined)?.map(
      (element) => element.value,
    );
    if (targets.length !== 1 || !indices?.every((index) => typeof index === "number")) {
      throw new Error(`${file} has a preload dependency list without exactly one import target`);
    }
    indexLists.push({ target: targets[0] as string, indices: indices as number[] });
  });
  if (indexLists.length > 0 && !table) {
    throw new Error(`${file} uses preload dependency lists without a dependency table`);
  }
  return new Map(
    indexLists.map(({ target, indices }) => [
      target,
      indices.map((index) => {
        const dependency = table?.[index];
        if (dependency === undefined) {
          throw new Error(`${file} preloads missing dependency index ${index} for ${target}`);
        }
        return dependency;
      }),
    ]),
  );
}

const FUNCTION_NODE_TYPES = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/** Literal `require` calls a CommonJS chunk runs while it loads, outside every function body. */
export function eagerRequireSpecifiers(file: string, source: string): readonly string[] {
  const { program } = parseEmittedJavaScript(file, source, "commonjs");
  const specifiers = new Set<string>();
  visitAst(program, (node) => {
    if (FUNCTION_NODE_TYPES.has(node.type)) return false;
    if (node.type !== "CallExpression") return;
    const callee = node.callee as AstNode;
    const [specifier, ...rest] = node.arguments as unknown[];
    const value = stringValue(specifier);
    if (callee.type === "Identifier" && callee.name === "require" && value && rest.length === 0) {
      specifiers.add(value);
    }
  });
  return [...specifiers];
}

/** Resolve a relative specifier emitted into `importer` to an output path. */
export function resolveEmittedSpecifier(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
  return path.resolve(path.dirname(importer), specifier);
}

export interface StaticClosure {
  /** Files in breadth-first order from the roots. */
  readonly files: readonly string[];
  /** The shortest static import path from a root to `file`. */
  chain(file: string): readonly string[];
}

export function staticClosure(
  roots: readonly string[],
  importsOf: (file: string) => readonly string[],
): StaticClosure {
  const parents = new Map<string, string | null>(roots.map((root) => [root, null]));
  const files = [...roots];
  for (const file of files) {
    for (const dependency of importsOf(file)) {
      if (parents.has(dependency)) continue;
      parents.set(dependency, file);
      files.push(dependency);
    }
  }
  return {
    files,
    chain(file) {
      const chain: string[] = [];
      for (let current: string | null | undefined = file; current; current = parents.get(current)) {
        chain.unshift(current);
      }
      return chain;
    },
  };
}
