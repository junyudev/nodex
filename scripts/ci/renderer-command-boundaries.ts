import { readFileSync, readdirSync } from "node:fs";
import { extname, posix, relative, resolve } from "node:path";
import { Visitor } from "oxc-parser";

import { parseTypeScriptSource, sourcePosition } from "../lib/oxc-source";

export type RendererCommandHardViolationCode =
  | "main-ipc-handle-registration"
  | "main-ipc-handle-wrapper"
  | "renderer-direct-preload-invoke"
  | "renderer-leaf-raw-invoke-call"
  | "renderer-leaf-raw-invoke-import"
  | "renderer-raw-invoke-call"
  | "renderer-raw-invoke-import"
  | "renderer-raw-transport-call"
  | "renderer-raw-transport-import"
  | "renderer-command-call-requires-definition"
  | "renderer-command-capability-reexport"
  | "renderer-leaf-typed-transport-import";

export type RendererCommandDiagnosticCode = RendererCommandHardViolationCode;

export type RendererCommandInventoryCode =
  | RendererCommandDiagnosticCode
  | "renderer-local-commit-admission";

export interface RendererCommandOccurrence {
  readonly code: RendererCommandInventoryCode;
  readonly column: number;
  readonly detail: string;
  readonly line: number;
  readonly path: string;
}

type RendererCommandDiagnosticOccurrence = RendererCommandOccurrence & {
  readonly code: RendererCommandDiagnosticCode;
};

export interface RendererCommandDiagnostic extends RendererCommandDiagnosticOccurrence {
  readonly code: RendererCommandDiagnosticCode;
  readonly message: string;
}

export interface RendererCommandInventory {
  readonly schemaVersion: 1;
  readonly ipcApiEndpointCount: number;
  readonly ipcApiEndpoints: readonly string[];
  readonly occurrences: readonly RendererCommandOccurrence[];
  readonly occurrenceCounts: Readonly<Record<RendererCommandInventoryCode, number>>;
}

interface SourceInput {
  readonly path: string;
  readonly sourceText: string;
}

