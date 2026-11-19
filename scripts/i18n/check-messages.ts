/**
 * Verifies the display-language catalogs against the messages declared in source.
 *
 *   vp run i18n:check                      full check (CI)
 *   vp run i18n:check -- --write           also sort the catalog and drop unused entries
 *   vp run i18n:check -- --scope <path>    only require translations for messages under <path>
 *   vp run i18n:check -- --catalog <file>  merge an extra catalog file before checking
 *   vp run i18n:check -- --missing         print untranslated messages as a JSON object
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, TYPE, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { parseSync } from "oxc-parser";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE_ROOT = path.join(ROOT, "src");
const CATALOG_PATHS = { "zh-CN": path.join(ROOT, "src/shared/i18n/catalogs/zh-CN.json") } as const;

export interface SourceMessage {
  readonly id: string;
  readonly defaultMessage: string;
  readonly file: string;
  readonly line: number;
}

export interface Problem {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

const EXCLUDED_FILE =
  /(\.(test|spec|bench)\.[cm]?tsx?$|\.d\.ts$|test-fixtures|test-support|\.stories\.)/;
const EXCLUDED_DIR = new Set(["node_modules", "generated", "__screenshots__", "test"]);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIR.has(entry.name)) yield* sourceFiles(full);
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !EXCLUDED_FILE.test(entry.name)) {
      yield full;
    }
  }
}

type Node = { type: string; start: number; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && typeof (value as Node).type === "string";
}

/** A literal string, or a template literal without substitutions. */
function staticString(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    const expressions = node.expressions as unknown[];
    const quasis = node.quasis as { value: { cooked: string } }[];
    if (expressions.length === 0 && quasis.length === 1) return quasis[0]!.value.cooked;
  }
  if (node.type === "JSXExpressionContainer") return staticString(node.expression);
  if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression") {
    return staticString(node.expression);
  }
  return null;
}

function propertyName(node: Node): string | null {
  const key = node.key as Node | undefined;
  if (!key || node.computed) return null;
  if (key.type === "Identifier") return key.name as string;
  return staticString(key);
}

function isForwarded(value: unknown): boolean {
  return isNode(value) && (value.type === "Identifier" || value.type === "MemberExpression");
}

