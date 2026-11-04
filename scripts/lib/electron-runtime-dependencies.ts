import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { parseSync, Visitor, type Argument, type Expression } from "oxc-parser";

function literalSpecifier(node: Argument | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null;
  return null;
}

function memberName(node: Expression): string | null {
  if (node.type !== "MemberExpression") return null;
  if (node.computed) return literalSpecifier(node.property);
  return node.property.type === "Identifier" ? node.property.name : null;
}

/** Rolldown emits (0, namespace.createRequire)(…) in CommonJS. */
function isCreateRequire(node: Expression | undefined, factories: ReadonlySet<string>): boolean {
  const callee = node?.type === "SequenceExpression" ? node.expressions.at(-1) : node;
  if (!callee) return false;
  if (callee.type === "Identifier") return factories.has(callee.name);
  return memberName(callee) === "createRequire";
}

function runtimeSpecifiers(filename: string, source: string): Set<string> {
  const parsed = parseSync(filename, source, {
    lang: "js",
    preserveParens: false,
    sourceType: "unambiguous",
  });
  if (parsed.errors.length > 0)
    throw new Error(`Unable to inspect ${filename}: ${parsed.errors[0]?.message}`);

  const specifiers = new Set<string>();
  const factories = new Set(["createRequire"]);
  const requireNames = new Set(["require", "__require"]);
  const possibleAliases: { name: string; initializer: Expression }[] = [];
  const calls: { callee: Expression; specifier: string }[] = [];

  const addSpecifier = (node: Argument | undefined) => {
    const specifier = literalSpecifier(node);
    if (specifier !== null) specifiers.add(specifier);
  };
  new Visitor({
    ImportDeclaration(node) {
      addSpecifier(node.source);
      if (node.source.value !== "node:module" && node.source.value !== "module") return;
      for (const specifier of node.specifiers) {
        if (specifier.type !== "ImportSpecifier") continue;
        if (specifier.imported.type === "Identifier" && specifier.imported.name === "createRequire")
          factories.add(specifier.local.name);
      }
    },
    ExportNamedDeclaration(node) {
      addSpecifier(node.source ?? undefined);
    },
    ExportAllDeclaration(node) {
      addSpecifier(node.source);
    },
    ImportExpression(node) {
      addSpecifier(node.source);
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && node.init?.type === "CallExpression")
        possibleAliases.push({ name: node.id.name, initializer: node.init.callee });
    },
    CallExpression(node) {
      const specifier = literalSpecifier(node.arguments[0]);
      if (specifier !== null) calls.push({ callee: node.callee, specifier });
    },
  }).visit(parsed.program);

  for (const { name, initializer } of possibleAliases) {
    if (isCreateRequire(initializer, factories)) requireNames.add(name);
  }
  const isRequire = (callee: Expression) =>
    (callee.type === "Identifier" && requireNames.has(callee.name)) ||
    (callee.type === "CallExpression" && isCreateRequire(callee.callee, factories)) ||
    (callee.type === "MemberExpression" &&
      callee.object.type === "Identifier" &&
      callee.object.name === "module" &&
      memberName(callee) === "require");
  for (const { callee, specifier } of calls) {
    if (
      isRequire(callee) ||
      (callee.type === "MemberExpression" &&
        memberName(callee) === "resolve" &&
        isRequire(callee.object))
    )
      specifiers.add(specifier);
  }
  return specifiers;
}

/** Match literal package loads in the prepared Main and preload output, including workers. */
export function assertElectronRuntimeDependencies(root: string, outputs: readonly string[]): void {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  const used = new Set<string>();
  const problems = [];
  for (const filename of outputs) {
    if (!/^out\/(?:main|preload)\/.*\.[cm]?js$/u.test(filename)) continue;
    for (const specifier of runtimeSpecifiers(
      filename,
      readFileSync(path.join(root, filename), "utf8"),
    )) {
      if (isBuiltin(specifier) || specifier === "electron") continue;
      if (
        /^(?:\.{1,2}(?:[\\/]|$)|file:|data:)/u.test(specifier) ||
        path.win32.isAbsolute(specifier)
      )
        continue;
      const packageName = specifier
        .split("/")
        .slice(0, specifier.startsWith("@") ? 2 : 1)
        .join("/");
      if (declared.has(packageName)) used.add(packageName);
      else
        problems.push(`${filename} loads undeclared runtime package ${JSON.stringify(specifier)}`);
    }
  }
  const unused = [...declared].filter((name) => !used.has(name));
  if (unused.length > 0)
    problems.push(`Electron runtime dependencies are unused: ${unused.join(", ")}`);
  if (problems.length > 0) throw new Error(problems.join("\n"));
}