interface NodeLike {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

interface FunctionCandidate {
  readonly end: number;
  readonly name: string;
  readonly parameterName: string;
  readonly start: number;
}

const sourceExtensions = new Set([".cts", ".mts", ".ts", ".tsx"]);
const testSourcePattern =
  /\.(?:browser\.|integration\.|jsdom\.|node\.)?(?:spec|test)\.[cm]?[jt]sx?$/u;
const rendererApiPath = "src/renderer/lib/api";
const rendererCommandPath = "src/renderer/lib/renderer-command";
const rendererTransportPath = "src/renderer/lib/renderer-transport";
const commandTransportNames = new Set([
  "invokeLocalCommitCommand",
  "invokeLocalCommitCommandResult",
  "invokePlainCommand",
  "invokePlainCommandWithTrace",
  "invokeRevisionedCommand",
]);
const typedTransportNames = new Set([
  ...commandTransportNames,
  "invokeRendererControl",
  "invokeRendererQuery",
]);
const rendererCommandCapabilityNames = new Set([
  ...typedTransportNames,
  "defineLocalCommitRendererCommand",
  "defineRendererCommand",
]);
const transparentExpressionTypes = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
const emptyCounts = (): Record<RendererCommandInventoryCode, number> => ({
  "main-ipc-handle-registration": 0,
  "main-ipc-handle-wrapper": 0,
  "renderer-direct-preload-invoke": 0,
  "renderer-command-call-requires-definition": 0,
  "renderer-command-capability-reexport": 0,
  "renderer-leaf-raw-invoke-call": 0,
  "renderer-leaf-raw-invoke-import": 0,
  "renderer-leaf-typed-transport-import": 0,
  "renderer-local-commit-admission": 0,
  "renderer-raw-invoke-call": 0,
  "renderer-raw-invoke-import": 0,
  "renderer-raw-transport-call": 0,
  "renderer-raw-transport-import": 0,
});

const normalizeProjectPath = (path: string): string =>
  path.replaceAll("\\", "/").replace(/^\.\//u, "");

const nodeLike = (value: unknown): NodeLike | null => {
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    typeof candidate.type !== "string" ||
    typeof candidate.start !== "number" ||
    typeof candidate.end !== "number"
  ) {
    return null;
  }
  return candidate as unknown as NodeLike;
};

const unwrapExpression = (value: unknown): NodeLike | null => {
  let current = nodeLike(value);
  while (current && transparentExpressionTypes.has(current.type)) {
    current = nodeLike(current.expression);
  }
  return current;
};

const identifierName = (value: unknown): string | null => {
  const node = unwrapExpression(value);
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : null;
};

const memberParts = (
  value: unknown,
): { readonly object: NodeLike; readonly property: string } | null => {
  const node = unwrapExpression(value);
  if (!node || node.type !== "MemberExpression") return null;
  const object = unwrapExpression(node.object);
  const property = identifierName(node.property);
  if (!object || !property) return null;
  return { object, property };
};

const stringLiteral = (value: unknown): string | null => {
  const node = unwrapExpression(value);
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : null;
};

const firstArgument = (call: NodeLike): NodeLike | null => {
  if (!Array.isArray(call.arguments)) return null;
  return nodeLike(call.arguments[0]);
};

const callIdentifier = (call: NodeLike): string | null => identifierName(call.callee);

const callMember = (
  call: NodeLike,
): { readonly object: NodeLike; readonly property: string } | null => memberParts(call.callee);

const isWindowApiInvoke = (call: NodeLike): boolean => {
  const invoked = callMember(call);
  if (!invoked || invoked.property !== "invoke") return false;
  const api = memberParts(invoked.object);
  return Boolean(api && api.property === "api" && identifierName(api.object) === "window");
};

const isMainIpcHandle = (call: NodeLike): boolean => {
  const member = callMember(call);
  return Boolean(member && member.property === "handle" && identifierName(member.object) === "ipc");
};

const resolveRendererImport = (fromPath: string, moduleName: string): string | null => {
  if (moduleName.startsWith("@/")) return `src/renderer/${moduleName.slice(2)}`;
  if (!moduleName.startsWith(".")) return null;
  const normalized = posix.normalize(posix.join(posix.dirname(fromPath), moduleName));
  return normalized.replace(/\.(?:[cm]?[jt]sx?)$/u, "");
};

const importedName = (specifier: NodeLike): string | null => {
  if (specifier.type !== "ImportSpecifier") return null;
  const imported = nodeLike(specifier.imported);
  if (!imported) return null;
  if (imported.type === "Identifier" && typeof imported.name === "string") return imported.name;
  return imported.type === "Literal" && typeof imported.value === "string" ? imported.value : null;
};

/** Presentation is a source property, not a directory convention. */
const isRendererPresentationModule = (
  path: string,
  program: Parameters<Visitor["visit"]>[0],
): boolean => {
  if (path.endsWith(".tsx")) return true;
  let containsJsx = false;
  new Visitor({
    JSXElement() {
      containsJsx = true;
    },
    JSXFragment() {
      containsJsx = true;
    },
  }).visit(program);
  return containsJsx;
};

const occurrence = (
  input: SourceInput,
  code: RendererCommandInventoryCode,
  offset: number,
  detail: string,
): RendererCommandOccurrence => {
  const { line, column } = sourcePosition(input.sourceText, offset);
  return { code, column, detail, line, path: input.path };
};

const sortedOccurrences = <Occurrence extends RendererCommandOccurrence>(
  values: readonly Occurrence[],
): readonly Occurrence[] =>
  [...values].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.code.localeCompare(right.code) ||
      left.detail.localeCompare(right.detail),
  );