export function extractMessages(
  file: string,
  source: string,
): {
  messages: SourceMessage[];
  problems: Problem[];
} {
  const relative = path.relative(ROOT, file);
  const lineOf = (offset: number): number => source.slice(0, offset).split("\n").length;
  const messages: SourceMessage[] = [];
  const problems: Problem[] = [];
  if (!source.includes("defaultMessage")) return { messages, problems };
  const result = parseSync(file, source, { sourceType: "module" });
  if (result.errors.length > 0) {
    problems.push({
      file: relative,
      line: 1,
      message: `could not parse: ${result.errors[0]!.message}`,
    });
    return { messages, problems };
  }

  const record = (idNode: unknown, messageNode: unknown, at: number): void => {
    const id = staticString(idNode);
    const defaultMessage = staticString(messageNode);
    if (id === null || defaultMessage === null) {
      problems.push({
        file: relative,
        line: lineOf(at),
        message: "message `id` and `defaultMessage` must be string literals",
      });
      return;
    }
    messages.push({ id, defaultMessage, file: relative, line: lineOf(at) });
  };

  // A local formatter can forward two literal arguments into the ordinary descriptor shape.
  const forwardingScope = (node: Node): string[] => {
    if (node.type !== "Program" && node.type !== "BlockStatement") return [];
    return (node.body as Node[]).flatMap((statement) => {
      if (statement.type !== "VariableDeclaration" || statement.kind !== "const") return [];
      return (statement.declarations as Node[]).flatMap(({ id, init }) => {
        if (
          !isNode(id) ||
          id.type !== "Identifier" ||
          !isNode(init) ||
          init.type !== "ArrowFunctionExpression"
        )
          return [];
        const params = init.params as Node[];
        const call = init.body;
        if (
          params.length !== 2 ||
          !isNode(call) ||
          call.type !== "CallExpression" ||
          !isNode(call.callee) ||
          call.callee.type !== "MemberExpression" ||
          !isNode(call.callee.property) ||
          call.callee.property.name !== "formatMessage"
        )
          return [];
        const [descriptor] = call.arguments as Node[];
        if (descriptor?.type !== "ObjectExpression") return [];
        const properties = descriptor.properties as Node[];
        const passesParameter = (property: string, index: number) => {
          const value = properties.find((candidate) => propertyName(candidate) === property)?.value;
          return (
            isNode(value) &&
            value.type === "Identifier" &&
            params[index]?.type === "Identifier" &&
            value.name === params[index].name
          );
        };
        return passesParameter("id", 0) && passesParameter("defaultMessage", 1)
          ? [id.name as string]
          : [];
      });
    });
  };

  const visit = (node: unknown, inheritedFormatters: readonly string[]): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inheritedFormatters);
      return;
    }
    if (!isNode(node)) return;
    const localFormatters = forwardingScope(node);
    const formatters = localFormatters.length
      ? [...inheritedFormatters, ...localFormatters]
      : inheritedFormatters;
    if (
      node.type === "CallExpression" &&
      isNode(node.callee) &&
      node.callee.type === "Identifier" &&
      formatters.includes(node.callee.name as string)
    ) {
      const [id, message] = node.arguments as Node[];
      record(id, message, node.start);
    }
    if (node.type === "ObjectExpression") {
      const properties = (node.properties as Node[]).filter((p) => p.type === "Property");
      const message = properties.find((p) => propertyName(p) === "defaultMessage");
      // `{ id, defaultMessage }` built from identifiers forwards a descriptor declared elsewhere.
      if (message && !isForwarded(message.value)) {
        const id = properties.find((p) => propertyName(p) === "id");
        record(id?.value, message.value, node.start);
      }
    } else if (node.type === "JSXOpeningElement") {
      const name = node.name as Node;
      if (name.type === "JSXIdentifier" && name.name === "FormattedMessage") {
        const attributes = (node.attributes as Node[]).filter((a) => a.type === "JSXAttribute");
        const attribute = (key: string) =>
          attributes.find((a) => (a.name as Node).name === key)?.value;
        if ((node.attributes as Node[]).some((a) => a.type === "JSXSpreadAttribute")) {
          // `<FormattedMessage {...messages.x} />` reuses a descriptor checked where it is defined.
        } else {
          record(attribute("id"), attribute("defaultMessage"), node.start);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "type" && key !== "start" && key !== "end" && typeof value === "object") {
        visit(value, formatters);
      }
    }
  };
  visit(result.program, []);
  return { messages, problems };
}

/** Argument and tag names an ICU message reads, including those nested in plural/select. */
export function messageArguments(elements: MessageFormatElement[]): Set<string> {
  const names = new Set<string>();
  const walk = (list: MessageFormatElement[]): void => {
    for (const element of list) {
      switch (element.type) {
        case TYPE.argument:
        case TYPE.number:
        case TYPE.date:
        case TYPE.time:
          names.add(element.value);
          break;
        case TYPE.plural:
        case TYPE.select:
          names.add(element.value);
          for (const option of Object.values(element.options)) walk(option.value);
          break;
        case TYPE.tag:
          names.add(`<${element.value}>`);
          walk(element.children);
          break;
        default:
          break;
      }
    }
  };
  walk(elements);
  return names;
}