const functionCandidates = (program: Parameters<Visitor["visit"]>[0]): FunctionCandidate[] => {
  const candidates: FunctionCandidate[] = [];
  new Visitor({
    FunctionDeclaration(node) {
      const raw = node as unknown as NodeLike;
      const name = identifierName(raw.id);
      const parameters = Array.isArray(raw.params) ? raw.params : [];
      const parameterName = identifierName(parameters[0]);
      if (!name || !parameterName) return;
      candidates.push({ end: raw.end, name, parameterName, start: raw.start });
    },
    VariableDeclarator(node) {
      const raw = node as unknown as NodeLike;
      const name = identifierName(raw.id);
      const initializer = unwrapExpression(raw.init);
      if (
        !name ||
        !initializer ||
        (initializer.type !== "ArrowFunctionExpression" &&
          initializer.type !== "FunctionExpression")
      ) {
        return;
      }
      const parameters = Array.isArray(initializer.params) ? initializer.params : [];
      const parameterName = identifierName(parameters[0]);
      if (!parameterName) return;
      candidates.push({
        end: initializer.end,
        name,
        parameterName,
        start: initializer.start,
      });
    },
  }).visit(program);
  return candidates;
};

const callsIn = (calls: readonly NodeLike[], candidate: FunctionCandidate): readonly NodeLike[] =>
  calls.filter((call) => call.start >= candidate.start && call.end <= candidate.end);

const discoverIpcHandleWrappers = (
  candidates: readonly FunctionCandidate[],
  calls: readonly NodeLike[],
): ReadonlySet<string> => {
  const wrappers = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of candidates) {
      if (wrappers.has(candidate.name)) continue;
      const forwardsChannel = callsIn(calls, candidate).some((call) => {
        if (identifierName(firstArgument(call)) !== candidate.parameterName) return false;
        if (isMainIpcHandle(call)) return true;
        const called = callIdentifier(call);
        return called !== null && wrappers.has(called);
      });
      if (!forwardsChannel) continue;
      wrappers.add(candidate.name);
      changed = true;
    }
  }
  return wrappers;
};

const containingForwardingWrapper = (
  call: NodeLike,
  candidates: readonly FunctionCandidate[],
  wrappers: ReadonlySet<string>,
): FunctionCandidate | null =>
  candidates.find(
    (candidate) =>
      wrappers.has(candidate.name) &&
      call.start >= candidate.start &&
      call.end <= candidate.end &&
      identifierName(firstArgument(call)) === candidate.parameterName,
  ) ?? null;

const callChannelDetail = (call: NodeLike): string => {
  const argument = firstArgument(call);
  const literal = stringLiteral(argument);
  if (literal) return literal;
  const identifier = identifierName(argument);
  return identifier ? `<identifier:${identifier}>` : "<dynamic>";
};

export const analyzeRendererSource = (input: SourceInput): readonly RendererCommandOccurrence[] => {
  const path = normalizeProjectPath(input.path);
  const normalizedInput = { ...input, path };
  const program = parseTypeScriptSource(path, input.sourceText);
  const importedRawInvokeBindings = new Set<string>();
  const importedRawTransportResolvers = new Set<string>();
  const importedAdmissionFunctions = new Set<string>();
  const importedIngressObjects = new Set<string>();
  const importedCommandTransports = new Map<string, string>();
  const importedRendererCommandCapabilities = new Set<string>();
  const importedRendererCommandNamespaces = new Set<string>();
  const results: RendererCommandOccurrence[] = [];
  const presentation = isRendererPresentationModule(path, program);

  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const moduleName = statement.source.value;
    const resolvedModule = resolveRendererImport(path, moduleName);
    for (const rawSpecifier of statement.specifiers) {
      const specifier = rawSpecifier as unknown as NodeLike;
      const imported = importedName(specifier);
      const local = identifierName(specifier.local);
      if (!local) continue;
      const typeOnly = statement.importKind === "type" || specifier.importKind === "type";
      if (resolvedModule === rendererCommandPath && !typeOnly) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          importedRendererCommandNamespaces.add(local);
          importedRendererCommandCapabilities.add(local);
          if (presentation) {
            results.push(
              occurrence(
                normalizedInput,
                "renderer-leaf-typed-transport-import",
                specifier.start,
                local,
              ),
            );
          }
        } else if (imported) {
          if (typedTransportNames.has(imported)) importedCommandTransports.set(local, imported);
          if (rendererCommandCapabilityNames.has(imported)) {
            importedRendererCommandCapabilities.add(local);
          }
          if (presentation && rendererCommandCapabilityNames.has(imported)) {
            results.push(
              occurrence(
                normalizedInput,
                "renderer-leaf-typed-transport-import",
                specifier.start,
                imported,
              ),
            );
          }
        }
      }
      if (!imported) continue;
      if (resolvedModule === rendererTransportPath && imported === "resolveInvokeTransport") {
        importedRawTransportResolvers.add(local);
        results.push(
          occurrence(normalizedInput, "renderer-raw-transport-import", specifier.start, local),
        );
      }
      if (resolvedModule === rendererApiPath && imported === "invoke") {
        importedRawInvokeBindings.add(local);
        results.push(
          occurrence(
            normalizedInput,
            presentation ? "renderer-leaf-raw-invoke-import" : "renderer-raw-invoke-import",
            specifier.start,
            local,
          ),
        );
      }
      if (!moduleName.endsWith("local-commit-ingress")) continue;
      if (imported === "admitLocalCommitApply") importedAdmissionFunctions.add(local);
      if (imported === "rendererLocalCommitIngress") importedIngressObjects.add(local);
    }
  }

  for (const rawStatement of program.body) {
    const statement = rawStatement as unknown as NodeLike;
    if (statement.type !== "ExportNamedDeclaration" && statement.type !== "ExportAllDeclaration") {
      continue;
    }
    if (statement.exportKind === "type") continue;
    const specifiers = Array.isArray(statement.specifiers) ? statement.specifiers : [];
    if (
      statement.type === "ExportNamedDeclaration" &&
      specifiers.length > 0 &&
      specifiers.every((value) => nodeLike(value)?.exportKind === "type")
    ) {
      continue;
    }
    const moduleName = stringLiteral(statement.source);
    const directCapabilityExport =
      moduleName !== null && resolveRendererImport(path, moduleName) === rendererCommandPath;
    const importedCapabilityExport =
      moduleName === null &&
      specifiers.some((value) => {
        const specifier = nodeLike(value);
        if (!specifier || specifier.exportKind === "type") return false;
        const local = identifierName(specifier.local);
        return local !== null && importedRendererCommandCapabilities.has(local);
      });
    if (!directCapabilityExport && !importedCapabilityExport) continue;
    results.push(
      occurrence(
        normalizedInput,
        "renderer-command-capability-reexport",
        statement.start,
        moduleName ?? "<imported-capability>",
      ),
    );
  }

  new Visitor({
    ImportExpression(node) {
      const expression = node as unknown as NodeLike;
      const moduleName = stringLiteral(expression.source);
      if (
        !presentation ||
        moduleName === null ||
        resolveRendererImport(path, moduleName) !== rendererCommandPath
      ) {
        return;
      }
      results.push(
        occurrence(
          normalizedInput,
          "renderer-leaf-typed-transport-import",
          expression.start,
          "import()",
        ),
      );
    },
    CallExpression(node) {
      const call = node as unknown as NodeLike;
      const called = callIdentifier(call);
      const calledMember = callMember(call);
      const namespace = calledMember ? identifierName(calledMember.object) : null;
      const importedTransport = called
        ? importedCommandTransports.get(called)
        : namespace && importedRendererCommandNamespaces.has(namespace)
          ? calledMember?.property
          : undefined;
      if (importedTransport && commandTransportNames.has(importedTransport)) {
        const definition = firstArgument(call);
        if (identifierName(definition) === null) {
          results.push(
            occurrence(
              normalizedInput,
              "renderer-command-call-requires-definition",
              definition?.start ?? call.start,
              importedTransport,
            ),
          );
        }
      }
      if (called && importedRawInvokeBindings.has(called)) {
        results.push(
          occurrence(
            normalizedInput,
            presentation ? "renderer-leaf-raw-invoke-call" : "renderer-raw-invoke-call",
            call.start,
            stringLiteral(firstArgument(call)) ?? "<dynamic>",
          ),
        );
      }
      if (called && importedRawTransportResolvers.has(called)) {
        results.push(
          occurrence(normalizedInput, "renderer-raw-transport-call", call.start, called),
        );
      }
      if (isWindowApiInvoke(call)) {
        results.push(
          occurrence(
            normalizedInput,
            "renderer-direct-preload-invoke",
            call.start,
            stringLiteral(firstArgument(call)) ?? "<dynamic>",
          ),
        );
      }
      if (called && importedAdmissionFunctions.has(called)) {
        results.push(
          occurrence(
            normalizedInput,
            "renderer-local-commit-admission",
            call.start,
            "admitLocalCommitApply",
          ),
        );
        return;
      }
      const member = callMember(call);
      const ingressObject = member ? identifierName(member.object) : null;
      if (
        !member ||
        (!importedIngressObjects.has(ingressObject ?? "") &&
          ingressObject !== "rendererLocalCommitIngress") ||
        (member.property !== "admitApply" && member.property !== "admitPacket")
      ) {
        return;
      }
      results.push(
        occurrence(normalizedInput, "renderer-local-commit-admission", call.start, member.property),
      );
    },
  }).visit(program);

  return sortedOccurrences(results);
};