function parseIcu(message: string): MessageFormatElement[] | Error {
  try {
    return parse(message, { requiresOtherClause: true });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function readCatalog(file: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
}

function sortedCatalog(catalog: Record<string, string>): string {
  const sorted = Object.fromEntries(
    Object.entries(catalog).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function parseArgs(argv: readonly string[]) {
  const scopes: string[] = [];
  const catalogs: string[] = [];
  let write = false;
  let missing = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") scopes.push(path.resolve(ROOT, argv[++index] ?? ""));
    else if (arg === "--catalog") catalogs.push(path.resolve(ROOT, argv[++index] ?? ""));
    else if (arg === "--write") write = true;
    else if (arg === "--missing") missing = true;
    else if (arg !== "--") throw new Error(`Unknown argument: ${arg}`);
  }
  return { scopes, catalogs, write, missing };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const problems: Problem[] = [];
  const byId = new Map<string, SourceMessage>();

  for (const file of sourceFiles(SOURCE_ROOT)) {
    const extracted = extractMessages(file, fs.readFileSync(file, "utf8"));
    problems.push(...extracted.problems);
    for (const message of extracted.messages) {
      const existing = byId.get(message.id);
      if (existing && existing.defaultMessage !== message.defaultMessage) {
        problems.push({
          file: message.file,
          line: message.line,
          message: `id "${message.id}" already means "${existing.defaultMessage}" at ${existing.file}:${existing.line}`,
        });
        continue;
      }
      if (!existing) byId.set(message.id, message);
      const parsed = parseIcu(message.defaultMessage);
      if (parsed instanceof Error) {
        problems.push({
          file: message.file,
          line: message.line,
          message: `invalid ICU in "${message.id}": ${parsed.message}`,
        });
      }
    }
  }

  const inScope = (message: SourceMessage): boolean =>
    options.scopes.length === 0 ||
    options.scopes.some((scope) => path.join(ROOT, message.file).startsWith(scope));

  for (const [locale, catalogPath] of Object.entries(CATALOG_PATHS)) {
    const catalog = readCatalog(catalogPath);
    const merged: Record<string, string> = { ...catalog };
    for (const extra of options.catalogs) Object.assign(merged, readCatalog(extra));
    const untranslated: Record<string, string> = {};

    for (const message of byId.values()) {
      if (!inScope(message)) continue;
      const translation = merged[message.id];
      if (translation === undefined) {
        untranslated[message.id] = message.defaultMessage;
        problems.push({
          file: message.file,
          line: message.line,
          message: `missing ${locale} translation for "${message.id}"`,
        });
        continue;
      }
      const source = parseIcu(message.defaultMessage);
      const target = parseIcu(translation);
      if (target instanceof Error) {
        problems.push({
          file: message.file,
          line: message.line,
          message: `invalid ${locale} ICU for "${message.id}": ${target.message}`,
        });
        continue;
      }
      if (source instanceof Error) continue;
      const expected = [...messageArguments(source)].sort().join(", ");
      const actual = [...messageArguments(target)].sort().join(", ");
      if (expected !== actual) {
        problems.push({
          file: message.file,
          line: message.line,
          message: `${locale} "${message.id}" uses {${actual}} but the source uses {${expected}}`,
        });
      }
    }

    if (options.scopes.length === 0) {
      const unused = Object.keys(catalog).filter((id) => !byId.has(id));
      if (options.write) {
        for (const id of unused) delete catalog[id];
      } else {
        for (const id of unused) {
          problems.push({
            file: path.relative(ROOT, catalogPath),
            line: 1,
            message: `unused ${locale} entry "${id}"`,
          });
        }
      }
      const formatted = sortedCatalog(catalog);
      if (options.write) fs.writeFileSync(catalogPath, formatted);
      else if (fs.readFileSync(catalogPath, "utf8") !== formatted) {
        problems.push({
          file: path.relative(ROOT, catalogPath),
          line: 1,
          message: "catalog is not sorted; run `vp run i18n:check -- --write`",
        });
      }
    }

    if (options.missing) process.stdout.write(`${JSON.stringify(untranslated, null, 2)}\n`);
  }

  if (options.missing) return;
  for (const problem of problems)
    console.error(`${problem.file}:${problem.line}: ${problem.message}`);
  const scope =
    options.scopes.length > 0
      ? ` in ${options.scopes.map((s) => path.relative(ROOT, s)).join(", ")}`
      : "";
  if (problems.length > 0) {
    console.error(
      `\ni18n: ${problems.length} problem(s)${scope}; ${byId.size} messages in source.`,
    );
    process.exitCode = 1;
  } else {
    console.log(`i18n: ${byId.size} messages${scope}, every catalog complete.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