export const analyzeMainIpcSource = (input: SourceInput): readonly RendererCommandOccurrence[] => {
  const path = normalizeProjectPath(input.path);
  const normalizedInput = { ...input, path };
  const program = parseTypeScriptSource(path, input.sourceText);
  const calls: NodeLike[] = [];
  new Visitor({
    CallExpression(node) {
      calls.push(node as unknown as NodeLike);
    },
  }).visit(program);
  const candidates = functionCandidates(program);
  const wrappers = discoverIpcHandleWrappers(candidates, calls);
  const results: RendererCommandOccurrence[] = [];

  for (const call of calls) {
    if (isMainIpcHandle(call)) {
      const wrapper = containingForwardingWrapper(call, candidates, wrappers);
      results.push(
        occurrence(
          normalizedInput,
          wrapper ? "main-ipc-handle-wrapper" : "main-ipc-handle-registration",
          call.start,
          wrapper?.parameterName ?? callChannelDetail(call),
        ),
      );
      continue;
    }
    if (!wrappers.has(callIdentifier(call) ?? "")) continue;
    if (containingForwardingWrapper(call, candidates, wrappers)) continue;
    results.push(
      occurrence(
        normalizedInput,
        "main-ipc-handle-registration",
        call.start,
        callChannelDetail(call),
      ),
    );
  }

  return sortedOccurrences(results);
};

export const collectIpcApiEndpoints = (input: SourceInput): readonly string[] => {
  const path = normalizeProjectPath(input.path);
  const program = parseTypeScriptSource(path, input.sourceText);
  for (const rawStatement of program.body) {
    const statement = rawStatement as unknown as NodeLike;
    const declaration =
      statement.type === "ExportNamedDeclaration" ? nodeLike(statement.declaration) : statement;
    if (!declaration || declaration.type !== "TSInterfaceDeclaration") continue;
    if (identifierName(declaration.id) !== "IpcApi") continue;
    const body = nodeLike(declaration.body);
    const members = body && Array.isArray(body.body) ? body.body : [];
    return members
      .flatMap((member): readonly string[] => {
        const key = nodeLike(member)?.key;
        const value = stringLiteral(key);
        return value ? [value] : [];
      })
      .sort((left, right) => left.localeCompare(right));
  }
  throw new Error(`${path} does not declare IpcApi`);
};

const listSourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    if (!entry.isFile() || !sourceExtensions.has(extname(path))) return [];
    return [path];
  });

const isProductionSource = (path: string): boolean =>
  !testSourcePattern.test(path) && !path.endsWith(".stories.ts") && !path.endsWith(".stories.tsx");

export const collectRendererCommandInventory = (projectRoot: string): RendererCommandInventory => {
  const rendererRoot = resolve(projectRoot, "src/renderer");
  const mainIpcRoot = resolve(projectRoot, "src/main/ipc/handlers");
  const rendererOccurrences = listSourceFiles(rendererRoot)
    .filter(isProductionSource)
    .flatMap((absolutePath) =>
      analyzeRendererSource({
        path: relative(projectRoot, absolutePath),
        sourceText: readFileSync(absolutePath, "utf8"),
      }),
    );
  const mainOccurrences = listSourceFiles(mainIpcRoot)
    .filter(isProductionSource)
    .flatMap((absolutePath) =>
      analyzeMainIpcSource({
        path: relative(projectRoot, absolutePath),
        sourceText: readFileSync(absolutePath, "utf8"),
      }),
    );
  const occurrences = sortedOccurrences([...rendererOccurrences, ...mainOccurrences]);
  const endpoints = collectIpcApiEndpoints({
    path: "src/shared/ipc-api.ts",
    sourceText: readFileSync(resolve(projectRoot, "src/shared/ipc-api.ts"), "utf8"),
  });
  const occurrenceCounts = emptyCounts();
  for (const value of occurrences) occurrenceCounts[value.code] += 1;
  return {
    schemaVersion: 1,
    ipcApiEndpointCount: endpoints.length,
    ipcApiEndpoints: endpoints,
    occurrences,
    occurrenceCounts,
  };
};

const rendererCommandHardViolationCodes = new Set<RendererCommandInventoryCode>([
  "main-ipc-handle-registration",
  "main-ipc-handle-wrapper",
  "renderer-direct-preload-invoke",
  "renderer-command-capability-reexport",
  "renderer-leaf-raw-invoke-call",
  "renderer-leaf-raw-invoke-import",
  "renderer-raw-invoke-call",
  "renderer-raw-invoke-import",
  "renderer-raw-transport-call",
  "renderer-raw-transport-import",
  "renderer-command-call-requires-definition",
  "renderer-leaf-typed-transport-import",
]);

const isRendererCommandHardViolation = (
  value: RendererCommandOccurrence,
): value is RendererCommandOccurrence & { readonly code: RendererCommandHardViolationCode } =>
  rendererCommandHardViolationCodes.has(value.code);

export const rendererCommandBoundaryDiagnostics = (
  inventory: Pick<RendererCommandInventory, "occurrences">,
): readonly RendererCommandDiagnostic[] => {
  const diagnostics = inventory.occurrences.flatMap(
    (value): readonly RendererCommandDiagnostic[] => {
      if (!isRendererCommandHardViolation(value)) return [];
      const message =
        value.code === "main-ipc-handle-registration" || value.code === "main-ipc-handle-wrapper"
          ? `${value.detail} registers Main IPC through the unrestricted raw handle seam; select a typed ElectronIpc registration lane.`
          : value.code === "renderer-leaf-typed-transport-import"
            ? `${value.detail} imports renderer transport capability from a React presentation Module.`
            : value.code === "renderer-command-capability-reexport"
              ? `${value.detail} re-exports renderer transport capability instead of a semantic owner Interface.`
              : value.code === "renderer-command-call-requires-definition"
                ? `${value.detail} must receive a registered command-definition identifier as its first argument.`
                : value.code === "renderer-direct-preload-invoke"
                  ? `${value.detail} invokes the preload bridge directly; route it through a classified renderer owner.`
                  : `${value.detail} uses the removed raw renderer invoke path; route it through a classified renderer owner.`;
      return [{ ...value, message }];
    },
  );
  return sortedOccurrences(diagnostics);
};

export const rendererCommandInventoryReport = (inventory: RendererCommandInventory): string =>
  `${JSON.stringify(
    {
      schemaVersion: inventory.schemaVersion,
      ipcApiEndpointCount: inventory.ipcApiEndpointCount,
      ipcApiEndpoints: inventory.ipcApiEndpoints,
      occurrenceCounts: inventory.occurrenceCounts,
      occurrenceDetails: inventory.occurrences.map(({ code, detail, path }) => ({
        code,
        detail,
        path,
      })),
    },
    null,
    2,
  )}\n`;
